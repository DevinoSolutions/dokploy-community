import { randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const { hashOAuthToken } = await import("@dokploy/server/services/mcp-oauth");
const {
	createPostgresAdvisoryLock,
	createRefreshTokenLock,
	serializeRefreshGrants,
	refreshTokenOfTokenRequest,
} = await import("@dokploy/server/services/mcp-refresh-lock");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stand-in for the oauth-provider 1.7.7 refresh grant, reduced to the steps
 * that race: read the row, rotate it with a guarded update
 * (`revoked IS NULL`), then store the replay response. A request that finds
 * the row already rotated replays the stored response; one that loses the
 * guard gets invalid_grant.
 */
const createFakeProvider = (initialToken: string) => {
	const rows = new Map<
		string,
		{ revoked: boolean; replay: Record<string, string> | null }
	>([[hashOAuthToken(initialToken), { revoked: false, replay: null }]]);
	const bodies: unknown[] = [];

	const send = (res: ServerResponse, status: number, body: unknown) => {
		res.statusCode = status;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(body));
	};

	const handler = async (req: IncomingMessage, res: ServerResponse) => {
		// The body was consumed by the wrapper and handed over as `req.body`,
		// which is where better-call's node adapter reads it from.
		const raw = (req as IncomingMessage & { body?: unknown }).body;
		bodies.push(raw);
		const params = new URLSearchParams(typeof raw === "string" ? raw : "");
		const token = params.get("refresh_token") ?? "";
		await sleep(5); // findOne
		const row = rows.get(hashOAuthToken(token));
		if (!row) return send(res, 400, { error: "invalid_grant" });
		if (row.revoked) {
			return row.replay
				? send(res, 200, row.replay)
				: send(res, 400, { error: "invalid_grant" });
		}
		await sleep(5); // token minting
		if (row.revoked) return send(res, 400, { error: "invalid_grant" }); // incrementOne guard
		row.revoked = true;
		const response = {
			access_token: randomUUID(),
			refresh_token: randomUUID(),
			token_type: "Bearer",
		};
		rows.set(hashOAuthToken(response.refresh_token), {
			revoked: false,
			replay: null,
		});
		await sleep(5); // storeRefreshTokenRotationReplay
		row.replay = response;
		return send(res, 200, response);
	};

	return { handler, bodies };
};

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers.splice(0).map((server) => {
			const closed = new Promise((resolve) => server.close(resolve));
			// A test may leave a request hanging on purpose.
			server.closeAllConnections();
			return closed;
		}),
	);
});

const listen = async (
	handler: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>,
) => {
	const server = createServer((req, res) => {
		void handler(req, res);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
};

const refresh = async (base: string, token: string, path = "/api/auth/oauth2/token") => {
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: token,
			client_id: "client-1",
		}).toString(),
	});
	return { status: response.status, body: await response.json() };
};

const PARALLEL = 8;

