import {
	findApplicationById,
	findComposeById,
	registerExternalBuild,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { backups, domains, registry } from "@dokploy/server/db/schema";
import { findBackupById } from "@dokploy/server/services/backup";
import {
	type AcceptedRelease,
	type ApiDeps,
	applyConnectionEvent,
	buildConnectionRecord,
	type ConnectionPollDeps,
	compareCommits,
	createActionsApi,
	createGateGithub,
	createRegistryProbe,
	dbDeployGateStore,
	deploySourceTypeOf,
	digestsOf,
	failAcceptedRelease,
	findGhaConnectionById,
	type GhaConnectionRow,
	getBranchHead,
	getFileText,
	getRepositoryById,
	listPendingReleases,
	listWorkflowRuns,
	MAX_VERIFICATIONS_PER_TICK,
	pickEnvironmentUrl,
	pollConnectionWatch,
	type ReleaseInput,
	type RepositoryInfo,
	type RunInfo,
	recordProcessedRuns,
	recordRelease,
	recordRunSeen,
	recordVerifiedRelease,
	renameGhaConnectionRepository,
	runUpkeep,
	settleRelease,
	supersedeReleases,
	toPendingRelease,
} from "@dokploy/server/services/gha-connect";
import {
	listPinnedComposeRepositories,
	type PollDeps,
	repositoryOfReference,
	type WatchRow,
	watchKey,
} from "@dokploy/server/services/github-deployments";
import { runComposeBackup } from "@dokploy/server/utils/backups/compose";
import { and, eq } from "drizzle-orm";

/**
 * The real database and GitHub behind a GitHub Actions connection's tick. The
 * rules are in packages/server/src/services/gha-connect; this file only wires
 * them to this process.
 */

/** Upkeep (five GitHub reads) at most this often per connection: the polling budget. */
export const UPKEEP_INTERVAL_MS = 120_000;
const lastUpkeepAt = new Map<string, number>();
/** The last answer for a repository id, so a tick asks GitHub only "did the name change?" (a 304 is free). */
const repositoryMemo = new Map<
	string,
	{ etag: string | null; fullName: string }
>();

/** Test hook: forget what the dependencies keep between ticks. */
export const resetGhaConnectionState = () => {
	lastUpkeepAt.clear();
	repositoryMemo.clear();
};

const hostOf = (url: string) =>
	url
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/\/+$/, "");

/** The login this organization saved for a registry host (Settings, Registry), or null. */
const loadRegistryAccess = async (organizationId: string, host: string) => {
	const rows = await db
		.select({
			registryUrl: registry.registryUrl,
			username: registry.username,
			password: registry.password,
		})
		.from(registry)
		.where(eq(registry.organizationId, organizationId));
	const hit = rows.find(
		(row) => hostOf(row.registryUrl) === host.toLowerCase(),
	);
	return hit
		? {
				baseUrl: `https://${hostOf(hit.registryUrl)}`,
				username: hit.username,
				password: hit.password,
			}
		: null;
};

/** Repositories the service runs now: empty before its first image. */
const currentRepositories = async (
	row: GhaConnectionRow,
): Promise<string[]> => {
	if (row.serviceType === "application") {
		const app = await findApplicationById(row.serviceId).catch(() => null);
		const image =
			app && deploySourceTypeOf(app, "application") === "docker"
				? app.dockerImage?.trim()
				: null;
		return image ? [repositoryOfReference(image)] : [];
	}
	const stack = await findComposeById(row.serviceId).catch(() => null);
	return stack ? listPinnedComposeRepositories(stack.composeFile) : [];
};

const releaseInput = (
	ghaConnectionId: string,
	release: AcceptedRelease,
	githubDeploymentId: number,
	status: "accepted" | "verified" | "noop",
): ReleaseInput => ({
	ghaConnectionId,
	manifestReleaseId: release.releaseId,
	sha: release.sha,
	runId: release.runId,
	runAttempt: release.runAttempt,
	delivery: release.delivery,
	status,
	githubDeploymentId,
	images: release.images.map((image) => ({
		name: image.name,
		composeService: image.composeService,
		ref: image.ref,
	})),
	digests: digestsOf(release.images),
	manifestSource: release.manifestSource,
});

/**
 * Before the first release of a connection changes a service, run what a bad change could harm:
 * a compose stack that has enabled backup schedules (its Backups tab, which includes the rows a
 * backup policy materializes for its databases) gets one fresh run of each, through the same
 * function the "Run now" button calls. A failure holds the release, shows the reason and tries
 * again later. The service's own configuration (an application's source settings, a compose
 * stack's id and file text) is saved separately, in the same transaction as the change, as
 * gha_release.sourceBackup (see prepareReleaseDeploy). A service with no schedule passes here: the
 * data of the other Dokploy services it talks to belongs to their own backup policies.
 */
