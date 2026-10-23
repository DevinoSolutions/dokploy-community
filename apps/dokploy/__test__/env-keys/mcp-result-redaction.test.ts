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
	environment: null as unknown,
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
		findEnvironmentById: vi.fn(async () => state.environment),
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
	CREDENTIAL_RESULT_PATHS,
	executeMcpTool,
	makeProcedureCall,
	shouldRedactResult,
} = await import("@/server/mcp/handler");

const tools = buildMcpToolRegistry(appRouter, { excludeRouters: ["mcp"] });
const tool = (name: string) => {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`missing tool ${name}`);
	return found;
};

const caller = createCallerFactory(appRouter)({
	user: { id: "user-1", email: "u@example.com", role: "owner", ownerId: "o" },
	session: { activeOrganizationId: "org-1" },
	req: { headers: {} },
	res: {},
} as never);
const call = makeProcedureCall(caller as never);

const READ = new Set(["dokploy:read"]);
const READ_ADMIN = new Set(["dokploy:read", "dokploy:admin"]);

const run = (name: string, args: unknown, scopes: Set<string>) =>
	executeMcpTool({ tool: tool(name), args, scopes, call });

const environmentRow = () => ({
	environmentId: "env-1",
	name: "production",
	projectId: "proj-1",
	env: "ENV_LEVEL=SECRET-environment-env",
	project: {
		projectId: "proj-1",
		name: "Shop",
		organizationId: "org-1",
		env: "PROJECT_LEVEL=SECRET-project-env",
	},
	applications: [secretApplicationRow()],
	compose: [secretComposeRow()],
	postgres: [secretPostgresRow()],
});

beforeEach(() => {
	state.application = secretApplicationRow();
	state.compose = secretComposeRow();
	state.postgres = secretPostgresRow();
	state.environment = environmentRow();
});

describe("environment.one through MCP", () => {
	it("returns its services with blank env and no secret anywhere", async () => {
		const result = await run(
			"environment-one",
			{ environmentId: "env-1" },
			READ,
		);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).not.toContain(SECRET_MARK);
		const body = result.structuredContent as {
			name: string;
			env: string;
			secretsRedacted?: boolean;
			applications: Array<{ env: string; name: string; registry: unknown }>;
			compose: Array<{ env: string }>;
		};
		expect(body.secretsRedacted).toBe(true);
		expect(body.env).toBe("");
		expect(body.applications[0]?.env).toBe("");
		expect(body.applications[0]?.registry).toMatchObject({ password: "" });
		expect(body.compose[0]?.env).toBe("");
	});

	it("leaves non-secret fields untouched", async () => {
		const result = await run(
			"environment-one",
			{ environmentId: "env-1" },
			READ,
		);
		const body = result.structuredContent as {
			name: string;
			applications: Array<{ name: string; appName: string }>;
		};
		expect(body.name).toBe("production");
		expect(body.applications[0]?.name).toBe("Web");
		expect(body.applications[0]?.appName).toBe("web-abc");
	});

	it("still blanks them for an admin: there is no includeEnv on this route", async () => {
		const result = await run(
			"environment-one",
			{ environmentId: "env-1", includeEnv: true },
			READ_ADMIN,
		);
		expect(result.content[0]?.text).not.toContain(SECRET_MARK);
		expect(result.structuredContent?.secretsRedacted).toBe(true);
	});

	it("the dashboard caller (no MCP dispatch) is unchanged", async () => {
		const direct = await caller.environment.one({ environmentId: "env-1" });
		expect(JSON.stringify(direct)).toContain("SECRET-environment-env");
	});
});

describe("generic redaction of any other route's result", () => {
	const runStub = (path: string, value: unknown, scopes = READ) =>
		executeMcpTool({
			tool: tool(path.replace(".", "-")),
			args: {},
			scopes,
			call: async () => value,
		});

	it("blanks project.one's env and the environments nested in it", async () => {
		const result = await runStub("project.one", {
			projectId: "proj-1",
			name: "Shop",
			env: "PROJECT_LEVEL=SECRET-project-env",
			environments: [environmentRow()],
		});
		expect(result.content[0]?.text).not.toContain(SECRET_MARK);
		const body = result.structuredContent as {
			name: string;
			env: string;
			environments: Array<{ env: string }>;
		};
		expect(body.name).toBe("Shop");
		expect(body.env).toBe("");
		expect(body.environments[0]?.env).toBe("");
	});

	it("blanks a nested registry password in an array result", async () => {
		const result = await runStub("project.all", [
			{
				name: "Shop",
				applications: [
					{ registry: { registryUrl: "r.io", password: "SECRET-r" } },
				],
			},
		]);
		expect(result.content[0]?.text).not.toContain(SECRET_MARK);
		expect(result.content[0]?.text).toContain("r.io");
	});

	it("blanks them for an admin too, except on a credential tool", async () => {
		const row = { sshKeyId: "k", privateKey: "SECRET-private" };
		const generic = await runStub("environment.byProjectId", [row], READ_ADMIN);
		expect(generic.content[0]?.text).not.toContain(SECRET_MARK);
		const credential = await runStub("sshKey.one", row, READ_ADMIN);
		expect(credential.content[0]?.text).toContain("SECRET-private");
	});
});

describe("admin opt-in on .one", () => {
	it("returns values for includeEnv: true with dokploy:admin", async () => {
		const result = await run(
			"application-one",
			{ applicationId: "app-1", includeEnv: true },
			READ_ADMIN,
		);
		expect(result.content[0]?.text).toContain("SECRET-env-api");
		expect(result.structuredContent).not.toHaveProperty("secretsRedacted");
	});

	it("reports the downgrade through secretsRedacted when the grant lacks admin", async () => {
		for (const [name, args] of [
			["application-one", { applicationId: "app-1", includeEnv: true }],
			["compose-one", { composeId: "comp-1", includeEnv: true }],
			["postgres-one", { postgresId: "pg-1", includeEnv: true }],
		] as const) {
			const result = await run(name, args, READ);
			expect(result.content[0]?.text, name).not.toContain(SECRET_MARK);
			expect(result.structuredContent?.secretsRedacted, name).toBe(true);
		}
	});
});

describe("credential tool exemptions", () => {
	it("every exempt path is a registered admin-scope tool", () => {
		const byPath = new Map(tools.map((entry) => [entry.path, entry]));
		for (const path of CREDENTIAL_RESULT_PATHS) {
			const entry = byPath.get(path);
			expect(entry, path).toBeDefined();
			expect(entry?.scope, path).toBe("dokploy:admin");
		}
	});

	it("exempts the minting mutations and none of the service reads", () => {
		for (const path of [
			"user.createApiKey",
			"user.generateToken",
			"scim.generateToken",
			"scim.rotateToken",
			"sshKey.generate",
		]) {
			expect(CREDENTIAL_RESULT_PATHS.has(path), path).toBe(true);
		}
		for (const path of [
			"application.one",
			"compose.one",
			"environment.one",
			"project.one",
			"project.all",
			"application.refreshToken",
		]) {
			expect(shouldRedactResult(path, { includeEnv: false }), path).toBe(true);
		}
		expect(shouldRedactResult("application.one", { includeEnv: true })).toBe(
			false,
		);
		expect(shouldRedactResult("environment.one", { includeEnv: true })).toBe(
			true,
		);
	});
});
