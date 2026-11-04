import type { GithubDeployment } from "../github-deployments/github-api";
import { parsePinnedImage } from "../github-deployments/payload";
import {
	type Classified,
	connectionKey,
	describeError,
	handleFresh,
	MAX_START_ATTEMPTS,
	type PollDeps,
	postStatus,
	prepareTick,
	STATUS_TEXT,
	selectNewDeployments,
	type TickInput,
	WATCH_ERROR_BACKOFF_MS,
	type WatchRow,
	watchKey,
} from "../github-deployments/poll-core";
import {
	type AcceptanceResult,
	type AcceptedRelease,
	acceptRelease,
	type ConnectionFacts,
} from "./acceptance";
import type { ActionsApi } from "./actions-api";
import { checkReleaseComplete } from "./completeness";
import { describeGateDecision, type GateDecision } from "./deploy-gate";
import type { GateGithub } from "./deploy-gate-github";
import {
	type DeployGateStore,
	type GateConnection,
	type GateRelease,
	runDeployGate,
} from "./deploy-gate-step";
import { type ProcessedEntry, wasProcessed } from "./processed";
import type { RegistryProbe } from "./registry-probe";
import type { ConnectionEvent } from "./state-machine";
import { parseDeploymentTask, parseWakePayload } from "./wake-payload";

/**
 * One tick of a watch that a gha_connection owns. The shared start of a tick
 * (gates, the deployment on its way, the list, the baseline) and the shared
 * end (answer every new deployment) are poll-core's `prepareTick` and
 * `handleFresh`. What is specific lives here, in two steps:
 *
 *   1. discover: which of the new GitHub Deployments are wake-ups for this
 *      service, and is the run behind each one a release Dokploy accepts
 *      (acceptance.ts)? An accepted `pull` release is written to gha_release
 *      (status accepted) and remembered in `processed`; nothing else happens
 *      to it in this step. A `push` release is only verified and recorded.
 *   2. settle: every tick, whatever the list said, the newest accepted release
 *      that has not been deployed goes through the deploy gate (T-13720). Only
 *      `{state:"deploy"}` starts it, and only when the connection is not
 *      Blocked for a reason that is not the gate's.
 *
 * Everything that touches the database, the queue or GitHub is behind
 * `ConnectionPollDeps`, so the order of these steps is unit tested.
 */

/** At most this many runs are verified per tick and repository; the rest wait for the next tick. */
export const MAX_VERIFICATIONS_PER_TICK = 5;
/** A refusal that GitHub-side changes can clear is asked again no sooner than this. */
export const RECHECK_BACKOFF_MS = 5 * 60 * 1000;
/** A (run, attempt) that keeps being refused for a fixable reason is given up after this long. */
export const RECHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A failed backup before the first release is tried again no sooner than this. */
export const BACKUP_RETRY_MS = 2 * 60 * 1000;

export interface ConnectionRecord {
	connectionId: string;
	organizationId: string;
	/** When the connection was made (epoch ms): a wake-up created after it is never skipped by the first baseline. */
	createdAt: number;
	/** Everything acceptance needs, including what the service runs now. */
	facts: ConnectionFacts;
	processed: ProcessedEntry[];
	/**
	 * What the deploy gate needs: the connection's own state, `gateBlocked`,
	 * `gateVersion` (an evaluation that read an older one is discarded),
	 * `repoFullName`, `gateStartedAt` and the settings. Read together with the rest of the row.
	 */
	gate: GateConnection;
}

/** A release Dokploy accepted and has not deployed (a gha_release row in status accepted). */
export interface PendingRelease {
	releaseId: string;
	manifestReleaseId: string;
	sha: string;
	runId: number;
	runAttempt: number;
	delivery: "pull" | "push";
	githubDeploymentId: number | null;
	images: Array<{ name: string; composeService: string; ref: string }>;
	createdAt: Date;
	gateState: GateRelease["gateState"];
	gateExpected: GateRelease["gateExpected"];
	gateCheckedAt: Date | null;
}