export const runServiceBackups = async (
	watch: Pick<WatchRow, "serviceType" | "serviceId">,
): Promise<{ ok: boolean; note: string }> => {
	if (watch.serviceType !== "compose") return { ok: true, note: "" };
	const schedules = await db
		.select({ backupId: backups.backupId })
		.from(backups)
		.where(
			and(eq(backups.composeId, watch.serviceId), eq(backups.enabled, true)),
		);
	if (schedules.length === 0) return { ok: true, note: "" };
	const stack = await findComposeById(watch.serviceId).catch(() => null);
	if (!stack) {
		return {
			ok: false,
			note: "The compose stack could not be read for its backup.",
		};
	}
	for (const { backupId } of schedules) {
		try {
			await runComposeBackup(stack, await findBackupById(backupId));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				note: `The backup before the first release failed (${reason}). The release waits and is tried again.`,
			};
		}
	}
	return { ok: true, note: "" };
};

export const createGhaConnectionPollDeps = (
	base: PollDeps,
): ConnectionPollDeps => {
	// One GitHub client for the whole tick: the base fetch already cuts every request
	// off after 15 seconds, so a hung GitHub cannot stall the tick for the other connections.
	const apiDeps: ApiDeps = { fetch: base.fetch, now: base.now };
	// The verification budget belongs to the repository and to this tick: voicekit has three
	// connections on one repository, and together they get MAX_VERIFICATIONS_PER_TICK. This
	// function is called once per tick, so the counter starts at zero every tick.
	const verificationsUsed = new Map<number, number>();
	return {
		...base,
		takeVerification: (repoId) => {
			const used = verificationsUsed.get(repoId) ?? 0;
			if (used >= MAX_VERIFICATIONS_PER_TICK) return false;
			verificationsUsed.set(repoId, used + 1);
			return true;
		},
		preFlipBackup: (watch) => runServiceBackups(watch),
		loadConnection: async (watch) => {
			const row = watch.ghaConnectionId
				? await findGhaConnectionById(watch.ghaConnectionId)
				: null;
			return row
				? buildConnectionRecord(row, watch, await currentRepositories(row))
				: null;
		},
		loadPendingReleases: async (connectionId) =>
			(await listPendingReleases(connectionId)).map(toPendingRelease),
		createApi: (token, record) =>
			createActionsApi(apiDeps, token, {
				owner: record.facts.owner,
				repo: record.facts.repo,
			}),
		createProbe: (organizationId) =>
			createRegistryProbe({
				fetch: apiDeps.fetch,
				loadAccess: (host) => loadRegistryAccess(organizationId, host),
			}),
		createGateGithub: (token, record) =>
			createGateGithub(apiDeps, token, {
				owner: record.facts.owner,
				repo: record.facts.repo,
			}),
		gateStore: dbDeployGateStore,
		recordProcessed: (connectionId, entries) =>
			recordProcessedRuns(connectionId, entries),
		applyEvent: async (connectionId, event, note) => {
			await applyConnectionEvent(connectionId, event, note);
		},
		recordAccepted: (connectionId, release, githubDeploymentId) =>
			recordRelease(
				releaseInput(connectionId, release, githubDeploymentId, "accepted"),
			),
		supersedeReleases,
		failRelease: failAcceptedRelease,
		recordVerifiedPush: (connectionId, release, githubDeploymentId) =>
			recordVerifiedRelease(
				releaseInput(connectionId, release, githubDeploymentId, "verified"),
			),
		recordNoop: (connectionId, release, githubDeploymentId) =>
			recordVerifiedRelease(
				releaseInput(connectionId, release, githubDeploymentId, "noop"),
			),
		environmentUrl: async (watch) => {
			const rows = await db
				.select({
					host: domains.host,
					https: domains.https,
					path: domains.path,
				})
				.from(domains)
				.where(
					watch.serviceType === "application"
						? eq(domains.applicationId, watch.serviceId)
						: eq(domains.composeId, watch.serviceId),
				);
			return pickEnvironmentUrl(rows);
		},
		onDeployEnded: async (watch, end) => {
			if (!watch.ghaConnectionId || watch.inflightDeploymentId === null) return;
			await settleRelease(
				watch.ghaConnectionId,
				watch.inflightDeploymentId,
				end.state === "done" ? "deployed" : "failed",
			);
			if (end.state === "done") {
				await applyConnectionEvent(
					watch.ghaConnectionId,
					{ type: "release-deployed" },
					null,
				);
			}
		},
	};
};

/** A queued or running run shows as a live GitHub Actions row, when the service can have one. */
const registerLiveRow = async (
	row: GhaConnectionRow,
	watch: WatchRow,
	run: RunInfo,
) => {
	try {
		await registerExternalBuild({
			...(row.serviceType === "application"
				? { applicationId: row.serviceId }
				: { composeId: row.serviceId }),
			buildOrigin: "github-actions",
			buildRunUrl: run.htmlUrl,
			buildRunId: String(run.id),
			buildRepository: `${watch.owner}/${watch.repo}`,
			buildCommitSha: run.headSha,
			title: `GHA run #${run.id}`,
			description: `${watch.owner}/${watch.repo} ${run.headSha.slice(0, 7)} (${row.trackedBranch})`,
		});
	} catch {
		// A service Dokploy builds itself, or a link it cannot take: the first
		// deploy of the release still gets its own row.
	}
};

