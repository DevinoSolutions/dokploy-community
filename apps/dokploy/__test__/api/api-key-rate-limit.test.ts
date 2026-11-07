import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-15019: a REST/tRPC request carrying `x-api-key` must spend ONE
 * verification (one rate-limit unit of the key), and a key that is over its
 * rate limit must get 429 + Retry-After, not the 401 of an invalid key.
 *
 * better-auth itself is stubbed at the `api` seam (the global instance the
 * server caches), so `verifyApiKey` call counts are the real call counts of
 * the code under test. The error shapes below are the ones
 * @better-auth/api-key 1.7.7 returns from `verifyApiKey`.
 */

const RAW_KEY = "dokploy_SECRETKEYVALUE_do_not_log";
const KEY_ID = "abcdef1234567890";

const verifyApiKey = vi.fn();
const getSession = vi.fn();
(globalThis as unknown as { betterAuthInstance: unknown }).betterAuthInstance =
	{ api: { verifyApiKey, getSession } };

let captureContext: ((opts: unknown) => unknown) | undefined;

vi.mock("@dokploy/trpc-openapi", () => ({
	createOpenApiNextHandler:
		(opts: { createContext: (o: unknown) => unknown }) =>
		async (req: unknown, res: { end: () => void }) => {
			captureContext = opts.createContext;
			await opts.createContext({ req, res });
			res.end();
		},
}));
vi.mock("@trpc/server/adapters/next", () => ({
	createNextApiHandler:
		(opts: { createContext: (o: unknown) => unknown }) =>
		async (req: unknown, res: { end: () => void }) => {
			captureContext = opts.createContext;
			await opts.createContext({ req, res });
			res.end();
		},
}));
vi.mock("@/server/api/root", () => ({ appRouter: {} }));
vi.mock("@/server/sentry", () => ({ captureError: vi.fn() }));

const { db } = await import("@dokploy/server/db");
const { validateRequest } = await import("@dokploy/server/lib/auth");
const { createTRPCContext } = await import("@/server/api/trpc");
const { default: restHandler } = await import("@/pages/api/[...trpc]");
const { default: trpcHandler } = await import("@/pages/api/trpc/[trpc]");

const apikeyFindFirst = vi.mocked(db.query.apikey.findFirst);

const userRow = {
	id: "user-1",
	firstName: "Ada",
	lastName: "L",
	email: "ada@example.com",
	emailVerified: true,
	image: null,
	createdAt: new Date("2026-01-01"),
	updatedAt: new Date("2026-01-02"),
	twoFactorEnabled: false,
	enableEnterpriseFeatures: false,
	isValidEnterpriseLicense: false,
};

const makeReq = (url: string, headers: Record<string, string> = {}) =>
	({
		url,
		method: "GET",
		headers: { "x-api-key": RAW_KEY, ...headers },
	}) as unknown as IncomingMessage & {
		url: string;
	};

const makeRes = () => {
	const headers: Record<string, string> = {};
	const res = {
		statusCode: 200,
		headers,
		body: undefined as unknown,
		setHeader(name: string, value: string) {
			headers[name.toLowerCase()] = value;
		},
		end(chunk?: string) {
			if (chunk !== undefined) res.body = JSON.parse(chunk);
		},
		status(code: number) {
			res.statusCode = code;
			return res;
		},
		json(payload: unknown) {
			res.body = payload;
		},
	};
	return res;
};

/** What the plugin returns while the key is over its limit (tryAgainIn in ms). */
const rateLimited = (tryAgainInMs: number) => ({
	valid: false,
	key: null,
	error: {
		message: "Rate limit exceeded.",
		code: "RATE_LIMITED",
		details: { tryAgainIn: tryAgainInMs },
	},
});

/** What the plugin returns for an unknown key. */
const invalidKey = () => ({
	valid: false,
	key: null,
	error: { message: "Invalid API key.", code: "INVALID_API_KEY" },
});

const validKey = () => ({
	valid: true,
	key: { id: KEY_ID },
	error: null,
});

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
	verifyApiKey.mockReset();
	getSession.mockReset();
	apikeyFindFirst.mockReset();
	warn.mockClear();
	consoleError.mockClear();
	captureContext = undefined;
});

// The mocked db shares one `findFirst` between every table, so the rows are
// served in call order: the apikey row first, then the member row that
// buildMemberSession reads.
const stubValidKeyRows = () => {
	apikeyFindFirst
		.mockResolvedValueOnce({
			id: KEY_ID,
			user: userRow,
			metadata: JSON.stringify({ organizationId: "org-1" }),
		} as never)
		.mockResolvedValue({
			role: "admin",
			organization: { ownerId: "owner-9" },
		} as never);
};

describe("API key verification happens once per request", () => {
	it("REST handler: one verifyApiKey call, context built from that result", async () => {
		verifyApiKey.mockResolvedValue(validKey());
		stubValidKeyRows();
		const res = makeRes();

		await restHandler(
			makeReq("/api/application.one?applicationId=a") as never,
			res as never,
		);

		expect(verifyApiKey).toHaveBeenCalledTimes(1);
		expect(res.statusCode).toBe(200);
		// The handler's createContext reuses the verified identity: calling it
		// again (as the openapi layer does) must not verify again.
		const ctx = (await captureContext?.({
			req: makeReq("/api/application.one"),
			res,
		})) as { user: { id: string }; session: { apiKeyId: string } };
		expect(ctx.user.id).toBe("user-1");
		expect(ctx.session.apiKeyId).toBe(KEY_ID);
		expect(verifyApiKey).toHaveBeenCalledTimes(1);
	});

	it("tRPC handler: one verifyApiKey call per request", async () => {
		verifyApiKey.mockResolvedValue(validKey());
		stubValidKeyRows();
		const res = makeRes();

		await trpcHandler(makeReq("/api/trpc/user.get") as never, res as never);

		expect(verifyApiKey).toHaveBeenCalledTimes(1);
		expect(res.statusCode).toBe(200);
	});
});

