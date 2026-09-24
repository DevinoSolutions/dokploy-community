import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/services/mcp-oauth", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/services/mcp-oauth")>();
	return {
		...actual,
		findMcpAccessToken: vi.fn(async () => tokenRow),
		resolveDefaultOrganizationId: vi.fn(async () => organizationId),
	};
});

vi.mock("@dokploy/server/lib/auth", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/lib/auth")>();
	return {
		...actual,
		verifyApiKeyDetailed: vi.fn(async () =>
			apiKeyThrottledFor !== null
				? { status: "rate_limited", retryAfterSeconds: apiKeyThrottledFor }
				: apiKeyResult
					? { status: "valid", member: apiKeyResult }
					: { status: "invalid" },
		),
		buildMemberSession: vi.fn(async (user: { id: string }, orgId: string) => ({
			session: { userId: user.id, activeOrganizationId: orgId },
			user: {
				id: user.id,
				email: "u@example.com",
				role: "owner",
				ownerId: user.id,
			},
		})),
	};
});

let tokenRow: { userId: string; clientId: string; scopes: string[] } | null =
	null;
let apiKeyResult: { session: unknown; user: unknown } | null = null;
let apiKeyThrottledFor: number | null = null;
let organizationId: string | null = "org-1";

const { db } = await import("@dokploy/server/db");
const {
	authenticateMcpBearer,
	authenticateMcpRequest,
	clearMcpApiKeyHandshakeCache,
	describeRejectedMcpRequest,
	invokesTool,
	McpApiKeyRateLimitedError,
	executeMcpTool,
	MCP_API_KEY_CLIENT_ID,
	unauthorizedPayload,
} = await import("@/server/mcp/handler");
const { DOKPLOY_MCP_SCOPE_IDS } = await import(
	"@dokploy/server/services/mcp-oauth"
);
const { verifyApiKeyDetailed } = await import("@dokploy/server/lib/auth");
const findFirst = vi.mocked(db.query.user.findFirst);

