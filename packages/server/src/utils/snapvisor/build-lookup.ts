import {
	type SnapvisorBuild,
	type SnapvisorBuildStatus,
	SnapvisorError,
} from "./client";

/**
 * Build statuses that can never change again on their own: a review outcome
 * (accepted/rejected) or a finished/failed run (no-changes/error/aborted/
 * expired). `changes-detected` is NOT terminal: it waits for a reviewer.
 */
export const SNAPVISOR_TERMINAL_STATUSES: ReadonlySet<SnapvisorBuildStatus> =
	new Set<SnapvisorBuildStatus>([
		"accepted",
		"rejected",
		"no-changes",
		"error",
		"aborted",
		"expired",
	]);

export const isTerminalSnapvisorStatus = (status: SnapvisorBuildStatus) =>
	SNAPVISOR_TERMINAL_STATUSES.has(status);

/** The build state a visual reviewer has to look at. */
export const SNAPVISOR_CHANGES_STATUS: SnapvisorBuildStatus =
	"changes-detected";

/**
 * How many builds a per-commit lookup asks for. Snapvisor documents
 * `listBuilds` as "most recent first", but a commit can carry several builds
 * (one per build name), so the lookup takes a few and picks by build number
 * rather than trusting the page order.
 */
export const SNAPVISOR_BUILD_LOOKUP_PAGE_SIZE = 5;

/** The build with the highest number: the newest, whatever order they came in. */
export const pickLatestSnapvisorBuild = (
	builds: readonly SnapvisorBuild[],
): SnapvisorBuild | null => {
	let latest: SnapvisorBuild | null = null;
	for (const build of builds) {
		if (!latest || build.number > latest.number) latest = build;
	}
	return latest;
};

export type SnapvisorUnavailableReason =
	| "auth"
	| "rate-limited"
	| "project"
	| "unreachable";

/**
 * What a lookup found. None of these is an error: a missing build, a bad
 * token, a rate limit and an unreachable Snapvisor all have to leave the
 * deployments list intact, so they are values, not exceptions.
 */
export type SnapvisorBuildLookupResult =
	| { kind: "build"; build: SnapvisorBuild }
	| { kind: "none" }
	| { kind: "unavailable"; reason: SnapvisorUnavailableReason };

export const classifySnapvisorError = (
	error: unknown,
): SnapvisorUnavailableReason => {
	if (error instanceof SnapvisorError) {
		if (error.status === 401 || error.status === 403) return "auth";
		if (error.status === 429) return "rate-limited";
		if (error.status === 404) return "project";
	}
	return "unreachable";
};

/**
 * Whether a failed call says something about the whole organization's
 * Snapvisor access (bad or revoked token, rate limit, outage, no network) as
 * opposed to one project or one build (a renamed project, a rejected query).
 * Only the first kind may hold back the other services of the organization.
 */
export const isSnapvisorOrganizationWideFailure = (error: unknown) => {
	if (!(error instanceof SnapvisorError)) return true;
	const status = error.status;
	return (
		status === undefined ||
		status === 401 ||
		status === 403 ||
		status === 429 ||
		status >= 500
	);
};

export interface SnapvisorBuildLookupOptions {
	now?: () => number;
	/** A build that can no longer change. */
	terminalTtlMs?: number;
	/** A build that is still running or waiting for a review. */
	activeTtlMs?: number;
	/** No build for the commit yet. */
	noneTtlMs?: number;
	/** Auth, project, unreachable (a 429 uses Retry-After when it is longer). */
	errorTtlMs?: number;
	/** The longest a `Retry-After` can stretch a cached failure. */
	retryAfterCapMs?: number;
	/** A forced refresh within this window of the last live call is served from cache. */
	forceMinIntervalMs?: number;
	maxEntries?: number;
}

interface Entry {
	result: SnapvisorBuildLookupResult;
	fetchedAt: number;
	expiresAt: number;
}

/**
 * Short-lived, in-process cache in front of the per-commit Snapvisor build
 * lookup, keyed by whatever identifies it (`organization:project:sha`).
 *
 * The deployments list renders many rows and refreshes constantly; without
 * this every row on every client would be a live Snapvisor call. With it:
 * - one live call per key per TTL, however many rows or tabs ask;
 * - concurrent callers for the same key share one in-flight request;
 * - failures are cached too, so a dead Snapvisor or a revoked token is hit
 *   once a minute, not once per row;
 * - the manual refresh bypasses the TTL but not `forceMinIntervalMs`, so
 *   clicking refresh cannot become a hammer.
 */
export const createSnapvisorBuildLookup = (
	options: SnapvisorBuildLookupOptions = {},
) => {
	const now = options.now ?? Date.now;
	const terminalTtlMs = options.terminalTtlMs ?? 10 * 60_000;
	const activeTtlMs = options.activeTtlMs ?? 30_000;
	const noneTtlMs = options.noneTtlMs ?? 30_000;
	const errorTtlMs = options.errorTtlMs ?? 60_000;
	const retryAfterCapMs = options.retryAfterCapMs ?? 10 * 60_000;
	const forceMinIntervalMs = options.forceMinIntervalMs ?? 5_000;
	const maxEntries = options.maxEntries ?? 500;

	const entries = new Map<string, Entry>();
	const inflight = new Map<string, Promise<SnapvisorBuildLookupResult>>();

	const remember = (key: string, entry: Entry) => {
		entries.delete(key);
		entries.set(key, entry);
		while (entries.size > maxEntries) {
			const oldest = entries.keys().next().value;
			if (oldest === undefined) break;
			entries.delete(oldest);
		}
	};

	const run = async (
		key: string,
		fetchBuild: () => Promise<SnapvisorBuild | null>,
	): Promise<SnapvisorBuildLookupResult> => {
		let result: SnapvisorBuildLookupResult;
		let ttl: number;
		try {
			const build = await fetchBuild();
			if (build) {
				result = { kind: "build", build };
				ttl = isTerminalSnapvisorStatus(build.status)
					? terminalTtlMs
					: activeTtlMs;
			} else {
				result = { kind: "none" };
				ttl = noneTtlMs;
			}
		} catch (error) {
			result = { kind: "unavailable", reason: classifySnapvisorError(error) };
			ttl = errorTtlMs;
			if (error instanceof SnapvisorError && error.retryAfterSeconds) {
				ttl = Math.max(
					ttl,
					Math.min(error.retryAfterSeconds * 1000, retryAfterCapMs),
				);
			}
		}
		const at = now();
		remember(key, { result, fetchedAt: at, expiresAt: at + ttl });
		return result;
	};

	return {
		async lookup(
			key: string,
			fetchBuild: () => Promise<SnapvisorBuild | null>,
			{ force = false }: { force?: boolean } = {},
		): Promise<SnapvisorBuildLookupResult> {
			const at = now();
			const cached = entries.get(key);
			if (cached) {
				const fresh = cached.expiresAt > at;
				const forceAllowed = at - cached.fetchedAt >= forceMinIntervalMs;
				if (fresh && !(force && forceAllowed)) return cached.result;
			}
			const running = inflight.get(key);
			if (running) return running;
			const promise = run(key, fetchBuild).finally(() => {
				inflight.delete(key);
			});
			inflight.set(key, promise);
			return promise;
		},
		/** For tests and for dropping the cache of a removed integration. */
		clear() {
			entries.clear();
			inflight.clear();
		},
		size: () => entries.size,
	};
};

export type SnapvisorBuildLookup = ReturnType<
	typeof createSnapvisorBuildLookup
>;
