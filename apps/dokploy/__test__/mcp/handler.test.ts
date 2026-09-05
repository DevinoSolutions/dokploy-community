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
let organizationId: string | null = "org-1";

const { db } = await import("@dokploy/server/db");
const { authenticateMcpBearer, executeMcpTool, unauthorizedPayload } =
	await import("@/server/mcp/handler");
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
