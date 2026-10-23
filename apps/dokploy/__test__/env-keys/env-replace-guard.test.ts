import { mergeEnvText } from "@dokploy/server/services/env-merge";
import {
	blankEnvArray,
	redactToolResult,
} from "@dokploy/server/services/service-secrets";
import { describe, expect, it, vi } from "vitest";

const { appRouter } = await import("@/server/api/root");
const { buildMcpToolRegistry } = await import("@/server/mcp/registry");
const { executeMcpTool, guardSecretWriteBack } = await import(
	"@/server/mcp/handler"
);

const tools = buildMcpToolRegistry(appRouter, { excludeRouters: ["mcp"] });
const tool = (name: string) => {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`missing tool ${name}`);
	return found;
};

const WRITE = new Set(["dokploy:read", "dokploy:services:write"]);
const WRITE_ADMIN = new Set([...WRITE, "dokploy:admin"]);

const SECRET_A = "SECRET-value-a";
const SECRET_B = "SECRET-value-b";
const SECRET_BUILD = "SECRET-build-arg";

const BLOCK_FIELDS = ["env", "buildArgs", "buildSecrets"];

const keysOf = (text: unknown) =>
	typeof text === "string"
		? text
				.split("\n")
				.map((line) => line.split("=")[0] as string)
				.filter(Boolean)
		: undefined;

/** A caller whose envKeys / one reads come from `stored`; every call is recorded. */
const makeCall = (stored: Record<string, unknown>) =>
	vi.fn(async (path: string, _args: unknown) => {
		if (path.endsWith(".envKeys")) {
			return Object.fromEntries(
				Object.entries(stored)
					.filter(([field]) => BLOCK_FIELDS.includes(field))
					.map(([field, text]) => [field, keysOf(text)]),
			);
		}
		if (path.endsWith(".one")) return { ...stored };
		return true;
	});

const writesOf = (call: ReturnType<typeof makeCall>) =>
	call.mock.calls.filter(([path]) => path.endsWith(".saveEnvironment"));

const appStored = {
	applicationId: "app-1",
	env: `A=${SECRET_A}\nB=${SECRET_B}\n`,
	buildArgs: `ARG=${SECRET_BUILD}\n`,
	buildSecrets: "",
};

const run = (
	name: string,
	args: unknown,
	stored: Record<string, unknown> = appStored,
	scopes = WRITE,
) => {
	const call = makeCall(stored);
	return {
		call,
		promise: executeMcpTool({ tool: tool(name), args, scopes, call }),
	};
};

