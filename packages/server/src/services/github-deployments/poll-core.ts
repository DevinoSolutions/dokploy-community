import type { FetchLike } from "./device-flow";
import {
	createDeploymentStatus,
	type GithubDeployment,
	listDeployments,
} from "./github-api";
import { type ParsedPayload, parseDeploymentPayload } from "./payload";

/**
 * The poll of one watch, with every side effect behind `PollDeps` so the
 * selection, ETag, back-off and status-posting rules are unit tested.
 * See docs/design/github-deployments-pull.md.
 */

export const POLL_INTERVAL_MS = 20_000;
/** A Dokploy deployment that never ends is reported to GitHub as failed after this. */
export const INFLIGHT_TIMEOUT_MS = 90 * 60 * 1000;
/** How long a queued job may take to show up as a deployment row. */
export const INFLIGHT_ROW_GRACE_MS = 10 * 60 * 1000;
/** Errors on one watch (not a rate limit) are retried no sooner than this. */
export const WATCH_ERROR_BACKOFF_MS = 5 * 60 * 1000;
/** Attempts to start one deployment before it is answered with a failure. */
export const MAX_START_ATTEMPTS = 3;

export interface WatchRow {
	watchId: string;
	organizationId: string;
	serviceType: "application" | "compose";
	serviceId: string;
	connectionId: string;
	owner: string;
	repo: string;
	environment: string;
	enabled: boolean;
	lastSeenDeploymentId: number | null;
	etag: string | null;
	inflightDeploymentId: number | null;
	inflightStartedAt: Date | null;
}

export type DeployPayload = Extract<ParsedPayload, { kind: "deploy" }>;

export type StartOutcome =
	| { kind: "started"; logUrl?: string }
	/** A concurrent poll already took this deployment. */
	| { kind: "stale" }
	/** A rule said no (service gone, wrong source, image from elsewhere). */
	| { kind: "rejected"; reason: string };

export type InflightState =
	| { state: "running" }
	| { state: "done"; logUrl?: string }
	| { state: "error"; logUrl?: string; detail?: string }
	| { state: "cancelled"; logUrl?: string }
	/** No Dokploy deployment row for this GitHub deployment (yet). */
	| { state: "missing" };

export interface WatchPatch {
	lastSeenDeploymentId?: number;
	etag?: string | null;
	inflightDeploymentId?: number | null;
	inflightStartedAt?: Date | null;
	lastError?: string | null;
	lastCheckedAt?: Date;
}

export interface PollDeps {
	fetch: FetchLike;
	now: () => number;
	/** The connection's token, or null when it is gone or revoked. */
	loadToken: (connectionId: string) => Promise<string | null>;
	markRevoked: (connectionId: string) => Promise<void>;
	/** Epoch ms until which this key (connection or watch) must not be called. */
	blockedUntil: (key: string) => number | undefined;
	block: (key: string, until: number) => void;
	patchWatch: (watchId: string, patch: WatchPatch) => Promise<void>;
	/**
	 * Atomically: advance lastSeen to `deployment.id`, record it as in flight,
	 * and enqueue the Dokploy deploy. Throws when it could not be done.
	 */
	startDeploy: (
		watch: WatchRow,
		deployment: GithubDeployment,
		payload: DeployPayload,
	) => Promise<StartOutcome>;
	inspectInflight: (watch: WatchRow) => Promise<InflightState>;
	log: (message: string) => void;
}

const startAttempts = new Map<string, number>();

const connectionKey = (connectionId: string) => `connection:${connectionId}`;
const watchKey = (watchId: string) => `watch:${watchId}`;

/** New deployments, oldest first: ids above lastSeen, in id order. */
export const selectNewDeployments = (
	deployments: GithubDeployment[],
	lastSeen: number,
): GithubDeployment[] =>
	deployments.filter((d) => d.id > lastSeen).sort((a, b) => a.id - b.id);

export const maxDeploymentId = (deployments: GithubDeployment[]): number =>
	deployments.reduce((max, d) => (d.id > max ? d.id : max), 0);

const short = (text: string, limit = 140) =>
	text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;