export interface ConnectionPollDeps extends PollDeps {
	/** The connection that owns this watch, with the gate's inputs. */
	loadConnection: (watch: WatchRow) => Promise<ConnectionRecord | null>;
	/** Accepted releases of the connection that were not deployed, superseded or failed. */
	loadPendingReleases: (connectionId: string) => Promise<PendingRelease[]>;
	createApi: (token: string, record: ConnectionRecord) => ActionsApi;
	/** The registry reader of an organization (it uses that organization's registry logins). */
	createProbe: (organizationId: string) => RegistryProbe;
	/** The GitHub reads of the deploy gate, bound to this repository and token. */
	createGateGithub: (token: string, record: ConnectionRecord) => GateGithub;
	/** Where the gate writes its outcome (dbDeployGateStore in production). */
	gateStore: DeployGateStore;
	/**
	 * Called for every run Dokploy is about to verify; false means this repository has used its
	 * verifications for the tick. The budget belongs to the REPOSITORY, not the connection: several
	 * services can follow one repository. Absent: MAX_VERIFICATIONS_PER_TICK per connection.
	 */
	takeVerification?: (repoId: number) => boolean;
	/**
	 * Before the first release of a connection changes the service: a fresh backup of what the
	 * change could harm. ok false holds the release (it is tried again later) and the note is shown.
	 */
	preFlipBackup?: (
		watch: WatchRow,
		record: ConnectionRecord,
	) => Promise<{ ok: boolean; note: string }>;
	/** Test seams; production uses acceptRelease and runDeployGate. */
	accept?: typeof acceptRelease;
	runGate?: typeof runDeployGate;
	recordProcessed: (
		connectionId: string,
		entries: ProcessedEntry[],
	) => Promise<void>;
	applyEvent: (
		connectionId: string,
		event: ConnectionEvent,
		note?: string | null,
	) => Promise<void>;
	/** A pull release was accepted: keep it (status accepted) until the gate lets it go. */
	recordAccepted: (
		connectionId: string,
		release: AcceptedRelease,
		githubDeploymentId: number,
	) => Promise<void>;
	/** A newer release replaced these accepted ones: they will never be deployed. */
	supersedeReleases: (
		connectionId: string,
		releaseIds: string[],
	) => Promise<void>;
	/** A release that could not be started (rejected, or the queue refused it three times). */
	failRelease: (connectionId: string, releaseId: string) => Promise<void>;
	/** A `push` release was verified: advance the deployed commit and keep the history row. */
	recordVerifiedPush: (
		connectionId: string,
		release: AcceptedRelease,
		githubDeploymentId: number,
	) => Promise<void>;
	/** A `pull` release matched what already runs: history row only. */
	recordNoop: (
		connectionId: string,
		release: AcceptedRelease,
		githubDeploymentId: number,
	) => Promise<void>;
}

/** One tick for one connection watch. Never throws: a tick must not stop the others. */
export const pollConnectionWatch = async (
	watch: WatchRow,
	deps: ConnectionPollDeps,
): Promise<void> => {
	try {
		await pollConnectionInner(watch, deps);
	} catch (error) {
		const message = describeError(error);
		deps.log(`gha connection: watch ${watch.watchId} failed: ${message}`);
		await deps
			.patchWatch(watch.watchId, { lastError: message })
			.catch(() => {});
		deps.block(watchKey(watch.watchId), deps.now() + WATCH_ERROR_BACKOFF_MS);
	}
};

// What a tick remembers for the next one, in memory only. Everything that must
// survive a restart (processed runs, accepted releases, the gate's start) is in
// the database; losing these only costs one repeated request after a boot.
const recheckSeen = new Map<string, number>();
const recheckAfter = new Map<string, number>();
const startFailures = new Map<string, number>();
const backedUp = new Set<string>();
/** Backups before a first release that run (or ran) outside the tick, by release. */
const backupRuns = new Map<
	string,
	{ done: boolean; ok: boolean; note: string }
>();
const lastGateStatus = new Map<string, string>();

/** Test hook: forget what the poll keeps between ticks. */
export const resetConnectionPollState = () => {
	recheckSeen.clear();
	recheckAfter.clear();
	startFailures.clear();
	backedUp.clear();
	backupRuns.clear();
	lastGateStatus.clear();
};

interface Candidate {
	deployment: GithubDeployment;
	runId: number;
	attempt: number;
	/** The job and runner the wake-up named: a hint for where to look for the manifest. */
	hint: { job?: string; runner?: string };
}

const runKey = (record: ConnectionRecord, runId: number, attempt: number) =>
	`${record.connectionId}:${runId}:${attempt}`;