describe("MCP saveEnvironment drop guard (T-7007)", () => {
	it("refuses a call that drops existing keys, naming them but not their values", async () => {
		const { call, promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "NEW=1",
			buildArgs: "ARG=y",
			buildSecrets: "",
		});
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(writesOf(call)).toHaveLength(0);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("would drop 2 existing variable(s)");
		expect(text).toContain("env: A, B");
		expect(text).toContain("mergeEnv");
		expect(text).toContain("replaceAll");
		for (const secret of [SECRET_A, SECRET_B, SECRET_BUILD]) {
			expect(text).not.toContain(secret);
		}
	});

	it("also checks buildArgs", async () => {
		const { promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "A=1\nB=2",
			buildArgs: "OTHER=1",
			buildSecrets: "",
		});
		const text = (await promise).content[0]?.text ?? "";
		expect(text).toContain("would drop 1 existing variable(s)");
		expect(text).toContain("buildArgs: ARG");
	});

	it("allows replaceAll and strips it before the procedure", async () => {
		const { call, promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "NEW=1",
			buildArgs: "ARG2=1",
			buildSecrets: "",
			replaceAll: true,
		});
		const result = await promise;
		expect(result.isError).toBeUndefined();
		expect(writesOf(call)).toHaveLength(1);
		expect(call).toHaveBeenCalledWith("application.saveEnvironment", {
			applicationId: "app-1",
			env: "NEW=1",
			buildArgs: "ARG2=1",
			buildSecrets: "",
		});
	});

	it("allows adding a key while keeping every existing key", async () => {
		const { call, promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "A=1\nB=x\nC=3",
			buildArgs: "ARG=y",
			buildSecrets: "",
		});
		expect((await promise).isError).toBeUndefined();
		expect(writesOf(call)).toHaveLength(1);
	});

	it.each([
		["compose-saveEnvironment", "composeId"],
		["postgres-saveEnvironment", "postgresId"],
		["mysql-saveEnvironment", "mysqlId"],
		["mariadb-saveEnvironment", "mariadbId"],
		["mongo-saveEnvironment", "mongoId"],
		["redis-saveEnvironment", "redisId"],
		["libsql-saveEnvironment", "libsqlId"],
	])("covers %s", async (name, idField) => {
		const stored = {
			[idField]: "svc-1",
			env: `K1=${SECRET_A}\nK2=${SECRET_B}\n`,
		};
		const refused = run(name, { [idField]: "svc-1", env: "K1=1" }, stored);
		const result = await refused.promise;
		expect(result.isError).toBe(true);
		expect(writesOf(refused.call)).toHaveLength(0);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("would drop 1 existing variable(s)");
		expect(text).toContain("env: K2");
		expect(text).not.toContain(SECRET_A);
		expect(text).not.toContain(SECRET_B);

		const kept = run(
			name,
			{ [idField]: "svc-1", env: "K1=1\nK2=2\nK3=3" },
			stored,
		);
		expect((await kept.promise).isError).toBeUndefined();
		expect(writesOf(kept.call)).toHaveLength(1);
	});

	it("leaves the dashboard path alone: the procedure input has no MCP flags", () => {
		// The guard lives in executeMcpTool; the router procedure itself never
		// sees replaceAll/mergeEnv/unsetKeys and keeps replacing the whole env.
		const procedure = (
			appRouter._def.procedures as unknown as Record<
				string,
				{ _def: { inputs: Array<{ shape: Record<string, unknown> }> } }
			>
		)["application.saveEnvironment"];
		const shape = procedure?._def.inputs[0]?.shape ?? {};
		expect(shape).toHaveProperty("env");
		for (const field of ["replaceAll", "mergeEnv", "unsetKeys"]) {
			expect(shape).not.toHaveProperty(field);
		}
	});

	it("adds the flags to the saveEnvironment tool schema and description only", () => {
		const schema = tool("application-saveEnvironment").inputSchema as {
			properties: Record<string, unknown>;
		};
		for (const field of ["replaceAll", "mergeEnv", "unsetKeys"]) {
			expect(schema.properties).toHaveProperty(field);
		}
		expect(tool("application-saveEnvironment").description).toContain(
			"mergeEnv: true",
		);
		const update = tool("application-update").inputSchema as {
			properties: Record<string, unknown>;
		};
		expect(update.properties).not.toHaveProperty("mergeEnv");
	});

	it("keeps refusing an empty env", async () => {
		const { call, promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "",
		});
		expect((await promise).isError).toBe(true);
		expect(writesOf(call)).toHaveLength(0);
	});

	it("an admin clearing the env on purpose needs allowEmptySecrets and replaceAll", async () => {
		const only = run(
			"application-saveEnvironment",
			{
				applicationId: "app-1",
				env: "",
				buildArgs: "x=1",
				buildSecrets: "",
				allowEmptySecrets: true,
			},
			appStored,
			WRITE_ADMIN,
		);
		expect((await only.promise).isError).toBe(true);
		const both = run(
			"application-saveEnvironment",
			{
				applicationId: "app-1",
				env: "",
				buildArgs: "",
				buildSecrets: "",
				allowEmptySecrets: true,
				replaceAll: true,
			},
			appStored,
			WRITE_ADMIN,
		);
		expect((await both.promise).isError).toBeUndefined();
		expect(both.call).toHaveBeenCalledWith("application.saveEnvironment", {
			applicationId: "app-1",
			env: "",
			buildArgs: "",
			buildSecrets: "",
		});
	});

	it("fails closed when the current names cannot be read", async () => {
		const call = vi.fn(async () => ({ ok: true }));
		const result = await executeMcpTool({
			tool: tool("application-saveEnvironment"),
			args: {
				applicationId: "app-1",
				env: "A=1",
				buildArgs: "B=1",
				buildSecrets: "C=1",
			},
			scopes: WRITE,
			call,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("could not read");
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("accepts empty blocks that have nothing stored, so a plain save works", async () => {
		const { call, promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "A=1\nB=2\nC=3",
			buildArgs: "ARG=1",
			buildSecrets: "",
		});
		expect((await promise).isError).toBeUndefined();
		expect(writesOf(call)).toHaveLength(1);
	});

	it("still refuses an empty block that has variables stored", async () => {
		const { call, promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "A=1\nB=2",
			buildArgs: "",
			buildSecrets: "",
		});
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("`buildArgs`");
		expect(writesOf(call)).toHaveLength(0);
	});
});