/**
 * The repository by its immutable id. `ok` carries the answer; a 304 answers
 * "not-modified" (the name is what it was). Used by the rename check on every
 * tick, which is cheap because of the ETag, and by the upkeep.
 */
const readRepository = async (
	apiDeps: ApiDeps,
	row: GhaConnectionRow,
	token: string,
) => {
	const memo = repositoryMemo.get(row.ghaConnectionId);
	const result = await getRepositoryById(
		apiDeps,
		token,
		row.repoId,
		memo?.etag ?? null,
	);
	if (result.kind === "ok") {
		repositoryMemo.set(row.ghaConnectionId, {
			etag: result.etag,
			fullName: result.value.fullName,
		});
	}
	return result;
};

/** Apply a new repository name to the connection, its watch and the snapshot this tick polls with. */
const applyRename = async (
	row: GhaConnectionRow,
	watch: WatchRow,
	info: Pick<RepositoryInfo, "fullName">,
) => {
	const [owner, repo] = info.fullName.split("/");
	if (!owner || !repo) return;
	if (
		!(await renameGhaConnectionRepository(row.ghaConnectionId, info.fullName))
	) {
		return;
	}
	row.repoFullName = info.fullName;
	// The rest of this tick polls under the new name.
	watch.owner = owner;
	watch.repo = repo;
};

const runConnectionUpkeep = async (
	apiDeps: ApiDeps,
	watch: WatchRow,
	row: GhaConnectionRow,
	token: string,
	now: number,
) => {
	const last = lastUpkeepAt.get(row.ghaConnectionId);
	if (last !== undefined && now - last < UPKEEP_INTERVAL_MS) return;
	lastUpkeepAt.set(row.ghaConnectionId, now);

	const ref = { owner: watch.owner, repo: watch.repo };
	const workflowFile = row.workflowPath.split("/").pop() ?? "";
	const accepted = await listPendingReleases(row.ghaConnectionId);
	const result = await runUpkeep(
		{
			now,
			state: row.state,
			repoId: row.repoId,
			repoFullName: row.repoFullName,
			trackedBranch: row.trackedBranch,
			workflowPath: row.workflowPath,
			deployedSha: row.deployedSha,
			acceptedShas: accepted.map((release) => release.sha),
		},
		{
			repository: () => readRepository(apiDeps, row, token),
			branchHead: () => getBranchHead(apiDeps, token, ref, row.trackedBranch),
			workflowRuns: () =>
				listWorkflowRuns(apiDeps, token, ref, workflowFile, row.trackedBranch),
			compare: (base, head) => compareCommits(apiDeps, token, ref, base, head),
			workflowFile: () =>
				getFileText(apiDeps, token, ref, row.workflowPath, row.trackedBranch),
		},
	);

	if (result.renamedTo)
		await applyRename(row, watch, { fullName: result.renamedTo });
	for (const event of result.events) {
		await applyConnectionEvent(row.ghaConnectionId, event, null);
	}
	for (const run of result.liveRuns) await registerLiveRow(row, watch, run);
	if (
		result.newestRunId !== null &&
		result.newestRunId > (row.lastRunSeenId ?? 0)
	) {
		await recordRunSeen(row.ghaConnectionId, result.newestRunId);
	}
};

/** The name check of every tick: one conditional request, free when nothing changed. */
const checkRepositoryName = async (
	apiDeps: ApiDeps,
	watch: WatchRow,
	row: GhaConnectionRow,
	token: string,
) => {
	const result = await readRepository(apiDeps, row, token);
	if (result.kind === "ok" && result.value.fullName !== row.repoFullName) {
		await applyRename(row, watch, result.value);
	}
};

/**
 * One tick for one connection: token state, the repository's name, upkeep,
 * then the Deployments poll. A step that fails costs its own information for
 * this tick, never the poll that follows.
 */
export const pollGhaConnection = async (
	watch: WatchRow,
	row: GhaConnectionRow,
	deps: ConnectionPollDeps,
	options: { woken?: boolean } = {},
) => {
	const token = await deps.loadToken(watch.connectionId);
	if (!token) {
		await applyConnectionEvent(row.ghaConnectionId, { type: "token-revoked" });
		return;
	}
	if (row.state === "disconnected") {
		await applyConnectionEvent(row.ghaConnectionId, {
			type: "token-restored",
			hasRelease: row.deployedSha !== null,
		});
		row.state = row.deployedSha !== null ? "connected" : "waiting";
	}
	if (options.woken) {
		// "Check now": the next steps run whatever the back-off said.
		lastUpkeepAt.delete(row.ghaConnectionId);
		deps.block(watchKey(watch.watchId), 0);
	}
	const apiDeps: ApiDeps = { fetch: deps.fetch, now: deps.now };
	try {
		await checkRepositoryName(apiDeps, watch, row, token);
		await runConnectionUpkeep(apiDeps, watch, row, token, deps.now());
	} catch (error) {
		deps.log(
			`gha connection ${row.ghaConnectionId}: upkeep failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	await pollConnectionWatch(watch, deps);
};