/** Report the end of a Dokploy deployment to GitHub; true when GitHub has it (or never will). */
const reportEnd = async (
	deps: PollDeps,
	watch: WatchRow,
	token: string,
	inflight:
		| Exclude<InflightState, { state: "running" } | { state: "missing" }>
		| { state: "timeout" }
		| { state: "lost" },
): Promise<boolean> => {
	const id = watch.inflightDeploymentId as number;
	const text = {
		done: "Deployed by Dokploy",
		error: "The Dokploy deployment failed",
		cancelled: "The Dokploy deployment was cancelled",
		timeout: "Dokploy did not finish this deployment in time",
		lost: "Dokploy has no record of this deployment",
	} as const;
	const detail =
		"detail" in inflight && inflight.detail ? `: ${inflight.detail}` : "";
	const result = await createDeploymentStatus(deps, {
		token,
		owner: watch.owner,
		repo: watch.repo,
		deploymentId: id,
		state: inflight.state === "done" ? "success" : "failure",
		description: short(`${text[inflight.state]}${detail}`),
		logUrl: "logUrl" in inflight ? inflight.logUrl : undefined,
	});
	if (result.ok) return true;
	if (result.rateLimitedUntil) {
		deps.block(connectionKey(watch.connectionId), result.rateLimitedUntil);
		return false;
	}
	// The deployment was deleted or is not ours to write to: nobody is waiting.
	return (
		result.status === 404 || result.status === 410 || result.status === 422
	);
};

/** One tick for one watch. Never throws: a tick must not stop the others. */
export const pollWatch = async (
	watch: WatchRow,
	deps: PollDeps,
): Promise<void> => {
	try {
		await pollWatchInner(watch, deps);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.log(
			`github deployments: watch ${watch.watchId} failed: ${short(message, 200)}`,
		);
		await deps
			.patchWatch(watch.watchId, { lastError: short(message, 300) })
			.catch(() => {});
		deps.block(watchKey(watch.watchId), deps.now() + WATCH_ERROR_BACKOFF_MS);
	}
};