describe("parallel refreshes of one refresh token", () => {
	it("reproduce the race without the lock (sanity check of the stand-in)", async () => {
		const token = randomUUID();
		const provider = createFakeProvider(token);
		const base = await listen(async (req, res) => {
			(req as IncomingMessage & { body?: unknown }).body = await new Promise(
				(resolve) => {
					let data = "";
					req.on("data", (chunk) => {
						data += chunk;
					});
					req.on("end", () => resolve(data));
				},
			);
			return provider.handler(req, res);
		});
		const results = await Promise.all(
			Array.from({ length: PARALLEL }, () => refresh(base, token)),
		);
		const statuses = results.map((r) => r.status).sort();
		expect(statuses.filter((s) => s === 200)).toHaveLength(1);
		expect(statuses.filter((s) => s === 400)).toHaveLength(PARALLEL - 1);
	});

	it("all get 200 with identical tokens through the serialized handler", async () => {
		const token = randomUUID();
		const provider = createFakeProvider(token);
		const base = await listen(
			serializeRefreshGrants(
				provider.handler,
				createRefreshTokenLock({ advisory: null }),
			),
		);
		const results = await Promise.all(
			Array.from({ length: PARALLEL }, () => refresh(base, token)),
		);
		expect(results.map((r) => r.status)).toEqual(
			Array.from({ length: PARALLEL }, () => 200),
		);
		const first = results[0]?.body;
		expect(first.refresh_token).toEqual(expect.any(String));
		for (const result of results) {
			expect(result.body.access_token).toBe(first.access_token);
			expect(result.body.refresh_token).toBe(first.refresh_token);
		}
		// The handler received the original body.
		expect(provider.bodies).toHaveLength(PARALLEL);
		for (const body of provider.bodies) {
			expect(new URLSearchParams(body as string).get("refresh_token")).toBe(
				token,
			);
		}
	});

	it("takes the cross-replica lock keyed by the token hash, once per request", async () => {
		const token = randomUUID();
		const provider = createFakeProvider(token);
		const keys: string[] = [];
		let held = 0;
		let maxHeld = 0;
		const base = await listen(
			serializeRefreshGrants(
				provider.handler,
				createRefreshTokenLock({
					advisory: async (key, fn) => {
						keys.push(key);
						held++;
						maxHeld = Math.max(maxHeld, held);
						try {
							return await fn();
						} finally {
							held--;
						}
					},
				}),
			),
		);
		const results = await Promise.all(
			Array.from({ length: 4 }, () => refresh(base, token)),
		);
		expect(results.every((r) => r.status === 200)).toBe(true);
		expect(keys).toEqual(Array.from({ length: 4 }, () => hashOAuthToken(token)));
		// The in-process queue means one process never waits on the database
		// lock with more than one connection per token.
		expect(maxHeld).toBe(1);
	});

	it("leaves other token requests and other paths unlocked", async () => {
		const keys: string[] = [];
		const seen: unknown[] = [];
		const base = await listen(
			serializeRefreshGrants(
				async (req, res) => {
					seen.push((req as IncomingMessage & { body?: unknown }).body);
					res.statusCode = 204;
					res.end();
				},
				createRefreshTokenLock({
					advisory: async (key, fn) => {
						keys.push(key);
						return fn();
					},
				}),
			),
		);
		const code = await fetch(`${base}/api/auth/oauth2/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "grant_type=authorization_code&code=abc",
		});
		expect(code.status).toBe(204);
		expect(seen[0]).toBe("grant_type=authorization_code&code=abc");
		const other = await fetch(`${base}/api/auth/get-session`);
		expect(other.status).toBe(204);
		expect(keys).toEqual([]);
	});

	it("refuses an oversized token request body", async () => {
		const base = await listen(
			serializeRefreshGrants(
				async (_req, res) => {
					res.statusCode = 204;
					res.end();
				},
				createRefreshTokenLock({ advisory: null }),
			),
		);
		const response = await fetch(`${base}/api/auth/oauth2/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: `grant_type=refresh_token&refresh_token=${"a".repeat(70 * 1024)}`,
		});
		expect(response.status).toBe(413);
	});
});

