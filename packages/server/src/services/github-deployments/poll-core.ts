import { redactSecrets } from "../../utils/process/redactSecrets";
import type { FetchLike } from "./device-flow";
import {
	createDeploymentStatus,
	type DeploymentState,
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
/** Attempts to post one status before it is given up (a watch must not wedge on it). */
export const MAX_STATUS_ATTEMPTS = 5;
/** First wait after a status the API refused; doubles each attempt up to the cap. */
export const STATUS_RETRY_BASE_MS = 30_000;
export const STATUS_RETRY_MAX_MS = 5 * 60 * 1000;

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
	/** Opt in to sending this Dokploy's dashboard link to GitHub as `log_url`. Off by default. */
	postLogUrl: boolean;
}

export type DeployPayload = Extract<ParsedPayload, { kind: "deploy" }>;

export type StartOutcome =
	| { kind: "started"; logUrl?: string }
	/** A concurrent poll already took this deployment, or the watch changed under it. */
	| { kind: "stale" }
	/** A rule said no (service gone, wrong source, image from elsewhere). */
	| { kind: "rejected"; reason: string };

export type InflightState =
	| { state: "running" }
	| { state: "done"; logUrl?: string }
	| { state: "error"; logUrl?: string }
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
	/** `lastSeenDeploymentId` only ever moves forward (see patchGithubWatch). */
	patchWatch: (watchId: string, patch: WatchPatch) => Promise<void>;
	/**
	 * Atomically: advance lastSeen to `deployment.id`, record it as in flight,
	 * write the image on the service and enqueue the Dokploy deploy. Throws when
	 * it could not be done, leaving nothing behind.
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
const statusAttempts = new Map<string, number>();

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

const DATABASE_ERROR =
	/failed query|\bparams:|\b(?:insert into|update|delete from)\s+"/i;

/**
 * A short, safe account of an error for `lastError`, the server log and the
 * dashboard: no stack, one line, no secrets, and never a database statement
 * with its parameters (a Drizzle error carries the query and its values).
 * Nothing built from it is ever sent to GitHub.
 */