const deploymentAgeMs = (
	deployment: GithubDeployment,
	key: string,
	now: number,
): number => {
	const created = deployment.created_at
		? Date.parse(deployment.created_at)
		: Number.NaN;
	if (Number.isFinite(created)) return Math.max(0, now - created);
	// No date from GitHub: count from the first time this process asked.
	const first = recheckSeen.get(key) ?? now;
	recheckSeen.set(key, first);
	return now - first;
};

const pollConnectionInner = async (
	watch: WatchRow,
	deps: ConnectionPollDeps,
): Promise<void> => {
	const record = await deps.loadConnection(watch);
	if (!record) return;
	// A 304 still goes on: the gate looks at its waiting release on every tick. The first
	// poll baselines the history but keeps the wake-ups of this service created since Connect.
	const tick = await prepareTick(watch, deps, {
		continueOnNotModified: true,
		isNewOnBaseline: (deployment) => {
			if (parseDeploymentTask(deployment.task) !== record.facts.serviceKey) {
				return false;
			}
			const created = deployment.created_at
				? Date.parse(deployment.created_at)
				: Number.NaN;
			return Number.isFinite(created) && created >= record.createdAt;
		},
	});
	if (!tick) return;

	const progress = { cursor: tick.lastSeen as number | null };
	await discover(watch, deps, tick, record, progress);

	// The list may have paused the connection (rate limit) or the watch was reset.
	const now = deps.now();
	const paused = (key: string) => {
		const until = deps.blockedUntil(key);
		return until !== undefined && until > now;
	};
	if (
		paused(connectionKey(watch.connectionId)) ||
		paused(watchKey(watch.watchId))
	) {
		return;
	}
	await settle(
		{ ...watch, lastSeenDeploymentId: progress.cursor },
		deps,
		tick,
		record,
	);
};