const pollWatchInner = async (
	watch: WatchRow,
	deps: PollDeps,
): Promise<void> => {
	if (!watch.enabled) return;
	const now = deps.now();
	const watchBlock = deps.blockedUntil(watchKey(watch.watchId));
	if (watchBlock !== undefined && watchBlock > now) return;
	const connBlock = deps.blockedUntil(connectionKey(watch.connectionId));
	if (connBlock !== undefined && connBlock > now) return;

	const token = await deps.loadToken(watch.connectionId);
	if (!token) {
		await deps.patchWatch(watch.watchId, {
			lastError:
				"The GitHub connection is missing or was revoked. Connect GitHub again.",
		});
		deps.block(watchKey(watch.watchId), now + WATCH_ERROR_BACKOFF_MS);
		return;
	}

	// 1. A deployment is on its way: report its end, and take nothing new meanwhile.
	if (watch.inflightDeploymentId !== null) {
		const state = await deps.inspectInflight(watch);
		const startedAt = watch.inflightStartedAt?.getTime() ?? now;
		const age = now - startedAt;
		let end: Parameters<typeof reportEnd>[3] | null = null;
		if (state.state === "running") {
			if (age > INFLIGHT_TIMEOUT_MS) end = { state: "timeout" };
		} else if (state.state === "missing") {
			if (age > INFLIGHT_ROW_GRACE_MS) end = { state: "lost" };
		} else {
			end = state;
		}
		if (!end) return;
		if (await reportEnd(deps, watch, token, end)) {
			await deps.patchWatch(watch.watchId, {
				inflightDeploymentId: null,
				inflightStartedAt: null,
				lastError: null,
			});
		}
		return;
	}

	// 2. Look for new deployments (a 304 costs no rate limit).
	const listed = await listDeployments(deps, {
		token,
		owner: watch.owner,
		repo: watch.repo,
		environment: watch.environment,
		etag: watch.etag,
	});
	switch (listed.kind) {
		case "not-modified":
			await deps.patchWatch(watch.watchId, {
				lastCheckedAt: new Date(now),
				lastError: null,
			});
			return;
		case "rate-limited":
			deps.block(connectionKey(watch.connectionId), listed.retryAt);
			deps.log(
				`github deployments: rate limited, pausing connection ${watch.connectionId} for ${Math.ceil((listed.retryAt - now) / 1000)}s`,
			);
			return;
		case "unauthorized":
			await deps.markRevoked(watch.connectionId);
			return;
		case "forbidden":
		case "not-found":
			await deps.patchWatch(watch.watchId, {
				lastError:
					listed.kind === "not-found"
						? `GitHub cannot find ${watch.owner}/${watch.repo}, or the connected account cannot see it.`
						: listed.message,
			});
			deps.block(watchKey(watch.watchId), now + WATCH_ERROR_BACKOFF_MS);
			return;
		case "error":
			await deps.patchWatch(watch.watchId, {
				lastError: `GitHub answered with an error${listed.status ? ` (HTTP ${listed.status})` : ""}.`,
			});
			deps.block(watchKey(watch.watchId), now + POLL_INTERVAL_MS * 3);
			return;
		case "ok":
			break;
	}

	// 3. First poll: remember where the history ends. Old deployments never run.
	if (watch.lastSeenDeploymentId === null) {
		await deps.patchWatch(watch.watchId, {
			lastSeenDeploymentId: maxDeploymentId(listed.deployments),
			etag: listed.etag,
			lastCheckedAt: new Date(now),
			lastError: null,
		});
		return;
	}

	// 4. New ones, oldest first. One starts a deploy; the rest wait for it to end.
	const fresh = selectNewDeployments(
		listed.deployments,
		watch.lastSeenDeploymentId,
	);
	for (const deployment of fresh) {
		const parsed = parseDeploymentPayload(deployment.payload, watch.serviceId);
		if (parsed.kind === "ignore") {
			await deps.patchWatch(watch.watchId, {
				lastSeenDeploymentId: deployment.id,
			});
			continue;
		}
		if (parsed.kind === "invalid") {
			if (
				!(await answerFailure(deps, watch, token, deployment.id, parsed.reason))
			)
				return;
			await deps.patchWatch(watch.watchId, {
				lastSeenDeploymentId: deployment.id,
			});
			continue;
		}

		const attemptKey = `${watch.watchId}:${deployment.id}`;
		let outcome: StartOutcome;
		try {
			outcome = await deps.startDeploy(watch, deployment, parsed);
		} catch (error) {
			const attempts = (startAttempts.get(attemptKey) ?? 0) + 1;
			startAttempts.set(attemptKey, attempts);
			if (attempts < MAX_START_ATTEMPTS) throw error;
			startAttempts.delete(attemptKey);
			const message = error instanceof Error ? error.message : String(error);
			const answered = await answerFailure(
				deps,
				watch,
				token,
				deployment.id,
				`Dokploy could not queue the deploy: ${short(message, 90)}`,
			);
			if (!answered) return;
			await deps.patchWatch(watch.watchId, {
				lastSeenDeploymentId: deployment.id,
			});
			continue;
		}
		startAttempts.delete(attemptKey);
		if (outcome.kind === "stale") return;
		if (outcome.kind === "rejected") {
			if (
				!(await answerFailure(
					deps,
					watch,
					token,
					deployment.id,
					outcome.reason,
				))
			)
				return;
			await deps.patchWatch(watch.watchId, {
				lastSeenDeploymentId: deployment.id,
			});
			continue;
		}
		// Started: lastSeen and in-flight were saved with the enqueue. Best effort from here.
		const posted = await createDeploymentStatus(deps, {
			token,
			owner: watch.owner,
			repo: watch.repo,
			deploymentId: deployment.id,
			state: "in_progress",
			description: "Dokploy accepted the deployment",
			logUrl: outcome.logUrl,
		});
		if (posted.ok === false && posted.rateLimitedUntil) {
			deps.block(connectionKey(watch.connectionId), posted.rateLimitedUntil);
		}
		await deps.patchWatch(watch.watchId, {
			lastCheckedAt: new Date(now),
			lastError: null,
		});
		// The etag is deliberately NOT saved: the next list must return 200 again.
		return;
	}

	// Everything new was answered or skipped: this response is fully handled.
	await deps.patchWatch(watch.watchId, {
		etag: listed.etag,
		lastCheckedAt: new Date(now),
		lastError: null,
	});
};

const answerFailure = async (
	deps: PollDeps,
	watch: WatchRow,
	token: string,
	deploymentId: number,
	reason: string,
): Promise<boolean> => {
	const result = await createDeploymentStatus(deps, {
		token,
		owner: watch.owner,
		repo: watch.repo,
		deploymentId,
		state: "failure",
		description: short(reason),
	});
	if (!result.ok && result.rateLimitedUntil) {
		// Not answered yet: keep the deployment unhandled so the next tick retries.
		deps.block(connectionKey(watch.connectionId), result.rateLimitedUntil);
		return false;
	}
	return true;
};

/** Test hook: forget attempt counters. */
export const resetPollState = () => startAttempts.clear();