export const describeError = (error: unknown, limit = 160): string => {
	const raw =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	if (DATABASE_ERROR.test(raw)) return "A database error occurred";
	const line = redactSecrets(raw.split("\n")[0] ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return line ? short(line, limit) : "An unexpected error occurred";
};

/**
 * What GitHub is told. Fixed text only: nothing from an error, a deployment
 * log, a payload or a database ever reaches GitHub, because the statuses of a
 * deployment are readable by everyone who can see the repository.
 */
export const STATUS_TEXT = {
	accepted: "Dokploy accepted the deployment",
	done: "Deployed by Dokploy",
	failed: "Dokploy deployment failed; see the Dokploy dashboard",
	cancelled: "The Dokploy deployment was cancelled",
	timeout: "Dokploy did not finish this deployment in time",
	lost: "Dokploy has no record of this deployment",
	rejected: "Dokploy rejected this deployment; see the Dokploy dashboard",
	unreadable: "Dokploy could not read the payload of this deployment",
	notQueued:
		"Dokploy could not queue this deployment; see the Dokploy dashboard",
	superseded:
		"Superseded by a newer deployment; Dokploy deployed the newest only",
	serviceGone:
		"The Dokploy service was removed before this deployment finished",
} as const;

const statusRetryDelay = (attempts: number) =>
	Math.min(
		STATUS_RETRY_MAX_MS,
		STATUS_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
	);

const statusProblem = (status: number) =>
	status > 0
		? `GitHub did not accept the deployment status (HTTP ${status}).`
		: "GitHub could not be reached to report the deployment status.";

type Settled =
	| { settled: true; problem?: string }
	/** Not posted yet: retried on a later tick (rate limit, back-off, revoked token). */
	| { settled: false };

/**
 * Post one deployment status, with bounded retries.
 *
 * - posted, or GitHub says nobody can use it (404/410/422): settled.
 * - rate limited: the connection is paused until GitHub allows more; not settled.
 * - 401: the token is dead. The connection is marked revoked and the status is
 *   posted after the user connects again; not settled.
 * - anything else (a 403 that is not a rate limit, a 5xx, no answer): the watch
 *   backs off (30s, 60s, ... capped at 5 min) and after MAX_STATUS_ATTEMPTS the
 *   status is given up, so the watch is not stuck on it; `problem` says so.
 */
const postStatus = async (
	deps: PollDeps,
	watch: WatchRow,
	token: string,
	deploymentId: number,
	state: DeploymentState,
	description: string,
	logUrl?: string,
): Promise<Settled> => {
	const result = await createDeploymentStatus(deps, {
		token,
		owner: watch.owner,
		repo: watch.repo,
		deploymentId,
		state,
		description,
		// Opt in per watch: the dashboard link is internal.
		logUrl: watch.postLogUrl ? logUrl : undefined,
	});
	const key = `${watch.watchId}:${deploymentId}:${state}`;
	if (result.ok) {
		statusAttempts.delete(key);
		return { settled: true };
	}
	if (result.rateLimitedUntil) {
		deps.block(connectionKey(watch.connectionId), result.rateLimitedUntil);
		return { settled: false };
	}
	if (result.status === 401) {
		await deps.markRevoked(watch.connectionId);
		return { settled: false };
	}
	// The deployment was deleted or is not ours to write to: nobody is waiting.
	if (result.status === 404 || result.status === 410 || result.status === 422) {
		statusAttempts.delete(key);
		return { settled: true };
	}
	const attempts = (statusAttempts.get(key) ?? 0) + 1;
	if (attempts >= MAX_STATUS_ATTEMPTS) {
		statusAttempts.delete(key);
		return { settled: true, problem: statusProblem(result.status) };
	}
	statusAttempts.set(key, attempts);
	deps.block(watchKey(watch.watchId), deps.now() + statusRetryDelay(attempts));
	return { settled: false };
};

type EndState =
	| Exclude<InflightState, { state: "running" } | { state: "missing" }>
	| { state: "timeout" }
	| { state: "lost" };

/** Report the end of a Dokploy deployment to GitHub. */
const reportEnd = async (
	deps: PollDeps,
	watch: WatchRow,
	token: string,
	inflight: EndState,
): Promise<Settled> => {
	const text = {
		done: STATUS_TEXT.done,
		error: STATUS_TEXT.failed,
		cancelled: STATUS_TEXT.cancelled,
		timeout: STATUS_TEXT.timeout,
		lost: STATUS_TEXT.lost,
	} as const;
	return postStatus(
		deps,
		watch,
		token,
		watch.inflightDeploymentId as number,
		inflight.state === "done" ? "success" : "failure",
		text[inflight.state],
		"logUrl" in inflight ? inflight.logUrl : undefined,
	);
};

/**
 * The service of a watch was deleted. If a deployment was in flight, GitHub is
 * told once that it ended (a workflow may be waiting on it). Best effort: the
 * caller deletes the watch either way.
 */
export const reportServiceGone = async (
	watch: WatchRow,
	deps: PollDeps,
): Promise<void> => {
	if (watch.inflightDeploymentId === null) return;
	try {
		const token = await deps.loadToken(watch.connectionId);
		if (!token) return;
		await createDeploymentStatus(deps, {
			token,
			owner: watch.owner,
			repo: watch.repo,
			deploymentId: watch.inflightDeploymentId,
			state: "failure",
			description: STATUS_TEXT.serviceGone,
		});
	} catch {
		// The watch is going away regardless.
	}
};

/** One tick for one watch. Never throws: a tick must not stop the others. */
export const pollWatch = async (
	watch: WatchRow,
	deps: PollDeps,
): Promise<void> => {
	try {
		await pollWatchInner(watch, deps);
	} catch (error) {
		const message = describeError(error);
		deps.log(`github deployments: watch ${watch.watchId} failed: ${message}`);
		await deps
			.patchWatch(watch.watchId, { lastError: message })
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
		let end: EndState | null = null;
		if (state.state === "running") {
			if (age > INFLIGHT_TIMEOUT_MS) end = { state: "timeout" };
		} else if (state.state === "missing") {
			if (age > INFLIGHT_ROW_GRACE_MS) end = { state: "lost" };
		} else {
			end = state;
		}
		if (!end) return;
		const reported = await reportEnd(deps, watch, token, end);
		if (reported.settled) {
			await deps.patchWatch(watch.watchId, {
				inflightDeploymentId: null,
				inflightStartedAt: null,
				lastError: reported.problem ?? null,
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
		lastSeen: watch.lastSeenDeploymentId,
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

	// 4. New ones, oldest first. Only the NEWEST valid deployment for this
	// service is deployed; every older valid one is answered as superseded so
	// no workflow waits on it. Deployments of other services are left alone.
	const fresh = selectNewDeployments(
		listed.deployments,
		watch.lastSeenDeploymentId,
	);
	const parsedById = new Map(
		fresh.map((d) => [
			d.id,
			parseDeploymentPayload(d.payload, watch.serviceId),
		]),
	);
	let targetId: number | undefined;
	for (const d of fresh) {
		if (parsedById.get(d.id)?.kind === "deploy") targetId = d.id;
	}
	/** What the dashboard keeps showing from this pass, if anything. */
	let problem: string | null = null;
	/** Where the stored cursor stands in this pass (startDeploy checks it against the locked row). */
	let cursor = watch.lastSeenDeploymentId;
	const advance = async (deploymentId: number) => {
		await deps.patchWatch(watch.watchId, {
			lastSeenDeploymentId: deploymentId,
		});
		cursor = Math.max(cursor ?? 0, deploymentId);
	};

	for (const deployment of fresh) {
		const parsed = parsedById.get(deployment.id);
		if (!parsed || parsed.kind === "ignore") {
			await advance(deployment.id);
			continue;
		}
		if (parsed.kind === "invalid") {
			const answered = await postStatus(
				deps,
				watch,
				token,
				deployment.id,
				"failure",
				STATUS_TEXT.unreadable,
			);
			if (!answered.settled) return;
			problem = `Deployment #${deployment.id}: ${short(parsed.reason, 200)}`;
			await advance(deployment.id);
			continue;
		}
		if (deployment.id !== targetId) {
			const answered = await postStatus(
				deps,
				watch,
				token,
				deployment.id,
				"inactive",
				STATUS_TEXT.superseded,
			);
			if (!answered.settled) return;
			await advance(deployment.id);
			continue;
		}

		const attemptKey = `${watch.watchId}:${deployment.id}`;
		let outcome: StartOutcome;
		try {
			outcome = await deps.startDeploy(
				{ ...watch, lastSeenDeploymentId: cursor },
				deployment,
				parsed,
			);
		} catch (error) {
			const attempts = (startAttempts.get(attemptKey) ?? 0) + 1;
			startAttempts.set(attemptKey, attempts);
			if (attempts < MAX_START_ATTEMPTS) throw error;
			startAttempts.delete(attemptKey);
			const answered = await postStatus(
				deps,
				watch,
				token,
				deployment.id,
				"failure",
				STATUS_TEXT.notQueued,
			);
			if (!answered.settled) return;
			problem = `Deployment #${deployment.id} could not be queued: ${describeError(error, 120)}`;
			await advance(deployment.id);
			continue;
		}
		startAttempts.delete(attemptKey);
		if (outcome.kind === "stale") return;
		if (outcome.kind === "rejected") {
			const answered = await postStatus(
				deps,
				watch,
				token,
				deployment.id,
				"failure",
				STATUS_TEXT.rejected,
			);
			if (!answered.settled) return;
			problem = `Deployment #${deployment.id} was rejected: ${short(outcome.reason, 200)}`;
			await advance(deployment.id);
			continue;
		}
		// Started: lastSeen and in-flight were saved with the enqueue. Best effort from here.
		await postStatus(
			deps,
			watch,
			token,
			deployment.id,
			"in_progress",
			STATUS_TEXT.accepted,
			outcome.logUrl,
		);
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
		lastError: problem,
	});
};

/** Test hook: forget attempt counters. */
export const resetPollState = () => {
	startAttempts.clear();
	statusAttempts.clear();
};