describe("createRefreshTokenLock", () => {
	it("serializes one key and runs different keys in parallel", async () => {
		const lock = createRefreshTokenLock({ advisory: null });
		const events: string[] = [];
		const task = (key: string, name: string) =>
			lock(key, async () => {
				events.push(`start ${name}`);
				await sleep(10);
				events.push(`end ${name}`);
			});
		await Promise.all([task("a", "a1"), task("a", "a2"), task("b", "b1")]);
		expect(events.indexOf("end a1")).toBeLessThan(events.indexOf("start a2"));
		expect(events.indexOf("start b1")).toBeLessThan(events.indexOf("end a1"));
	});

	it("releases the key when the holder throws", async () => {
		const lock = createRefreshTokenLock({ advisory: null });
		await expect(
			lock("k", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(lock("k", async () => "next")).resolves.toBe("next");
	});
});

describe("refreshTokenOfTokenRequest", () => {
	it("reads form and JSON refresh grants only", () => {
		expect(
			refreshTokenOfTokenRequest(
				"application/x-www-form-urlencoded",
				"grant_type=refresh_token&refresh_token=t1",
			),
		).toBe("t1");
		expect(
			refreshTokenOfTokenRequest(
				"application/json",
				JSON.stringify({ grant_type: "refresh_token", refresh_token: "t2" }),
			),
		).toBe("t2");
		expect(
			refreshTokenOfTokenRequest(
				"application/x-www-form-urlencoded",
				"grant_type=authorization_code&code=c",
			),
		).toBeNull();
		expect(
			refreshTokenOfTokenRequest(
				"application/x-www-form-urlencoded",
				"grant_type=refresh_token&refresh_token=",
			),
		).toBeNull();
		expect(refreshTokenOfTokenRequest("application/json", "{bad")).toBeNull();
	});
});

describe("postgres advisory lock pool wait", () => {
	// A stand-in for the 4-connection pool: `begin` hands the callback a
	// transaction once `release()` frees a slot (or at once when `open`).
	const createFakePool = ({ open }: { open: boolean }) => {
		const waiting: Array<() => void> = [];
		const statements: string[] = [];
		let callbacksRun = 0;
		const tx = (strings: TemplateStringsArray) => {
			statements.push(strings.join("?"));
			return Promise.resolve([]);
		};
		const sql = {
			begin: async (callback: (tx: unknown) => Promise<unknown>) => {
				if (!open) await new Promise<void>((resolve) => waiting.push(resolve));
				callbacksRun++;
				return callback(tx);
			},
		};
		return {
			sql: sql as never,
			release: () => {
				for (const resolve of waiting.splice(0)) resolve();
			},
			statements,
			callbacksRun: () => callbacksRun,
		};
	};

	it("falls back to the in-process lock when no connection frees up in time", async () => {
		const pool = createFakePool({ open: false });
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const lock = createPostgresAdvisoryLock({
				getSql: () => pool.sql,
				acquireTimeoutMs: 20,
			});
			const ran = vi.fn(async () => "ran");
			const started = Date.now();
			await expect(lock("k", ran)).resolves.toBe("ran");
			expect(Date.now() - started).toBeLessThan(2_000);
			expect(ran).toHaveBeenCalledTimes(1);
			expect(logged).toHaveBeenCalledWith(
				"[mcp] refresh advisory lock unavailable, using the in-process lock only",
				expect.objectContaining({
					message: expect.stringContaining("no lock connection available"),
				}),
			);

			// The queued transaction gets its slot later: it must not take the
			// advisory lock or run the request a second time.
			pool.release();
			await sleep(20);
			expect(pool.callbacksRun()).toBe(1);
			expect(pool.statements).toEqual([]);
			expect(ran).toHaveBeenCalledTimes(1);
		} finally {
			logged.mockRestore();
		}
	});

	it("takes the advisory lock when a connection is available", async () => {
		const pool = createFakePool({ open: true });
		const lock = createPostgresAdvisoryLock({
			getSql: () => pool.sql,
			acquireTimeoutMs: 20,
		});
		await expect(lock("k", async () => "ran")).resolves.toBe("ran");
		expect(pool.statements).toHaveLength(2);
		expect(pool.statements[1]).toContain("pg_advisory_xact_lock");
	});

	it("does not time out a holder that already has its connection", async () => {
		const pool = createFakePool({ open: true });
		const lock = createPostgresAdvisoryLock({
			getSql: () => pool.sql,
			acquireTimeoutMs: 10,
		});
		const ran = vi.fn(async () => {
			await sleep(50);
			return "slow";
		});
		await expect(lock("k", ran)).resolves.toBe("slow");
		expect(ran).toHaveBeenCalledTimes(1);
	});
});

describe("serializeRefreshGrants hold bound", () => {
	it("releases the lock of a handler that never settles", async () => {
		const token = randomUUID();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		let calls = 0;
		const lock = createRefreshTokenLock({ advisory: null });
		const base = await listen(
			serializeRefreshGrants(
				async (_req, res) => {
					calls++;
					if (calls === 1) return new Promise(() => {}); // never settles
					res.statusCode = 204;
					res.end();
				},
				lock,
				{ maxHoldMs: 50 },
			),
		);
		try {
			// The first request hangs; the second queues behind it and must get
			// its turn once the hold expires.
			void fetch(`${base}/api/auth/oauth2/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: token,
				}).toString(),
			}).catch(() => undefined);
			await sleep(10);
			const second = await fetch(`${base}/api/auth/oauth2/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: token,
				}).toString(),
			});
			expect(second.status).toBe(204);
			expect(calls).toBe(2);
			expect(logged).toHaveBeenCalledWith(
				expect.stringContaining("releasing it"),
			);
		} finally {
			logged.mockRestore();
		}
	});
});