/** Step 1: the new GitHub Deployments of this service, verified and recorded. */
const discover = async (
	watch: WatchRow,
	deps: ConnectionPollDeps,
	tick: TickInput,
	record: ConnectionRecord,
	progress: { cursor: number | null },
): Promise<void> => {
	const { token, now } = tick;
	const accept = deps.accept ?? acceptRelease;
	const fresh = selectNewDeployments(tick.listed.deployments, tick.lastSeen);
	if (fresh.length === 0) {
		await handleFresh(watch, deps, tick, fresh, new Map(), undefined, progress);
		return;
	}
	const api = deps.createApi(token, record);
	const classified = new Map<number, Classified>();

	// Cheap, local decisions first: whose wake-up is it, is it readable, is it a repeat?
	const candidates: Candidate[] = [];
	const seen = new Set<string>();
	for (const deployment of fresh) {
		const key = parseDeploymentTask(deployment.task);
		if (key === null || key !== record.facts.serviceKey) {
			classified.set(deployment.id, {
				kind: "ignore",
				reason: "not a release of this service",
			});
			continue;
		}
		const wake = parseWakePayload(deployment.payload);
		if (!wake.ok) {
			classified.set(deployment.id, {
				kind: "invalid",
				reason: wake.reason,
				statusText: STATUS_TEXT.unreadable,
			});
			continue;
		}
		const pair = `${wake.runId}:${wake.runAttempt}`;
		if (
			seen.has(pair) ||
			wasProcessed(record.processed, wake.runId, wake.runAttempt)
		) {
			classified.set(deployment.id, {
				kind: "ignore",
				reason: "already handled",
			});
			continue;
		}
		seen.add(pair);
		candidates.push({
			deployment,
			runId: wake.runId,
			attempt: wake.runAttempt,
			hint: { job: wake.job, runner: wake.runner },
		});
	}

	// Newest first, at most MAX_VERIFICATIONS_PER_TICK runs looked at.
	candidates.sort((a, b) => b.deployment.id - a.deployment.id);
	const handled: ProcessedEntry[] = [];
	const stamp = (c: Candidate, outcome: string): ProcessedEntry => ({
		runId: c.runId,
		attempt: c.attempt,
		outcome,
		at: new Date(now).toISOString(),
	});
	let verified = 0;
	let settled = false;
	let held: string | null = null;

	for (const candidate of candidates) {
		const id = candidate.deployment.id;
		if (settled) {
			// Older than a release that is accepted (or already running): superseded, never verified.
			classified.set(id, { kind: "superseded" });
			continue;
		}
		if (held !== null) {
			classified.set(id, { kind: "hold", reason: held });
			continue;
		}
		const rkey = runKey(record, candidate.runId, candidate.attempt);
		const retryAt = recheckAfter.get(rkey);
		if (retryAt !== undefined && retryAt > now) {
			held =
				"GitHub-side settings still refuse this release; asking again later.";
			classified.set(id, { kind: "hold", reason: held });
			continue;
		}
		const mayVerify = deps.takeVerification
			? deps.takeVerification(record.facts.repoId)
			: verified < MAX_VERIFICATIONS_PER_TICK;
		if (!mayVerify) {
			held =
				"More runs are waiting to be checked; the rest are checked on the next tick.";
			classified.set(id, { kind: "hold", reason: held });
			continue;
		}
		verified += 1;
		const result: AcceptanceResult = await accept(
			{
				runId: candidate.runId,
				runAttempt: candidate.attempt,
				connection: record.facts,
				hint: candidate.hint,
			},
			{ api, probe: deps.createProbe(record.organizationId) },
		);

		switch (result.kind) {
			case "pending": {
				held = result.reason;
				classified.set(id, { kind: "hold", reason: held });
				break;
			}
			case "retry": {
				held = "GitHub could not be asked; trying again soon.";
				if (result.cause.kind === "rate-limited") {
					deps.block(connectionKey(watch.connectionId), result.cause.retryAt);
				} else if (result.cause.kind === "unauthorized") {
					await deps.markRevoked(watch.connectionId);
				} else {
					deps.block(watchKey(watch.watchId), now + 3 * 20_000);
				}
				classified.set(id, { kind: "hold", reason: held });
				break;
			}
			case "superseded": {
				// A re-run replaced the artifact: this Deployment is old, not wrong.
				handled.push(stamp(candidate, "superseded"));
				classified.set(id, { kind: "superseded" });
				break;
			}
			case "ignored": {
				handled.push(stamp(candidate, "ignored"));
				classified.set(id, { kind: "ignore", reason: result.reason });
				break;
			}
			case "refused": {
				if (result.block) {
					await deps.applyEvent(record.connectionId, {
						type: "release-refused",
						message: result.message,
						block: true,
					});
				}
				if (result.recheck) {
					// GitHub-side changes can clear this one: ask again later and do not record
					// the run as handled, but not for ever.
					if (
						deploymentAgeMs(candidate.deployment, rkey, now) <
						RECHECK_MAX_AGE_MS
					) {
						recheckAfter.set(rkey, now + RECHECK_BACKOFF_MS);
						held = result.message;
						classified.set(id, { kind: "hold", reason: held });
						break;
					}
					// Given up: a final refusal that does not block again (the block, if any, stands).
					recheckAfter.delete(rkey);
					recheckSeen.delete(rkey);
					const gaveUp = await postStatus(
						deps,
						watch,
						token,
						id,
						"failure",
						STATUS_TEXT.refused,
					);
					if (!gaveUp.settled) {
						held = "The status could not be posted yet.";
						classified.set(id, { kind: "hold", reason: held });
						break;
					}
					handled.push(stamp(candidate, "recheck-expired"));
					classified.set(id, { kind: "ignore", reason: result.message });
					break;
				}
				const answered = await postStatus(
					deps,
					watch,
					token,
					id,
					"failure",
					result.code === "run-failed"
						? STATUS_TEXT.runFailed
						: STATUS_TEXT.refused,
				);
				if (!answered.settled) {
					held = "The status could not be posted yet.";
					classified.set(id, { kind: "hold", reason: held });
					break;
				}
				handled.push(stamp(candidate, result.code));
				classified.set(id, { kind: "ignore", reason: result.message });
				break;
			}
			case "noop": {
				const answered = await postStatus(
					deps,
					watch,
					token,
					id,
					"success",
					STATUS_TEXT.alreadyDeployed,
				);
				if (!answered.settled) {
					held = "The status could not be posted yet.";
					classified.set(id, { kind: "hold", reason: held });
					break;
				}
				await deps.recordNoop(record.connectionId, result.release, id);
				await retireNotNewerThan(deps, watch, token, record, result.release);
				if (result.release.delivery === "pull") {
					await deps.applyEvent(record.connectionId, {
						type: "release-deployed",
					});
				}
				handled.push(stamp(candidate, "noop"));
				classified.set(id, { kind: "ignore", reason: "already deployed" });
				settled = true;
				break;
			}
			case "accepted": {
				if (result.release.delivery === "push") {
					// The workflow deployed it itself: Dokploy verifies it, records it, never deploys it.
					const answered = await postStatus(
						deps,
						watch,
						token,
						id,
						"success",
						STATUS_TEXT.verifiedPush,
					);
					if (!answered.settled) {
						held = "The status could not be posted yet.";
						classified.set(id, { kind: "hold", reason: held });
						break;
					}
					await deps.recordVerifiedPush(
						record.connectionId,
						result.release,
						id,
					);
					// What the workflow deployed is now the newest thing running: a pull release
					// that was waiting at the gate and is not newer must never go out over it.
					await retireNotNewerThan(deps, watch, token, record, result.release);
					handled.push(stamp(candidate, "verified-push"));
					classified.set(id, { kind: "ignore", reason: "verified" });
					settled = true;
					break;
				}
				// A release of several services waits until every Deployment of the run exists.
				const completeness = checkReleaseComplete({
					ownKey: record.facts.serviceKey,
					releaseServices: result.release.releaseServices,
					runId: result.release.runId,
					runAttempt: result.release.runAttempt,
					deployments: tick.listed.deployments,
					now,
					runEndedAt: result.release.runEndedAt,
				});
				if (!completeness.complete) {
					const names = completeness.missing.join(", ");
					if (!completeness.timedOut) {
						held = `Waiting for the other services of this release: ${names}.`;
						classified.set(id, { kind: "hold", reason: held });
						break;
					}
					const message = `The release is incomplete: no Deployment for ${names} after 15 minutes.`;
					await deps.applyEvent(record.connectionId, {
						type: "release-refused",
						message,
						block: true,
					});
					const answered = await postStatus(
						deps,
						watch,
						token,
						id,
						"failure",
						STATUS_TEXT.refused,
					);
					if (!answered.settled) {
						held = "The status could not be posted yet.";
						classified.set(id, { kind: "hold", reason: held });
						break;
					}
					handled.push(stamp(candidate, "release-incomplete"));
					classified.set(id, { kind: "ignore", reason: message });
					break;
				}
				// Kept, not started: the gate decides when it goes out (step 2).
				await deps.recordAccepted(record.connectionId, result.release, id);
				handled.push(stamp(candidate, "accepted"));
				classified.set(id, {
					kind: "ignore",
					reason: "accepted; waiting for the deploy gate",
				});
				settled = true;
				break;
			}
		}
	}

	// Remembered before anything else moves: a crash after this point replays nothing.
	if (handled.length > 0) {
		await deps.recordProcessed(record.connectionId, handled);
	}
	await handleFresh(watch, deps, tick, fresh, classified, undefined, progress);
};

