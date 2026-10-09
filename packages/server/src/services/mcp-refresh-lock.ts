import type { IncomingMessage, ServerResponse } from "node:http";
import postgres from "postgres";
import { dbUrl } from "../db/constants";
import { hashOAuthToken, MCP_TOKEN_PATH } from "./mcp-oauth";

/**
 * Serializes refresh-token grants per refresh token.
 *
 * MCP clients share one grant across sessions (every Claude Code session on a
 * machine reads the same credentials file), so several sessions often refresh
 * the same token at the same moment. The 1.7 provider rotates a refresh token
 * with a guarded update (`revoked IS NULL`) and only stores the replay
 * response for the reuse window afterwards. Concurrent requests that lose the
 * guard therefore get `invalid_grant` instead of the replay, and MCP clients
 * treat `invalid_grant` as a dead grant: the whole fleet would fall back to a
 * browser authorization (the #214 lock-out).
 *
 * Holding a lock per refresh token until the response is written makes the
 * losers wait for the winner; they then find the rotated row with its stored
 * replay response and receive the same tokens.
 *
 * Two layers:
 * - an in-process keyed queue, so one process never holds more than one
 *   database connection per token and the common single-replica case works
 *   without the database;
 * - a transaction-scoped Postgres advisory lock
 *   (`pg_advisory_xact_lock(namespace, hashtext(tokenHash))`) on a small
 *   dedicated pool, which serializes the same token across replicas. The pool
 *   is separate from the application pool on purpose: a lock holder waits for
 *   the provider's own queries, and those must never queue behind lock
 *   holders. If the advisory lock cannot be taken (database unreachable, lock
 *   timeout), the request proceeds with the in-process lock only and the
 *   failure is logged.
 */

/** First key of the two-key advisory lock: "MCPR" as an int4. */
export const REFRESH_LOCK_NAMESPACE = 0x4d435052;
/** Longest wait for another replica holding the same token. */
const ADVISORY_LOCK_TIMEOUT = "15s";
/** Upper bound on how long a request may hold the lock. */
export const REFRESH_LOCK_MAX_HOLD_MS = 30_000;
/** Token requests are a few hundred bytes; anything larger is refused. */
export const MAX_TOKEN_REQUEST_BYTES = 64 * 1024;

/** Runs `fn` while holding a cross-replica lock for `key`. */
export type AdvisoryLock = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

const globalForLock = globalThis as unknown as {
	mcpRefreshLockSql?: ReturnType<typeof postgres>;
};

const lockSql = () => {
	if (!globalForLock.mcpRefreshLockSql) {
		globalForLock.mcpRefreshLockSql = postgres(dbUrl, {
			max: 4,
			idle_timeout: 60,
			connect_timeout: 10,
		});
	}
	return globalForLock.mcpRefreshLockSql;
};

/**
 * Longest wait for a free connection of the lock pool. `lock_timeout` only
 * starts once a connection is held, and the pool has no queue limit of its
 * own, so without this bound a burst of distinct tokens (or holders stuck on a
 * slow provider) would queue requests behind the four connections.
 */
export const ADVISORY_ACQUIRE_TIMEOUT_MS = 5_000;

/**
 * Builds a cross-replica lock on `getSql()`: a transaction-scoped Postgres
 * advisory lock. When no pool connection frees up within `acquireTimeoutMs`
 * (or the database is unreachable, or the advisory lock times out) the request
 * proceeds under the in-process lock only and the reason is logged.
 */
export const createPostgresAdvisoryLock =
	({
		getSql = lockSql,
		acquireTimeoutMs = ADVISORY_ACQUIRE_TIMEOUT_MS,
	}: {
		getSql?: () => ReturnType<typeof postgres>;
		acquireTimeoutMs?: number;
	} = {}): AdvisoryLock =>
	async (key, fn) => {
		type Result = Awaited<ReturnType<typeof fn>>;
		let connected = false;
		let abandoned = false;
		let started = false;
		let finished = false;
		let result: Result | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const acquireTimeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					if (connected) return;
					abandoned = true;
					reject(
						new Error(
							`no lock connection available within ${acquireTimeoutMs}ms`,
						),
					);
				}, acquireTimeoutMs);
			});
			const run = getSql().begin(async (tx) => {
				connected = true;
				clearTimeout(timer);
				// The request gave up waiting and runs without this lock; hand
				// the slot straight back.
				if (abandoned) return;
				await tx`SELECT set_config('lock_timeout', ${ADVISORY_LOCK_TIMEOUT}, true)`;
				await tx`SELECT pg_advisory_xact_lock(${REFRESH_LOCK_NAMESPACE}::int4, hashtext(${key}))`;
				started = true;
				result = await fn();
				finished = true;
			});
			// A transaction that settles after the timeout won must not become
			// an unhandled rejection.
			run.catch(() => undefined);
			await Promise.race([run, acquireTimeout]);
			return result as Result;
		} catch (error) {
			// The request already ran: a failed COMMIT only means the lock was
			// released by the server instead.
			if (finished) return result as Result;
			if (started) throw error;
			console.error(
				"[mcp] refresh advisory lock unavailable, using the in-process lock only",
				error,
			);
			return fn();
		} finally {
			clearTimeout(timer);
		}
	};