describe("a throttled API key answers 429, not 401", () => {
	it("REST handler: 429 + Retry-After + RATE_LIMITED body, one verify, one warn line", async () => {
		verifyApiKey.mockResolvedValue(rateLimited(42_500));
		apikeyFindFirst.mockResolvedValue({ id: KEY_ID } as never);
		const res = makeRes();

		await restHandler(
			makeReq("/api/deployment.queueList?x=1") as never,
			res as never,
		);

		expect(verifyApiKey).toHaveBeenCalledTimes(1);
		expect(res.statusCode).toBe(429);
		expect(res.headers["retry-after"]).toBe("43");
		expect(res.body).toMatchObject({ code: "RATE_LIMITED" });
		expect((res.body as { message: string }).message).toContain("43s");

		expect(warn).toHaveBeenCalledTimes(1);
		const line = String(warn.mock.calls[0]?.[0]);
		expect(line).toContain("keyId=abcdef12");
		expect(line).toContain("route=/api/deployment.queueList");
		expect(line).toContain("retryAfter=43s");
		expect(line).not.toContain(RAW_KEY);
		expect(line).not.toContain(KEY_ID);
	});

	it("tRPC handler: same 429 contract, router never reached", async () => {
		verifyApiKey.mockResolvedValue(rateLimited(1_000));
		apikeyFindFirst.mockResolvedValue({ id: KEY_ID } as never);
		const res = makeRes();

		await trpcHandler(makeReq("/api/trpc/user.get") as never, res as never);

		expect(verifyApiKey).toHaveBeenCalledTimes(1);
		expect(captureContext).toBeUndefined();
		expect(res.statusCode).toBe(429);
		expect(res.headers["retry-after"]).toBe("1");
		expect(res.body).toMatchObject({ code: "RATE_LIMITED" });
	});

	it("falls back to a 1 second Retry-After when the plugin gives no window", async () => {
		verifyApiKey.mockResolvedValue({
			valid: false,
			key: null,
			error: { message: "Rate limit exceeded.", code: "RATE_LIMITED" },
		});
		apikeyFindFirst.mockResolvedValue(undefined as never);
		const res = makeRes();

		await restHandler(makeReq("/api/settings.health") as never, res as never);

		expect(res.statusCode).toBe(429);
		expect(res.headers["retry-after"]).toBe("1");
		expect(String(warn.mock.calls[0]?.[0])).toContain("keyId=unknown");
	});

	it("createTRPCContext (websocket/other callers) throws TOO_MANY_REQUESTS and sets Retry-After", async () => {
		verifyApiKey.mockResolvedValue(rateLimited(5_000));
		apikeyFindFirst.mockResolvedValue({ id: KEY_ID } as never);
		const res = makeRes();

		await expect(
			createTRPCContext({
				req: makeReq("/api/trpc/user.get"),
				res,
			} as never),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
		expect(res.headers["retry-after"]).toBe("5");
		expect(verifyApiKey).toHaveBeenCalledTimes(1);
	});

	it("validateRequest (identity only callers) treats a throttled key as no identity", async () => {
		verifyApiKey.mockResolvedValue(rateLimited(5_000));
		apikeyFindFirst.mockResolvedValue({ id: KEY_ID } as never);

		await expect(validateRequest(makeReq("/ws") as never)).resolves.toEqual({
			session: null,
			user: null,
		});
	});
});

describe("an invalid key is still a 401", () => {
	it("REST handler: 401 Unauthorized, no Retry-After, no throttle log", async () => {
		verifyApiKey.mockResolvedValue(invalidKey());
		const res = makeRes();

		await restHandler(makeReq("/api/application.one") as never, res as never);

		expect(verifyApiKey).toHaveBeenCalledTimes(1);
		expect(res.statusCode).toBe(401);
		expect(res.body).toEqual({ message: "Unauthorized" });
		expect(res.headers["retry-after"]).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});

	it("REST handler: a key with no organization is a 401 too", async () => {
		verifyApiKey.mockResolvedValue(validKey());
		apikeyFindFirst.mockResolvedValue({
			id: KEY_ID,
			user: userRow,
			metadata: "{}",
		} as never);
		const res = makeRes();

		await restHandler(makeReq("/api/application.one") as never, res as never);

		expect(res.statusCode).toBe(401);
		expect(res.headers["retry-after"]).toBeUndefined();
	});

	it("tRPC handler: an invalid key reaches the router unauthenticated (per-procedure checks decide)", async () => {
		verifyApiKey.mockResolvedValue(invalidKey());
		const res = makeRes();

		await trpcHandler(makeReq("/api/trpc/user.get") as never, res as never);

		expect(res.statusCode).toBe(200);
		const ctx = (await captureContext?.({
			req: makeReq("/api/trpc/user.get"),
			res,
		})) as { user: unknown; session: unknown };
		expect(ctx.user).toBeNull();
		expect(ctx.session).toBeNull();
		expect(verifyApiKey).toHaveBeenCalledTimes(1);
	});
});