/** Newest release first: the later run, then the later attempt of the same run. */
const newestFirst = (a: PendingRelease, b: PendingRelease) =>
	b.runId - a.runId || b.runAttempt - a.runAttempt;

const toGateRelease = (release: PendingRelease): GateRelease => ({
	releaseId: release.releaseId,
	sha: release.sha,
	runId: release.runId,
	createdAt: release.createdAt,
	gateState: release.gateState,
	gateExpected: release.gateExpected,
	gateCheckedAt: release.gateCheckedAt,
});

/** The deploy request for an accepted release, in the shape the release start reads. */
export const releasePayload = (
	record: ConnectionRecord,
	release: PendingRelease,
	runUrl: string,
): Extract<Classified, { kind: "deploy" }> | null => {
	const parsed = release.images.map((image) => ({
		image,
		pinned: parsePinnedImage(image.ref),
	}));
	const [primary, ...rest] = parsed;
	if (!primary?.pinned || rest.some((entry) => !entry.pinned)) return null;
	return {
		kind: "deploy",
		image: primary.pinned.image,
		repository: primary.pinned.repository,
		digest: primary.pinned.digest,
		buildRunUrl: runUrl,
		...(rest.length > 0
			? {
					extraImages: rest.map((entry) => ({
						repository: entry.pinned?.repository as string,
						digest: entry.pinned?.digest as string,
					})),
				}
			: {}),
		release: {
			connectionId: record.connectionId,
			gateVersion: record.gate.gateVersion,
			serviceKey: record.facts.serviceKey,
			manifestReleaseId: release.manifestReleaseId,
			sha: release.sha,
			runId: release.runId,
			runAttempt: release.runAttempt,
			delivery: release.delivery,
			images: release.images.map((image) => ({
				name: image.name,
				composeService: image.composeService,
				ref: image.ref,
			})),
		},
	};
};