/** Default cross-replica lock: a transaction-scoped Postgres advisory lock. */
export const postgresAdvisoryLock: AdvisoryLock = createPostgresAdvisoryLock();

/**
 * Lock factory. `advisory: null` keeps the in-process layer only (tests, or a
 * deployment without database access from this process).
 */
export const createRefreshTokenLock = ({
	advisory = postgresAdvisoryLock,
}: {
	advisory?: AdvisoryLock | null;
} = {}) => {
	const tails = new Map<string, Promise<void>>();

	return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
		const previous = tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => current);
		tails.set(key, tail);
		await previous;
		try {
			return advisory ? await advisory(key, fn) : await fn();
		} finally {
			release();
			if (tails.get(key) === tail) tails.delete(key);
		}
	};
};

export type RefreshTokenLock = ReturnType<typeof createRefreshTokenLock>;

const pathOf = (url: string | undefined) => (url ?? "").split("?")[0];

const readBody = (req: IncomingMessage): Promise<string | null> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let tooLarge = false;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_TOKEN_REQUEST_BYTES) {
				tooLarge = true;
				chunks.length = 0;
				return;
			}
			if (!tooLarge) chunks.push(chunk);
		});
		req.on("end", () =>
			resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")),
		);
		req.on("error", reject);
	});

/** The `refresh_token` of a refresh grant, or null for any other request. */
export const refreshTokenOfTokenRequest = (
	contentType: string | undefined,
	rawBody: string,
): string | null => {
	let params: Record<string, unknown> = {};
	if ((contentType ?? "").includes("application/json")) {
		try {
			const parsed = JSON.parse(rawBody);
			if (parsed && typeof parsed === "object") params = parsed;
		} catch {
			return null;
		}
	} else {
		params = Object.fromEntries(new URLSearchParams(rawBody).entries());
	}
	return params.grant_type === "refresh_token" &&
		typeof params.refresh_token === "string" &&
		params.refresh_token !== ""
		? params.refresh_token
		: null;
};

const responseDone = (res: ServerResponse) =>
	new Promise<void>((resolve) => {
		if (res.writableEnded || res.destroyed) return resolve();
		const timer = setTimeout(resolve, REFRESH_LOCK_MAX_HOLD_MS);
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		res.once("finish", done);
		res.once("close", done);
	});

/**
 * Wraps the better-auth node handler: a refresh grant to the token endpoint
 * (the legacy `/api/auth/mcp/token` alias is rewritten to it before this runs)
 * runs under the lock for its token, held until the response is written.
 *
 * The body has to be read to find the token, so it is buffered and handed to
 * better-call through `req.body`: its node adapter uses `req.body` once the
 * request stream has been consumed.
 */
export const serializeRefreshGrants =
	(
		handler: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>,
		lock: RefreshTokenLock,
		{ maxHoldMs = REFRESH_LOCK_MAX_HOLD_MS }: { maxHoldMs?: number } = {},
	) =>
	async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== "POST" || pathOf(req.url) !== MCP_TOKEN_PATH) {
			return handler(req, res);
		}
		const rawBody = await readBody(req);
		if (rawBody === null) {
			res.statusCode = 413;
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					error: "invalid_request",
					error_description: "request body too large",
				}),
			);
			return;
		}
		(req as IncomingMessage & { body?: unknown }).body = rawBody;
		const refreshToken = refreshTokenOfTokenRequest(
			req.headers["content-type"],
			rawBody,
		);
		if (!refreshToken) return handler(req, res);
		return lock(hashOAuthToken(refreshToken), async () => {
			// A handler that never settles must not keep its pool connection and
			// its queue position forever: after the maximum hold the lock is
			// released and the handler is left to finish (or hang) on its own,
			// since a running handler cannot be cancelled.
			let timer: ReturnType<typeof setTimeout> | undefined;
			const held = (async () => {
				const result = await handler(req, res);
				await responseDone(res);
				return result;
			})();
			const expired = new Promise<undefined>((resolve) => {
				timer = setTimeout(() => {
					console.error(
						`[mcp] refresh grant held its lock for ${maxHoldMs}ms, releasing it`,
					);
					resolve(undefined);
				}, maxHoldMs);
			});
			// Whichever side loses must not surface as an unhandled rejection.
			held.catch(() => undefined);
			try {
				return await Promise.race([held, expired]);
			} finally {
				clearTimeout(timer);
			}
		});
	};

const globalForRefreshLock = globalThis as unknown as {
	mcpRefreshTokenLock?: RefreshTokenLock;
};

/** Process-wide lock instance (one per process, even across module copies). */
export const getRefreshTokenLock = (): RefreshTokenLock => {
	if (!globalForRefreshLock.mcpRefreshTokenLock) {
		globalForRefreshLock.mcpRefreshTokenLock = createRefreshTokenLock();
	}
	return globalForRefreshLock.mcpRefreshTokenLock;
};
