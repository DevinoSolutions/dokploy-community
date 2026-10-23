import {
	redactToolResult,
	scrubSecretsInText,
} from "@dokploy/server/services/service-secrets";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SECRET_MARK, secretPostgresRow } from "./fixtures";

const state = vi.hoisted(() => ({ postgres: null as unknown }));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	return { ...actual, checkServiceAccess: vi.fn(async () => undefined) };
});

vi.mock("@dokploy/server/index", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server/index")>();
	return { ...actual, findPostgresById: vi.fn(async () => state.postgres) };
});

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");
const { buildMcpToolRegistry } = await import("@/server/mcp/registry");
const {
	CREDENTIAL_RESULT_PATHS,
	executeMcpTool,
	guardSecretWriteBack,
	makeProcedureCall,
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

const READ = new Set(["dokploy:read"]);
const WRITE = new Set(["dokploy:read", "dokploy:services:write"]);
const WRITE_ADMIN = new Set([
	"dokploy:read",
	"dokploy:services:write",
	"dokploy:admin",
]);
const ADMIN = new Set(["dokploy:read", "dokploy:admin"]);

beforeEach(() => {
	state.postgres = secretPostgresRow();
});

describe("swarm join tokens", () => {
	const joinCommand = {
		command: "docker swarm join --token SWMTKN-1-secretvalue 10.0.0.1:2377",
	};

	it("cluster.addWorker and cluster.addManager are admin-scope credential reads", () => {
		for (const name of ["cluster-addWorker", "cluster-addManager"]) {
			expect(tool(name).scope, name).toBe("dokploy:admin");
		}
		expect(CREDENTIAL_RESULT_PATHS.has("cluster.addWorker")).toBe(true);
		expect(CREDENTIAL_RESULT_PATHS.has("cluster.addManager")).toBe(true);
	});

	it("refuses a read-scope grant without calling the procedure", async () => {
		const call = vi.fn(async () => joinCommand);
		const result = await executeMcpTool({
			tool: tool("cluster-addWorker"),
			args: {},
			scopes: READ,
			call,
		});
		expect(result.isError).toBe(true);
		expect(call).not.toHaveBeenCalled();
		expect(result.content[0]?.text).not.toContain("SWMTKN");
	});

	it("returns the command raw to an admin", async () => {
		const result = await executeMcpTool({
			tool: tool("cluster-addManager"),
			args: {},
			scopes: ADMIN,
			call: async () => joinCommand,
		});
		expect(result.content[0]?.text).toContain("SWMTKN-1-secretvalue");
	});
});

describe("raw inspect output", () => {
	const inspect = {
		Id: "abc",
		Name: "/web",
		Config: {
			Image: "nginx",
			Env: ["API_KEY=SECRET-env", "EMPTY=", "NOEQUALS", "PATH=/usr/bin"],
			Labels: { "com.example": "x" },
		},
		ContainerConfig: { Env: ["DB_PASSWORD=SECRET-db"] },
		Nested: [{ deeper: { ENV: ["TOKEN=SECRET-deep"] } }],
	};

	it("docker.getConfig and dockerImage.getImageConfig need dokploy:admin", () => {
		expect(tool("docker-getConfig").scope).toBe("dokploy:admin");
		expect(tool("dockerImage-getImageConfig").scope).toBe("dokploy:admin");
		expect(CREDENTIAL_RESULT_PATHS.has("docker.getConfig")).toBe(false);
	});

	it("blanks Env values to KEY= for an admin and keeps the names", async () => {
		const result = await executeMcpTool({
			tool: tool("docker-getConfig"),
			args: { containerId: "abc" },
			scopes: ADMIN,
			call: async () => inspect,
		});
		expect(result.content[0]?.text).not.toContain(SECRET_MARK);
		const body = result.structuredContent as {
			Id: string;
			Config: { Env: string[]; Image: string; Labels: unknown };
			ContainerConfig: { Env: string[] };
			Nested: Array<{ deeper: { ENV: string[] } }>;
			secretsRedacted?: boolean;
		};
		expect(body.Config.Env).toEqual([
			"API_KEY=",
			"EMPTY=",
			"NOEQUALS",
			"PATH=",
		]);
		expect(body.ContainerConfig.Env).toEqual(["DB_PASSWORD="]);
		expect(body.Nested[0]?.deeper.ENV).toEqual(["TOKEN="]);
		expect(body.Id).toBe("abc");
		expect(body.Config.Image).toBe("nginx");
		expect(body.Config.Labels).toEqual({ "com.example": "x" });
		expect(body.secretsRedacted).toBe(true);
	});

	it("matches secret keys case-insensitively", () => {
		const out = redactToolResult({
			Password: "SECRET-1",
			TOKEN: "SECRET-2",
			Token: "SECRET-3",
			ApiKey: "SECRET-4",
			nested: { SecretAccessKey: "SECRET-5", Name: "keep" },
		}) as Record<string, unknown>;
		expect(JSON.stringify(out)).not.toContain(SECRET_MARK);
		expect((out.nested as { Name: string }).Name).toBe("keep");
	});

	it("leaves an Env array with no values as is", () => {
		const input = { Env: ["A=", "B"] };
		expect(redactToolResult(input)).toBe(input);
	});
});

describe("write-back guard", () => {
	const run = (
		name: string,
		args: unknown,
		scopes: Set<string>,
		call = vi.fn(async () => ({ ok: true })),
	) => ({
		call,
		promise: executeMcpTool({ tool: tool(name), args, scopes, call }),
	});

	it("refuses saveEnvironment with an empty env", async () => {
		const { call, promise } = run(
			"application-saveEnvironment",
			{ applicationId: "app-1", env: "" },
			WRITE,
		);
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(call).not.toHaveBeenCalled();
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("BAD_REQUEST");
		expect(text).toContain("`env`");
		expect(text).toContain("redacted");
		expect(text).toContain("envKeys");
		expect(text).toContain("allowEmptySecrets");
		expect(text).toContain("dokploy:admin");
	});

	it("refuses application.update that empties env or sets buildArgs to spaces", async () => {
		for (const args of [
			{ applicationId: "app-1", env: "" },
			{ applicationId: "app-1", buildArgs: " " },
			{ applicationId: "app-1", name: "ok", previewEnv: "\n" },
		]) {
			const { call, promise } = run("application-update", args, WRITE);
			const result = await promise;
			expect(result.isError, JSON.stringify(args)).toBe(true);
			expect(call).not.toHaveBeenCalled();
		}
	});

	it("is case-insensitive and also looks one object level down", () => {
		const base = {
			name: "application-update",
			type: "mutation" as const,
			procedureName: "update",
		};
		expect(guardSecretWriteBack(base, { Password: "" }, WRITE).error).toContain(
			"`Password`",
		);
		expect(
			guardSecretWriteBack(base, { row: { env: "" } }, WRITE).error,
		).toContain("`env`");
		expect(
			guardSecretWriteBack(base, { a: { b: { env: "" } } }, WRITE).error,
		).toBeUndefined();
	});

	it("honours allowEmptySecrets for an admin and strips it before the call", async () => {
		const { call, promise } = run(
			"application-saveEnvironment",
			{ applicationId: "app-1", env: "", allowEmptySecrets: true },
			WRITE_ADMIN,
		);
		const result = await promise;
		expect(result.isError).toBeUndefined();
		expect(call).toHaveBeenCalledWith("application.saveEnvironment", {
			applicationId: "app-1",
			env: "",
		});
	});

	it("ignores allowEmptySecrets without dokploy:admin", async () => {
		const { call, promise } = run(
			"application-saveEnvironment",
			{ applicationId: "app-1", env: "", allowEmptySecrets: true },
			WRITE,
		);
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(call).not.toHaveBeenCalled();
	});

	it("still accepts non-secret empty fields, real values and creates", async () => {
		const empty = run(
			"application-update",
			{ applicationId: "app-1", description: "", env: "A=1" },
			WRITE,
		);
		expect((await empty.promise).isError).toBeUndefined();
		expect(empty.call).toHaveBeenCalledWith("application.update", {
			applicationId: "app-1",
			description: "",
			env: "A=1",
		});
		const created = run(
			"project-create",
			{ name: "p", description: "", env: "" },
			new Set(["dokploy:projects:write"]),
		);
		expect((await created.promise).isError).toBeUndefined();
	});

	it("does not inspect queries", async () => {
		const { call, promise } = run(
			"application-envKeys",
			{ applicationId: "app-1", env: "" },
			READ,
		);
		expect((await promise).isError).toBeUndefined();
		expect(call).toHaveBeenCalled();
	});

	it("tells the model saveEnvironment replaces the whole env", () => {
		for (const name of [
			"application-saveEnvironment",
			"compose-saveEnvironment",
			"postgres-saveEnvironment",
		]) {
			expect(tool(name).description, name).toContain("Replaces the entire env");
		}
		expect(tool("application-update").description).not.toContain(
			"Replaces the entire env",
		);
	});
});

describe("error scrubbing", () => {
	const failWith = (message: string) =>
		executeMcpTool({
			tool: tool("application-one"),
			args: { applicationId: "app-1" },
			scopes: READ,
			call: async () => {
				throw new TRPCError({ code: "BAD_REQUEST", message });
			},
		});

	it("scrubs URL userinfo, token flags and token assignments", async () => {
		const result = await failWith(
			"clone of https://ci:hunter2@git.example.com/o/r.git failed: docker swarm join --token SWMTKN-xyz 10.0.0.1:2377 api_key=abc123 password='p w'",
		);
		const text = result.content[0]?.text ?? "";
		expect(result.isError).toBe(true);
		for (const secret of ["hunter2", "SWMTKN-xyz", "abc123", "p w"]) {
			expect(text).not.toContain(secret);
		}
		expect(text).toContain("https://***@git.example.com/o/r.git");
		expect(text).toContain("--token ***");
		expect(text).toContain("BAD_REQUEST");
	});

	it("leaves ordinary messages alone", () => {
		for (const text of [
			"password: too short",
			"Application not found",
			"git@github.com:org/repo.git is not reachable",
			"https://example.com/path is down",
		]) {
			expect(scrubSecretsInText(text)).toBe(text);
		}
	});

	it("scrubs a token=value pair and a --token=value flag", () => {
		expect(scrubSecretsInText("retry with token=abcdef now")).toBe(
			"retry with token=*** now",
		);
		expect(scrubSecretsInText("run x --token=abcdef")).toBe(
			"run x --token=***",
		);
	});
});

describe("database envKeys", () => {
	it("is a read-scope, names-only tool for all six databases", async () => {
		for (const db of [
			"postgres",
			"mysql",
			"mariadb",
			"mongo",
			"redis",
			"libsql",
		]) {
			expect(tool(`${db}-envKeys`).scope, db).toBe("dokploy:read");
		}
		state.postgres = { ...secretPostgresRow(), env: "A=SECRET-1\nB=SECRET-2" };
		const result = await executeMcpTool({
			tool: tool("postgres-envKeys"),
			args: { postgresId: "pg-1" },
			scopes: READ,
			call: makeProcedureCall(caller as never),
		});
		expect(result.structuredContent).toEqual({ env: ["A", "B"] });
		expect(result.content[0]?.text).not.toContain(SECRET_MARK);
	});

	it("uses the organization check of postgres.one", async () => {
		const foreign = secretPostgresRow();
		foreign.environment.project.organizationId = "org-other";
		state.postgres = foreign;
		await expect(
			caller.postgres.envKeys({ postgresId: "pg-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