const readTool = {
	name: "application-one",
	path: "application.one",
	routerName: "application",
	procedureName: "one",
	type: "query" as const,
	description: "GET /application.one",
	inputSchema: { type: "object" },
	scope: "dokploy:read" as const,
	annotations: {
		title: "application-one",
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
};

describe("unauthorizedPayload", () => {
	it("points at the protected-resource document on the resolved origin", () => {
		const payload = unauthorizedPayload("https://dok.example.com");
		expect(payload.headers["WWW-Authenticate"]).toBe(
			'Bearer resource_metadata="https://dok.example.com/.well-known/oauth-protected-resource"',
		);
		expect(payload.body).toEqual({
			jsonrpc: "2.0",
			error: { code: -32000, message: "Unauthorized: Authentication required" },
			id: null,
		});
	});
});

describe("authenticateMcpBearer", () => {
	beforeEach(() => {
		tokenRow = {
			userId: "user-1",
			clientId: "client-1",
			scopes: ["openid", "dokploy:read"],
		};
		organizationId = "org-1";
		findFirst.mockReset();
		findFirst.mockResolvedValue({ id: "user-1", firstName: "Ada" } as never);
	});

	it("returns null without a bearer header or with an unknown token", async () => {
		expect(await authenticateMcpBearer(undefined)).toBeNull();
		expect(await authenticateMcpBearer("Basic abc")).toBeNull();
		tokenRow = null;
		expect(await authenticateMcpBearer("Bearer nope")).toBeNull();
	});

	it("returns null when the user has no organization membership", async () => {
		organizationId = null;
		expect(await authenticateMcpBearer("Bearer tok")).toBeNull();
	});

	it("synthesizes the member session for the default organization", async () => {
		const auth = await authenticateMcpBearer("Bearer tok");
		expect(auth?.scopes).toEqual(new Set(["openid", "dokploy:read"]));
		expect(auth?.session).toEqual({
			userId: "user-1",
			activeOrganizationId: "org-1",
		});
		expect(auth?.user.id).toBe("user-1");
	});
});

describe("authenticateMcpRequest", () => {
	beforeEach(() => {
		tokenRow = {
			userId: "user-1",
			clientId: "client-1",
			scopes: ["openid", "dokploy:read"],
		};
		organizationId = "org-1";
		apiKeyResult = null;
		apiKeyThrottledFor = null;
		findFirst.mockReset();
		findFirst.mockResolvedValue({ id: "user-1", firstName: "Ada" } as never);
		vi.mocked(verifyApiKeyDetailed).mockClear();
		clearMcpApiKeyHandshakeCache();
	});

	it("falls back to the OAuth bearer when no api key is sent", async () => {
		const auth = await authenticateMcpRequest({ authorization: "Bearer tok" });
		expect(auth?.clientId).toBe("client-1");
		expect(verifyApiKeyDetailed).not.toHaveBeenCalled();
	});

	it("grants every MCP scope to a valid api key without touching the bearer path", async () => {
		apiKeyResult = {
			session: { userId: "user-9", activeOrganizationId: "org-9" },
			user: { id: "user-9", email: "k@example.com", role: "owner" },
		};
		tokenRow = null;
		const auth = await authenticateMcpRequest({
			"x-api-key": "dk_live_1",
			authorization: "Bearer stale",
		});
		expect(auth?.clientId).toBe(MCP_API_KEY_CLIENT_ID);
		expect(auth?.userId).toBe("user-9");
		expect(auth?.session).toEqual({
			userId: "user-9",
			activeOrganizationId: "org-9",
		});
		expect([...(auth?.scopes ?? [])].sort()).toEqual(
			[...DOKPLOY_MCP_SCOPE_IDS].sort(),
		);
		expect(verifyApiKeyDetailed).toHaveBeenCalledWith("dk_live_1");
	});

	it("rejects an unknown api key instead of trying the bearer", async () => {
		const auth = await authenticateMcpRequest({
			"x-api-key": "nope",
			authorization: "Bearer tok",
		});
		expect(auth).toBeNull();
	});

	it("throws a rate-limit error for a throttled api key instead of rejecting it", async () => {
		apiKeyThrottledFor = 42;
		const attempt = authenticateMcpRequest({ "x-api-key": "dk_busy" });
		await expect(attempt).rejects.toBeInstanceOf(McpApiKeyRateLimitedError);
		await expect(attempt).rejects.toMatchObject({ retryAfterSeconds: 42 });
	});

	it("shares one api-key check across a burst of protocol-only requests", async () => {
		apiKeyResult = {
			session: { userId: "user-9", activeOrganizationId: "org-9" },
			user: { id: "user-9", email: "k@example.com", role: "owner" },
		};
		const burst = await Promise.all(
			Array.from({ length: 50 }, () =>
				authenticateMcpRequest(
					{ "x-api-key": "dk_fleet" },
					{ countsAgainstRateLimit: false },
				),
			),
		);
		expect(burst.every((auth) => auth?.userId === "user-9")).toBe(true);
		const later = await authenticateMcpRequest(
			{ "x-api-key": "dk_fleet" },
			{ countsAgainstRateLimit: false },
		);
		expect(later?.userId).toBe("user-9");
		expect(verifyApiKeyDetailed).toHaveBeenCalledTimes(1);
	});

	it("marks every request but the one that ran the shared check as reused", async () => {
		apiKeyResult = {
			session: { userId: "user-9", activeOrganizationId: "org-9" },
			user: { id: "user-9", email: "k@example.com", role: "owner" },
		};
		const burst = await Promise.all(
			Array.from({ length: 5 }, () =>
				authenticateMcpRequest(
					{ "x-api-key": "dk_fleet" },
					{ countsAgainstRateLimit: false },
				),
			),
		);
		expect(verifyApiKeyDetailed).toHaveBeenCalledTimes(1);
		expect(burst.filter((auth) => !auth?.reusedVerification)).toHaveLength(1);
		const cached = await authenticateMcpRequest(
			{ "x-api-key": "dk_fleet" },
			{ countsAgainstRateLimit: false },
		);
		expect(cached?.reusedVerification).toBe(true);
		const counted = await authenticateMcpRequest({ "x-api-key": "dk_fleet" });
		expect(counted?.reusedVerification).toBeUndefined();
	});

	it("keeps serving protocol traffic from a recent check while the key is throttled", async () => {
		apiKeyResult = {
			session: { userId: "user-9", activeOrganizationId: "org-9" },
			user: { id: "user-9", email: "k@example.com", role: "owner" },
		};
		await authenticateMcpRequest({ "x-api-key": "dk_fleet" });
		apiKeyThrottledFor = 30;
		const handshake = await authenticateMcpRequest(
			{ "x-api-key": "dk_fleet" },
			{ countsAgainstRateLimit: false },
		);
		expect(handshake?.userId).toBe("user-9");
		await expect(
			authenticateMcpRequest({ "x-api-key": "dk_fleet" }),
		).rejects.toBeInstanceOf(McpApiKeyRateLimitedError);
	});

	it("always re-verifies tool calls and drops the reuse once the key is revoked", async () => {
		apiKeyResult = {
			session: { userId: "user-9", activeOrganizationId: "org-9" },
			user: { id: "user-9", email: "k@example.com", role: "owner" },
		};
		await authenticateMcpRequest({ "x-api-key": "dk_fleet" });
		await authenticateMcpRequest({ "x-api-key": "dk_fleet" });
		expect(verifyApiKeyDetailed).toHaveBeenCalledTimes(2);

		apiKeyResult = null;
		expect(
			await authenticateMcpRequest({ "x-api-key": "dk_fleet" }),
		).toBeNull();
		expect(
			await authenticateMcpRequest(
				{ "x-api-key": "dk_fleet" },
				{ countsAgainstRateLimit: false },
			),
		).toBeNull();
		expect(verifyApiKeyDetailed).toHaveBeenCalledTimes(4);
	});

	it("never reuses a check made for a different key", async () => {
		apiKeyResult = {
			session: { userId: "user-9", activeOrganizationId: "org-9" },
			user: { id: "user-9", email: "k@example.com", role: "owner" },
		};
		await authenticateMcpRequest(
			{ "x-api-key": "dk_fleet" },
			{ countsAgainstRateLimit: false },
		);
		apiKeyResult = null;
		expect(
			await authenticateMcpRequest(
				{ "x-api-key": "dk_other" },
				{ countsAgainstRateLimit: false },
			),
		).toBeNull();
	});

	it("classifies rejected requests without leaking the token", () => {
		expect(describeRejectedMcpRequest({})).toBe("no_credentials");
		expect(describeRejectedMcpRequest({ "x-api-key": "k" })).toBe(
			"api_key_invalid",
		);
		expect(describeRejectedMcpRequest({ authorization: "Basic x" })).toBe(
			"not_bearer",
		);
		expect(describeRejectedMcpRequest({ authorization: "Bearer " })).toBe(
			"empty_bearer",
		);
		expect(
			describeRejectedMcpRequest({
				authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
			}),
		).toBe("bearer_rejected tokenPrefix=abcdefgh");
	});
});

describe("invokesTool", () => {
	it("treats handshake and listing traffic as protocol-only", () => {
		expect(invokesTool({ jsonrpc: "2.0", id: 1, method: "initialize" })).toBe(
			false,
		);
		expect(
			invokesTool({ jsonrpc: "2.0", method: "notifications/initialized" }),
		).toBe(false);
		expect(invokesTool({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toBe(
			false,
		);
	});

	it("flags tool calls, including inside a batch, and unparseable shapes", () => {
		expect(invokesTool({ jsonrpc: "2.0", id: 3, method: "tools/call" })).toBe(
			true,
		);
		expect(
			invokesTool([
				{ jsonrpc: "2.0", id: 4, method: "tools/list" },
				{ jsonrpc: "2.0", id: 5, method: "tools/call" },
			]),
		).toBe(true);
		expect(invokesTool(null)).toBe(true);
		expect(invokesTool("tools/list")).toBe(true);
	});
});

describe("executeMcpTool", () => {
	it("refuses a tool outside the granted scopes without calling the procedure", async () => {
		const call = vi.fn();
		const result = await executeMcpTool({
			tool: readTool,
			args: {},
			scopes: new Set(["dokploy:deploy"]),
			call,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain(
			"dokploy:read",
		);
		expect(call).not.toHaveBeenCalled();
	});

	it("returns the procedure result as text and structuredContent", async () => {
		const call = vi.fn(async () => ({ applicationId: "app-1" }));
		const result = await executeMcpTool({
			tool: readTool,
			args: { applicationId: "app-1" },
			scopes: new Set(["dokploy:read"]),
			call,
		});
		expect(call).toHaveBeenCalledWith("application.one", {
			applicationId: "app-1",
		});
		expect(result.isError).toBeUndefined();
		expect((result.content[0] as { text: string }).text).toBe(
			JSON.stringify({ applicationId: "app-1" }),
		);
		expect(result.structuredContent).toEqual({ applicationId: "app-1" });
	});

	it("serializes bigint columns as strings instead of throwing", async () => {
		const call = vi.fn(async () => ({ id: "app-1", bytes: 9007199254740993n }));
		const result = await executeMcpTool({
			tool: readTool,
			args: {},
			scopes: new Set(["dokploy:read"]),
			call,
		});
		expect(result.isError).toBeUndefined();
		expect((result.content[0] as { text: string }).text).toBe(
			'{"id":"app-1","bytes":"9007199254740993"}',
		);
		expect(result.structuredContent).toEqual({
			id: "app-1",
			bytes: "9007199254740993",
		});
	});

	it("maps TRPCError to an error result with CODE: message", async () => {
		const call = vi.fn(async () => {
			throw new TRPCError({ code: "UNAUTHORIZED", message: "nope" });
		});
		const result = await executeMcpTool({
			tool: readTool,
			args: {},
			scopes: new Set(["dokploy:read"]),
			call,
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toBe(
			"UNAUTHORIZED: nope",
		);
	});

	it("hides unexpected exception details", async () => {
		const call = vi.fn(async () => {
			throw new Error("postgres password is hunter2");
		});
		const result = await executeMcpTool({
			tool: readTool,
			args: {},
			scopes: new Set(["dokploy:read"]),
			call,
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).not.toContain(
			"hunter2",
		);
	});
});