describe("MCP saveEnvironment merge (T-7007)", () => {
	it("sets and adds keys, keeps the rest, and writes the merged blocks", async () => {
		const { call, promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "B=changed\nC=new",
			buildArgs: "",
			buildSecrets: "",
			mergeEnv: true,
		});
		const result = await promise;
		expect(result.isError).toBeUndefined();
		expect(call).toHaveBeenCalledWith("application.one", {
			applicationId: "app-1",
			includeEnv: true,
		});
		expect(call).toHaveBeenCalledWith("application.saveEnvironment", {
			applicationId: "app-1",
			env: `A=${SECRET_A}\nB=changed\nC=new\n`,
			buildArgs: `ARG=${SECRET_BUILD}\n`,
			buildSecrets: "",
		});
		expect(JSON.stringify(result)).not.toContain(SECRET_A);
	});

	it("removes named keys with unsetKeys (array for env, object for blocks)", async () => {
		const array = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "",
			buildArgs: "",
			buildSecrets: "",
			mergeEnv: true,
			unsetKeys: ["A"],
		});
		expect((await array.promise).isError).toBeUndefined();
		expect(array.call).toHaveBeenCalledWith("application.saveEnvironment", {
			applicationId: "app-1",
			env: `B=${SECRET_B}\n`,
			buildArgs: `ARG=${SECRET_BUILD}\n`,
			buildSecrets: "",
		});
		const object = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "",
			buildArgs: "",
			buildSecrets: "",
			mergeEnv: true,
			unsetKeys: { buildArgs: ["ARG"] },
		});
		expect((await object.promise).isError).toBeUndefined();
		expect(object.call).toHaveBeenCalledWith("application.saveEnvironment", {
			applicationId: "app-1",
			env: appStored.env,
			buildArgs: "",
			buildSecrets: "",
		});
	});

	it("merges a database service's env", async () => {
		const { call, promise } = run(
			"postgres-saveEnvironment",
			{ postgresId: "pg-1", env: "B=2", mergeEnv: true },
			{ postgresId: "pg-1", env: "A=1\n" },
		);
		expect((await promise).isError).toBeUndefined();
		expect(call).toHaveBeenCalledWith("postgres.saveEnvironment", {
			postgresId: "pg-1",
			env: "A=1\nB=2\n",
		});
	});

	it("rejects bad flag combinations without writing or echoing values", async () => {
		const base = {
			applicationId: "app-1",
			env: "A=1",
			buildArgs: "",
			buildSecrets: "",
		};
		for (const extra of [
			{ unsetKeys: ["A"] },
			{ mergeEnv: true, replaceAll: true },
			{ mergeEnv: true, unsetKeys: ["A"] },
			{ mergeEnv: true, unsetKeys: [1] },
			{ mergeEnv: true, unsetKeys: { nope: ["A"] } },
		]) {
			const { call, promise } = run("application-saveEnvironment", {
				...base,
				...extra,
			});
			const result = await promise;
			expect(result.isError, JSON.stringify(extra)).toBe(true);
			expect(writesOf(call)).toHaveLength(0);
			expect(result.content[0]?.text).not.toContain(SECRET_A);
		}
	});

	it("refuses to merge into a redacted row", async () => {
		const call = vi.fn(async () => ({ env: "", secretsRedacted: true }));
		const result = await executeMcpTool({
			tool: tool("application-saveEnvironment"),
			args: {
				applicationId: "app-1",
				env: "A=1",
				buildArgs: "",
				buildSecrets: "",
				mergeEnv: true,
			},
			scopes: WRITE,
			call,
		});
		expect(result.isError).toBe(true);
		expect(call).toHaveBeenCalledTimes(1);
	});
});

describe("mergeEnvText", () => {
	it("keeps comments, quoting and multiline values of untouched keys byte for byte", () => {
		const current = `# header\nexport A="multi\nline"\n\nB='x y'  # note\nC=3\n`;
		const merged = mergeEnvText(current, "C=4\nD=5", []);
		expect(merged).toBe(
			`# header\nexport A="multi\nline"\n\nB='x y'  # note\nC=4\nD=5\n`,
		);
	});

	it("replaces a repeated definition once and removes unset keys including multiline ones", () => {
		const merged = mergeEnvText(`A=1\nB="x\ny"\nA=2\nC=3`, "A=9", ["B"]);
		expect(merged).toBe(`A=9\nC=3`);
	});

	it("appends after a block with no trailing newline and handles an empty current", () => {
		expect(mergeEnvText("A=1", "B=2", [])).toBe("A=1\nB=2\n");
		expect(mergeEnvText(null, "B=2", [])).toBe("B=2\n");
		expect(mergeEnvText("A=1\n", "", [])).toBe("A=1\n");
	});

	it("throws, without values in the message, when a key is set and unset", () => {
		const attempt = () => mergeEnvText("A=SECRET-x", "A=1", ["A"]);
		expect(attempt).toThrow(/A is both/);
		try {
			attempt();
		} catch (error) {
			expect(String(error)).not.toContain("SECRET-x");
		}
	});
});