/** Post a status only when it says something new for this release. */
const announce = async (
	deps: ConnectionPollDeps,
	watch: WatchRow,
	token: string,
	release: PendingRelease,
	state: "queued" | "failure",
	text: string,
) => {
	if (release.githubDeploymentId === null) return;
	const memo = `${state}:${text}`;
	if (lastGateStatus.get(release.releaseId) === memo) return;
	const posted = await postStatus(
		deps,
		watch,
		token,
		release.githubDeploymentId,
		state,
		text,
	);
	if (posted.settled) lastGateStatus.set(release.releaseId, memo);
};

/** Whether a release is the same run and attempt as `than`, or an earlier one. */
const notNewerThan = (
	release: { runId: number; runAttempt: number },
	than: { runId: number; attempt?: number; runAttempt?: number },
) => {
	const attempt = than.attempt ?? than.runAttempt ?? 0;
	return (
		release.runId < than.runId ||
		(release.runId === than.runId && release.runAttempt <= attempt)
	);
};

/** These accepted releases will never be deployed: answer them inactive and forget their gate start. */
const retire = async (
	deps: ConnectionPollDeps,
	watch: WatchRow,
	token: string,
	record: ConnectionRecord,
	releases: PendingRelease[],
) => {
	if (releases.length === 0) return;
	for (const release of releases) {
		lastGateStatus.delete(release.releaseId);
		if (release.githubDeploymentId === null) continue;
		await postStatus(
			deps,
			watch,
			token,
			release.githubDeploymentId,
			"inactive",
			STATUS_TEXT.superseded,
		);
	}
	await deps.supersedeReleases(
		record.connectionId,
		releases.map((release) => release.releaseId),
	);
	await deps.gateStore.clearGateStart(record.connectionId);
};

/** A pushed or already-running release was recorded: accepted pull releases that are not newer are retired. */
const retireNotNewerThan = async (
	deps: ConnectionPollDeps,
	watch: WatchRow,
	token: string,
	record: ConnectionRecord,
	recorded: AcceptedRelease,
) => {
	const waiting = (await deps.loadPendingReleases(record.connectionId)).filter(
		(release) =>
			release.delivery === "pull" &&
			notNewerThan(release, {
				runId: recorded.runId,
				attempt: recorded.runAttempt,
			}),
	);
	await retire(deps, watch, token, record, waiting);
};

/** Step 2: the newest accepted release goes through the gate; a passing one is started. */
const settle = async (
	watch: WatchRow,
	deps: ConnectionPollDeps,
	tick: TickInput,
	first: ConnectionRecord,
): Promise<void> => {
	const { token } = tick;
	// A `push` release is verified and recorded, never deployed: the workflow did that.
	const pending = (await deps.loadPendingReleases(first.connectionId)).filter(
		(release) => release.delivery === "pull",
	);
	if (pending.length === 0) return;
	// Discovery may have changed the connection (a block, a verified release): read it again.
	// A connection that is gone (its service was deleted) has nothing left to deploy.
	const record = await deps.loadConnection(watch);
	if (!record) return;

	// Not newer than what runs now: never deployed over it.
	const deployed = record.facts.deployed;
	const live = deployed
		? pending.filter((release) => !notNewerThan(release, deployed))
		: pending;
	if (deployed && live.length < pending.length) {
		await retire(
			deps,
			watch,
			token,
			record,
			pending.filter((release) => notNewerThan(release, deployed)),
		);
	}
	if (live.length === 0) return;
	const [newest, ...older] = [...live].sort(newestFirst) as [
		PendingRelease,
		...PendingRelease[],
	];

	// A newer release supersedes the ones still waiting.
	await retire(deps, watch, token, record, older);

	const { state, gateBlocked } = record.gate;
	// Blocked for a reason that is not the gate's (a refused release) or a lost token:
	// the gate neither sets nor lifts those, so a passing gate must not deploy through them.
	if ((state === "blocked" && !gateBlocked) || state === "disconnected") {
		return;
	}
	if (newest.githubDeploymentId === null) {
		await deps.failRelease(record.connectionId, newest.releaseId);
		return;
	}

	const run = deps.runGate ?? runDeployGate;
	const decision: GateDecision = await run({
		connection: record.gate,
		release: toGateRelease(newest),
		github: deps.createGateGithub(token, record),
		now: deps.now,
		store: deps.gateStore,
		appSlug: null,
	});

	if (decision.state === "waiting") {
		await announce(
			deps,
			watch,
			token,
			newest,
			"queued",
			describeGateDecision(decision),
		);
		return;
	}
	if (decision.state === "blocked") {
		await announce(
			deps,
			watch,
			token,
			newest,
			"failure",
			describeGateDecision(decision),
		);
		return;
	}
	await startRelease(watch, deps, tick, record, newest);
};

