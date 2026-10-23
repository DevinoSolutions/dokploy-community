import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	SECRET_MARK,
	secretApplicationRow,
	secretComposeRow,
	secretPostgresRow,
} from "./fixtures";

const state = vi.hoisted(() => ({
	application: null as unknown,
	compose: null as unknown,
	postgres: null as unknown,
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	return { ...actual, checkServiceAccess: vi.fn(async () => undefined) };
});

vi.mock("@dokploy/server/index", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server/index")>();
	return {
		...actual,
		findApplicationById: vi.fn(async () => state.application),
		findComposeById: vi.fn(async () => state.compose),
		findPostgresById: vi.fn(async () => state.postgres),
	};
});

vi.mock("@dokploy/server/services/git-provider", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/git-provider")
		>();
	return { ...actual, canEditDeployGitSource: vi.fn(async () => true) };
});

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");
const { buildMcpToolRegistry } = await import("@/server/mcp/registry");
const {
	SECRET_READ_PATHS,
	applySecretReadPolicy,
	executeMcpTool,
	makeProcedureCall,
} = await import("@/server/mcp/handler");

const tools = buildMcpToolRegistry(appRouter, { excludeRouters: ["mcp"] });
const tool = (name: string) => {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`missing tool ${name}`);
	return found;
};

const caller = createCallerFactory(appRouter)({
	user: { id: "user-1", email: "u@example.com", role: "member", ownerId: "o" },
	session: { activeOrganizationId: "org-1" },
	req: { headers: {} },
	res: {},
} as never);
const call = makeProcedureCall(caller as never);

const READ = new Set(["dokploy:read"]);
const READ_ADMIN = new Set(["dokploy:read", "dokploy:admin"]);

const run = (name: string, args: unknown, scopes: Set<string>) =>
	executeMcpTool({ tool: tool(name), args, scopes, call });

beforeEach(() => {
	state.application = secretApplicationRow();
	state.compose = secretComposeRow();
	state.postgres = secretPostgresRow();
});

describe("MCP default for the secret-bearing reads", () => {
	it.each([
		["application-one", { applicationId: "app-1" }],
		["compose-one", { composeId: "comp-1" }],
		["postgres-one", { postgresId: "pg-1" }],
	])("%s omits values when includeEnv is not passed", async (name, args) => {
		const result = await run(name, args, READ);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).not.toContain(SECRET_MARK);
		expect(result.structuredContent?.secretsRedacted).toBe(true);
	});

	it("omits values even for a grant with every scope", async () => {
		const result = await run(
			"application-one",
			{ applicationId: "app-1" },
			READ_ADMIN,
		);
		expect(result.content[0]?.text).not.toContain(SECRET_MARK);
	});

	it("ignores includeEnv: true without the administration scope", async () => {
		const result = await run(
			"application-one",
			{ applicationId: "app-1", includeEnv: true },
			READ,
		);
		expect(result.content[0]?.text).not.toContain(SECRET_MARK);
		expect(result.structuredContent?.secretsRedacted).toBe(true);
	});

	it("returns values only for includeEnv: true with dokploy:admin", async () => {
		const result = await run(
			"application-one",
			{ applicationId: "app-1", includeEnv: true },
			READ_ADMIN,
		);
		expect(result.content[0]?.text).toContain("SECRET-env-api");
		expect(result.structuredContent).not.toHaveProperty("secretsRedacted");
	});

	it("treats a non-boolean includeEnv as false", async () => {
		for (const includeEnv of ["true", 1, "yes", null]) {
			const forced = applySecretReadPolicy(
				"compose.one",
				{ composeId: "c", includeEnv },
				READ_ADMIN,
			);
			expect(forced).toEqual({ composeId: "c", includeEnv: false });
		}
	});

	it("forces the flag when the arguments are missing or not an object", () => {
		expect(applySecretReadPolicy("application.one", undefined, READ)).toEqual({
			includeEnv: false,
		});
		expect(applySecretReadPolicy("application.one", [], READ)).toEqual({
			includeEnv: false,
		});
	});

	it("leaves every other tool's arguments untouched", () => {
		const args = { applicationId: "app-1", includeEnv: true };
		expect(applySecretReadPolicy("application.deploy", args, READ_ADMIN)).toBe(
			args,
		);
		expect(applySecretReadPolicy("application.envKeys", args, READ_ADMIN)).toBe(
			args,
		);
	});
});

describe("MCP envKeys tools", () => {
	it("are read-scope queries that return names only", async () => {
		expect(tool("application-envKeys").scope).toBe("dokploy:read");
		expect(tool("compose-envKeys").scope).toBe("dokploy:read");
		const app = await run(
			"application-envKeys",
			{ applicationId: "app-1" },
			READ,
		);
		expect(app.structuredContent).toEqual({
			env: ["API_KEY", "PLAIN"],
			buildArgs: ["NPM_TOKEN"],
			buildSecrets: ["GH_PAT"],
		});
		expect(app.content[0]?.text).not.toContain(SECRET_MARK);
		const stack = await run("compose-envKeys", { composeId: "comp-1" }, READ);
		expect(stack.structuredContent).toEqual({ env: ["DB_PASSWORD"] });
		expect(stack.content[0]?.text).not.toContain(SECRET_MARK);
	});

	it("every path the policy covers is a registered tool that takes includeEnv", () => {
		for (const path of SECRET_READ_PATHS) {
			const name = path.replace(".", "-");
			const properties = tool(name).inputSchema.properties as Record<
				string,
				unknown
			>;
			expect(properties.includeEnv, name).toBeDefined();
		}
	});

	it("advertise includeEnv on the .one tools, with the MCP rule in the schema", () => {
		for (const name of ["application-one", "compose-one", "postgres-one"]) {
			const properties = tool(name).inputSchema.properties as Record<
				string,
				{ type?: string; description?: string }
			>;
			expect(properties.includeEnv?.type, name).toBe("boolean");
			expect(properties.includeEnv?.description, name).toContain(
				"dokploy:admin",
			);
		}
	});
});
