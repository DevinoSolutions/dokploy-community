/**
 * Read-through cache and quota backoff for Uptimely reads.
 *
 * Every Uptimely call is metered against the project's monthly quota, and the
 * service panel polls. Reads (monitor list/get, status pages) therefore go
 * through a short in-memory TTL cache keyed by organization + integration +
 * project, with one shared promise per key so concurrent tabs and users make a
 * single upstream call. When Uptimely answers 429 or a quota error, the
 * integration is put in backoff until the reset time: cached data (even
 * expired) is served and no further call is made. Writes never use the cache;
 * they invalidate it.
 */

import { UptimelyError } from "./client";

export const UPTIMELY_READ_CACHE_TTL_MS = 60_000;
export const UPTIMELY_DEFAULT_BACKOFF_MS = 15 * 60_000;
/** Expired entries are kept this long so they can be served during backoff. */
const STALE_RETENTION_MS = 60 * 60_000;
const MAX_ENTRIES = 500;

export class UptimelyQuotaError extends UptimelyError {
	readonly retryAt: number;

	constructor(retryAt: number, options: { cause?: unknown } = {}) {
		super(
			`Uptimely quota exhausted, retrying after ${new Date(retryAt).toISOString()}`,
			{
				code: "QUOTA_EXHAUSTED",
				retryAfterMs: Math.max(0, retryAt - Date.now()),
			},
		);
		this.name = "UptimelyQuotaError";
		this.retryAt = retryAt;
		if (options.cause !== undefined) this.cause = options.cause;
	}
}

const QUOTA_CODE_PATTERN = /QUOTA|RATE_?LIMIT|TOO_MANY_REQUESTS/i;

export const isUptimelyQuotaError = (error: unknown): boolean =>
	error instanceof UptimelyQuotaError ||
	(error instanceof UptimelyError &&
		(error.code === 429 ||
			(typeof error.code === "string" && QUOTA_CODE_PATTERN.test(error.code))));

type IntegrationScope = { organizationId: string; uptimelyId: string };
type Scope = IntegrationScope & { projectId: string; baseUrl: string };

type Entry = { value: unknown; expiresAt: number };

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const backoffUntil = new Map<string, number>();

const integrationPrefix = (s: IntegrationScope) =>
	`${JSON.stringify([s.organizationId, s.uptimelyId])}|`;

const scopeKey = (s: Scope) =>
	`${integrationPrefix(s)}${JSON.stringify([s.projectId, s.baseUrl])}|`;

const prune = (now: number) => {
	for (const [key, entry] of entries) {
		if (entry.expiresAt + STALE_RETENTION_MS < now) entries.delete(key);
	}
	while (entries.size > MAX_ENTRIES) {
		const oldest = entries.keys().next().value;
		if (oldest === undefined) break;
		entries.delete(oldest);
	}
};

/** Reset time of an active quota backoff for the integration, else null. */
export const getUptimelyBackoffUntil = (
	scope: IntegrationScope,
	now = Date.now(),
): number | null => {
	const key = integrationPrefix(scope);
	const until = backoffUntil.get(key);
	if (until === undefined) return null;
	if (until <= now) {
		backoffUntil.delete(key);
		return null;
	}
	return until;
};

/** Drops cached reads and backoff for an integration (update/remove/link/unlink). */
export const invalidateUptimelyCache = (scope: IntegrationScope) => {
	const prefix = integrationPrefix(scope);
	for (const map of [entries, inflight] as Map<string, unknown>[]) {
		for (const key of [...map.keys()]) {
			if (key.startsWith(prefix)) map.delete(key);
		}
	}
	backoffUntil.delete(prefix);
};

export const resetUptimelyCacheForTests = () => {
	entries.clear();
	inflight.clear();
	backoffUntil.clear();
};

/**
 * Runs `fetcher` at most once per `name` per TTL for the integration. Fresh
 * entries are returned as is; concurrent misses share one promise. In backoff
 * the last known value is served (or an UptimelyQuotaError thrown when there
 * is none) without calling upstream.
 */
export const readUptimelyCached = async <T>(
	scope: Scope,
	name: string,
	fetcher: () => Promise<T>,
	options: { ttlMs?: number } = {},
): Promise<T> => {
	const now = Date.now();
	const key = `${scopeKey(scope)}${name}`;
	const entry = entries.get(key);
	if (entry && entry.expiresAt > now) return entry.value as T;

	const until = getUptimelyBackoffUntil(scope, now);
	if (until !== null) {
		if (entry) return entry.value as T;
		throw new UptimelyQuotaError(until);
	}

	const pending = inflight.get(key);
	if (pending) return pending as Promise<T>;

	const run = (async () => {
		try {
			const value = await fetcher();
			const at = Date.now();
			entries.set(key, {
				value,
				expiresAt: at + (options.ttlMs ?? UPTIMELY_READ_CACHE_TTL_MS),
			});
			prune(at);
			return value;
		} catch (error) {
			if (!isUptimelyQuotaError(error)) throw error;
			const waitMs =
				error instanceof UptimelyError &&
				typeof error.retryAfterMs === "number" &&
				error.retryAfterMs > 0
					? error.retryAfterMs
					: UPTIMELY_DEFAULT_BACKOFF_MS;
			const retryAt = Date.now() + waitMs;
			backoffUntil.set(integrationPrefix(scope), retryAt);
			if (entry) return entry.value as T;
			throw new UptimelyQuotaError(retryAt, { cause: error });
		} finally {
			inflight.delete(key);
		}
	})();
	inflight.set(key, run);
	return run;
};