const startRelease = async (
	watch: WatchRow,
	deps: ConnectionPollDeps,
	tick: TickInput,
	record: ConnectionRecord,
	release: PendingRelease,
): Promise<void> => {
	const { token, now } = tick;
	const deploymentId = release.githubDeploymentId as number;
	const runUrl = `https://github.com/${watch.owner}/${watch.repo}/actions/runs/${release.runId}`;
	const payload = releasePayload(record, release, runUrl);
	const reject = async (reason: string, block: boolean) => {
		await deps.failRelease(record.connectionId, release.releaseId);
		if (block) {
			await deps.applyEvent(
				record.connectionId,
				{ type: "release-refused", message: reason, block: true },
				reason,
			);
		}
		await postStatus(
			deps,
			watch,
			token,
			deploymentId,
			"failure",
			STATUS_TEXT.rejected,
		);
		await deps.patchWatch(watch.watchId, {
			lastError: `Release ${release.sha.slice(0, 7)} was rejected: ${reason.slice(0, 180)}`,
		});
	};
	if (!payload) {
		await reject(
			"The accepted release has an image that is not pinned by digest.",
			true,
		);
		return;
	}

	// The first release changes the service: back it up first.
	if (
		record.facts.deployed === null &&
		deps.preFlipBackup &&
		!backedUp.has(release.releaseId)
	) {
		// A dump can take minutes and the tick serves every connection: the backup runs on
		// its own, and the release is looked at again on the next ticks.
		const run = backupRuns.get(release.releaseId);
		if (!run) {
			const state = { done: false, ok: false, note: "" };
			backupRuns.set(release.releaseId, state);
			deps
				.preFlipBackup(watch, record)
				.then(
					(result) => {
						state.ok = result.ok;
						state.note = result.note;
					},
					(error) => {
						state.ok = false;
						state.note = `The backup before the first release failed (${describeError(error, 120)}). The release waits and is tried again.`;
					},
				)
				.finally(() => {
					state.done = true;
				});
			await deps.patchWatch(watch.watchId, {
				lastError: "Backing up before the first release.",
			});
			return;
		}
		if (!run.done) return;
		backupRuns.delete(release.releaseId);
		if (!run.ok) {
			await deps.patchWatch(watch.watchId, { lastError: run.note });
			deps.block(watchKey(watch.watchId), now + BACKUP_RETRY_MS);
			return;
		}
		backedUp.add(release.releaseId);
	}

	const deployment: GithubDeployment = {
		id: deploymentId,
		sha: release.sha,
		environment: record.facts.environment,
		task: `dokploy:${record.facts.serviceKey}`,
	};
	const attemptKey = `${watch.watchId}:${release.releaseId}`;
	let outcome: Awaited<ReturnType<PollDeps["startDeploy"]>>;
	try {
		outcome = await deps.startDeploy(watch, deployment, payload);
	} catch (error) {
		const attempts = (startFailures.get(attemptKey) ?? 0) + 1;
		startFailures.set(attemptKey, attempts);
		if (attempts < MAX_START_ATTEMPTS) throw error;
		startFailures.delete(attemptKey);
		await deps.failRelease(record.connectionId, release.releaseId);
		await postStatus(
			deps,
			watch,
			token,
			deploymentId,
			"failure",
			STATUS_TEXT.notQueued,
		);
		await deps.patchWatch(watch.watchId, {
			lastError: `Release ${release.sha.slice(0, 7)} could not be queued: ${describeError(error, 120)}`,
		});
		return;
	}
	startFailures.delete(attemptKey);
	if (outcome.kind === "stale") return;
	if (outcome.kind === "rejected") {
		await reject(outcome.reason, true);
		return;
	}
	lastGateStatus.delete(release.releaseId);
	// Started: the in-flight mark was saved with the enqueue. Best effort from here.
	await postStatus(
		deps,
		watch,
		token,
		deploymentId,
		"in_progress",
		STATUS_TEXT.accepted,
		outcome.logUrl,
	);
	await deps.patchWatch(watch.watchId, {
		lastCheckedAt: new Date(now),
		lastError: null,
	});
};