describe("saveDockerProvider write guard (T-7007)", () => {
	const dockerTool = tool("application-saveDockerProvider");
	const base = {
		applicationId: "app-1",
		dockerImage: "nginx:latest",
		registryUrl: "",
	};

	it("allows an empty password when the username is also empty or null", () => {
		for (const username of ["", " ", null]) {
			expect(
				guardSecretWriteBack(
					dockerTool,
					{ ...base, username, password: "" },
					WRITE,
				).error,
				String(username),
			).toBeUndefined();
		}
	});

	it("still refuses a blank password next to a username, or with no username sent", () => {
		expect(
			guardSecretWriteBack(
				dockerTool,
				{ ...base, username: "me", password: "" },
				WRITE,
			).error,
		).toContain("`password`");
		expect(
			guardSecretWriteBack(dockerTool, { ...base, password: "" }, WRITE).error,
		).toContain("`password`");
	});

	it("only exempts the docker provider's password", () => {
		expect(
			guardSecretWriteBack(
				dockerTool,
				{ ...base, username: "", password: "", env: "" },
				WRITE,
			).error,
		).toContain("`env`");
		expect(
			guardSecretWriteBack(
				tool("registry-update"),
				{ registryId: "r", username: "", password: "" },
				new Set(["dokploy:admin"]),
			).error,
		).toContain("`password`");
	});

	it("passes through executeMcpTool for a non-admin", async () => {
		const call = vi.fn(async () => true);
		const result = await executeMcpTool({
			tool: dockerTool,
			args: { ...base, username: "", password: "" },
			scopes: WRITE,
			call,
		});
		expect(result.isError).toBeUndefined();
		expect(call).toHaveBeenCalledWith("application.saveDockerProvider", {
			...base,
			username: "",
			password: "",
		});
	});
});

describe("blankEnvArray shapes (T-7007)", () => {
	it("blanks KEY=VALUE strings and keeps bare names", () => {
		expect(blankEnvArray(["A=1", "B=", "C", "D=x=y"])).toEqual([
			"A=",
			"B=",
			"C",
			"D=",
		]);
	});

	it("blanks the value of { name, value } objects and keeps the name", () => {
		const input = [
			{ name: "A", value: "SECRET-1" },
			{ Name: "B", Value: "SECRET-2" },
			{ key: "C", value: 42 },
			{ name: "D", value: "" },
			{ name: "E", valueFrom: { secretKeyRef: { name: "s", key: "k" } } },
		];
		const out = blankEnvArray(input);
		expect(out).toEqual([
			{ name: "A", value: "" },
			{ Name: "B", Value: "" },
			{ key: "C", value: "" },
			{ name: "D", value: "" },
			{ name: "E", valueFrom: "" },
		]);
		expect(JSON.stringify(out)).not.toContain("SECRET");
		// The input is not mutated.
		expect(input[0]).toEqual({ name: "A", value: "SECRET-1" });
	});

	it("blanks single-pair maps and [name, value] pairs", () => {
		const out = blankEnvArray([{ A: "SECRET-1" }, ["B", "SECRET-2"], ["C"]]);
		expect(out).toEqual([{ A: "" }, ["B", ""], ["C"]]);
	});

	it("returns the same array when nothing carries a value", () => {
		const input = ["A=", "B", { name: "C", value: "" }, ["D"], 7, null];
		expect(blankEnvArray(input)).toBe(input);
	});

	it("is what the result redaction uses for an Env array of any shape", () => {
		const out = redactToolResult({
			Config: { Env: ["A=SECRET-1", { name: "B", value: "SECRET-2" }] },
		});
		expect(JSON.stringify(out)).not.toContain("SECRET");
		expect(out).toMatchObject({
			Config: { Env: ["A=", { name: "B", value: "" }] },
			secretsRedacted: true,
		});
	});
});
