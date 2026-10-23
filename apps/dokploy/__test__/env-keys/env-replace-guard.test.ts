import {
	envBlockLosses,
	mergeEnvText,
	summarizeMerge,
} from "@dokploy/server/services/env-merge";
import {
	blankEnvArray,
	findEmptiedSecretField,
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
const WRITE_ONLY = new Set(["dokploy:services:write"]);
const WRITE_ADMIN = new Set([...WRITE, "dokploy:admin"]);

const UPDATE_SCOPES = new Set([
	...WRITE,
	"dokploy:projects:write",
	"dokploy:environments:write",
]);

const SECRET_A = "SECRET-value-a";
const SECRET_B = "SECRET-value-b";
const SECRET_BUILD = "SECRET-build-arg";

/** A caller whose `<router>.one` read returns `stored`; every call is recorded. */
const makeCall = (stored: Record<string, unknown>) =>
	vi.fn(async (path: string, _args: unknown) => {
		if (path.endsWith(".one")) return { ...stored };
		return true;
	});

const writesTo = (call: ReturnType<typeof makeCall>, path: string) =>
	call.mock.calls.filter(([called]) => called === path);

const writesOf = (call: ReturnType<typeof makeCall>) =>
	call.mock.calls.filter(
		([path]) => !path.endsWith(".one") && !path.endsWith(".envKeys"),
	);

const appStored = {
	applicationId: "app-1",
	env: `A=${SECRET_A}\nB=${SECRET_B}\n`,
	buildArgs: `ARG=${SECRET_BUILD}\n`,
	buildSecrets: "",
	previewEnv: null,
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

const textOf = (result: { content: Array<{ text: string }> }) =>
	result.content[0]?.text ?? "";

const expectNoSecrets = (text: string) => {
	for (const secret of [SECRET_A, SECRET_B, SECRET_BUILD]) {
		expect(text).not.toContain(secret);
	}
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
		const text = textOf(result);
		expect(text).toContain("would drop 2 existing variable(s)");
		expect(text).toContain("env: A, B");
		expect(text).toContain("mergeEnv");
		expect(text).toContain("replaceAll");
		expectNoSecrets(text);
	});

	it("only counts the dropped keys when the grant has no dokploy:read", async () => {
		const { call, promise } = run(
			"application-saveEnvironment",
			{
				applicationId: "app-1",
				env: "NEW=1",
				buildArgs: "ARG=y",
				buildSecrets: "",
			},
			appStored,
			WRITE_ONLY,
		);
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(writesOf(call)).toHaveLength(0);
		const text = textOf(result);
		expect(text).toContain("would drop 2 existing variable(s) (env: 2)");
		expect(text).toContain("dokploy:read");
		// The two stored names must not appear (a bare "A" would be too loose).
		expect(text).not.toContain("env: A");
		expect(text).not.toContain(", B");
		expectNoSecrets(text);
	});

	it("also checks buildArgs", async () => {
		const { promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "A=1\nB=2",
			buildArgs: "OTHER=1",
			buildSecrets: "",
		});
		const text = textOf(await promise);
		expect(text).toContain("would drop 1 existing variable(s)");
		expect(text).toContain("buildArgs: ARG");
	});

	it("refuses a kept name whose value is blanked, without echoing values", async () => {
		const { call, promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "A=\nB=\nNEW=1",
			buildArgs: "ARG=y",
			buildSecrets: "",
		});
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(writesOf(call)).toHaveLength(0);
		const text = textOf(result);
		expect(text).toContain("blank the value of 2 existing variable(s)");
		expect(text).toContain("env: A, B");
		expectNoSecrets(text);
	});

	it("allows an unchanged kept value and a key that was already empty", async () => {
		const stored = { ...appStored, env: "A=\nB=2\n" };
		const { call, promise } = run(
			"application-saveEnvironment",
			{
				applicationId: "app-1",
				env: "A=\nB=3\nC=",
				buildArgs: "ARG=y",
				buildSecrets: "",
			},
			stored,
		);
		expect((await promise).isError).toBeUndefined();
		expect(writesOf(call)).toHaveLength(1);
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
		const text = textOf(result);
		expect(text).toContain("would drop 1 existing variable(s)");
		expect(text).toContain("env: K2");
		expectNoSecrets(text);

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

	it("adds the flags to the right tool schemas and descriptions", () => {
		const schema = tool("application-saveEnvironment").inputSchema as {
			properties: Record<string, unknown>;
		};
		for (const field of ["replaceAll", "mergeEnv", "unsetKeys"]) {
			expect(schema.properties).toHaveProperty(field);
		}
		expect(tool("application-saveEnvironment").description).toContain(
			"mergeEnv: true",
		);
		for (const name of [
			"application-update",
			"compose-update",
			"postgres-update",
			"project-update",
			"environment-update",
		]) {
			const update = tool(name).inputSchema as {
				properties: Record<string, unknown>;
			};
			expect(update.properties, name).toHaveProperty("replaceAll");
			expect(update.properties, name).not.toHaveProperty("mergeEnv");
			expect(tool(name).description, name).toContain("replaceAll: true");
		}
		const other = tool("application-start").inputSchema as {
			properties: Record<string, unknown>;
		};
		expect(other.properties).not.toHaveProperty("replaceAll");
	});

	it("keeps refusing an empty env that has variables stored, naming both flags", async () => {
		const { call, promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "",
		});
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(writesOf(call)).toHaveLength(0);
		const text = textOf(result);
		expect(text).toContain("allowEmptySecrets");
		expect(text).toContain("replaceAll");
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

	it("fails closed when the stored variables cannot be read", async () => {
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
		expect(textOf(result)).toContain("could not read");
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
		expect(textOf(result)).toContain("`buildArgs`");
		expect(writesOf(call)).toHaveLength(0);
	});
});

describe("null and non-string blocks (T-7007)", () => {
	it("refuses all-null blocks over stored variables without replaceAll", async () => {
		const { call, promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: null,
			buildArgs: null,
			buildSecrets: null,
		});
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(writesOf(call)).toHaveLength(0);
		expectNoSecrets(textOf(result));
	});

	it("refuses a null block next to a real one when the null drops stored keys", async () => {
		const { call, promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "A=1\nB=2",
			buildArgs: null,
			buildSecrets: "",
		});
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(writesOf(call)).toHaveLength(0);
	});

	it("accepts null blocks where nothing is stored, and with replaceAll", async () => {
		const empty = run(
			"application-saveEnvironment",
			{
				applicationId: "app-1",
				env: "A=1",
				buildArgs: null,
				buildSecrets: null,
			},
			{ ...appStored, env: "A=old", buildArgs: null, buildSecrets: null },
		);
		expect((await empty.promise).isError).toBeUndefined();
		expect(writesOf(empty.call)).toHaveLength(1);
		const wiped = run(
			"application-saveEnvironment",
			{
				applicationId: "app-1",
				env: null,
				buildArgs: null,
				buildSecrets: null,
				replaceAll: true,
				allowEmptySecrets: true,
			},
			appStored,
			WRITE_ADMIN,
		);
		expect((await wiped.promise).isError).toBeUndefined();
	});

	it("refuses a block that is neither a string nor null, on both paths", async () => {
		for (const extra of [{}, { mergeEnv: true }]) {
			for (const bad of [5, true, ["A=1"], { A: "1" }]) {
				const { call, promise } = run("application-saveEnvironment", {
					applicationId: "app-1",
					env: bad,
					buildArgs: "",
					buildSecrets: "",
					...extra,
				});
				const result = await promise;
				expect(result.isError, JSON.stringify([extra, bad])).toBe(true);
				expect(writesOf(call)).toHaveLength(0);
			}
		}
	});

	it("refuses a null block with mergeEnv instead of writing null", async () => {
		const { call, promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: null,
			buildArgs: "",
			buildSecrets: "",
			mergeEnv: true,
		});
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("must be a string");
		expect(writesOf(call)).toHaveLength(0);
	});

	it("findEmptiedSecretField sees a null variable block, but not other null secrets", () => {
		expect(findEmptiedSecretField({ env: null })).toBe("env");
		expect(findEmptiedSecretField({ nested: { buildSecrets: null } })).toBe(
			"buildSecrets",
		);
		expect(findEmptiedSecretField({ password: null })).toBeNull();
	});
});

describe("update tools take the same guard (T-7007)", () => {
	it("refuses application-update that would drop env keys, and only looks at the blocks sent", async () => {
		const { call, promise } = run("application-update", {
			applicationId: "app-1",
			name: "renamed",
			env: "NEW=1",
		});
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(writesTo(call, "application.update")).toHaveLength(0);
		const text = textOf(result);
		expect(text).toContain("would drop 2 existing variable(s)");
		expect(text).toContain("env: A, B");
		expect(text).not.toContain("buildArgs");
		expect(text).not.toContain("mergeEnv");
		expectNoSecrets(text);
	});

	it("refuses a null or non-string env on application-update", async () => {
		for (const env of [null, 5]) {
			const { call, promise } = run("application-update", {
				applicationId: "app-1",
				env,
			});
			expect((await promise).isError).toBe(true);
			expect(writesTo(call, "application.update")).toHaveLength(0);
		}
	});

	it("covers the preview blocks", async () => {
		const stored = { ...appStored, previewEnv: `P=${SECRET_A}\n` };
		const { call, promise } = run(
			"application-update",
			{ applicationId: "app-1", previewEnv: "Q=1" },
			stored,
		);
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("previewEnv: P");
		expect(writesTo(call, "application.update")).toHaveLength(0);
	});

	it("allows an update that does not touch the blocks, keeps all keys, or passes replaceAll", async () => {
		const plain = run("application-update", {
			applicationId: "app-1",
			name: "renamed",
		});
		expect((await plain.promise).isError).toBeUndefined();
		expect(plain.call).toHaveBeenCalledTimes(1);

		const kept = run("application-update", {
			applicationId: "app-1",
			env: "A=1\nB=2\nC=3",
		});
		expect((await kept.promise).isError).toBeUndefined();
		expect(writesTo(kept.call, "application.update")).toHaveLength(1);

		const replaced = run("application-update", {
			applicationId: "app-1",
			env: "ONLY=1",
			replaceAll: true,
		});
		expect((await replaced.promise).isError).toBeUndefined();
		expect(replaced.call).toHaveBeenCalledWith("application.update", {
			applicationId: "app-1",
			env: "ONLY=1",
		});
	});

	it("covers a database update, compose, project and environment shared env", async () => {
		for (const [name, idField] of [
			["postgres-update", "postgresId"],
			["compose-update", "composeId"],
			["project-update", "projectId"],
			["environment-update", "environmentId"],
		] as const) {
			const stored = {
				[idField]: "x-1",
				env: `K1=${SECRET_A}\nK2=${SECRET_B}\n`,
			};
			const refused = run(
				name,
				{ [idField]: "x-1", env: "K1=1" },
				stored,
				UPDATE_SCOPES,
			);
			const result = await refused.promise;
			expect(result.isError, name).toBe(true);
			expect(textOf(result), name).toContain("env: K2");
			expectNoSecrets(textOf(result));
			expect(writesOf(refused.call), name).toHaveLength(0);

			const replaced = run(
				name,
				{ [idField]: "x-1", env: "K1=1", replaceAll: true },
				stored,
				UPDATE_SCOPES,
			);
			expect((await replaced.promise).isError, name).toBeUndefined();
			expect(writesOf(replaced.call), name).toHaveLength(1);
		}
	});

	it("rejects mergeEnv and unsetKeys on an update tool", async () => {
		const { call, promise } = run("application-update", {
			applicationId: "app-1",
			env: "A=1",
			mergeEnv: true,
		});
		expect((await promise).isError).toBe(true);
		expect(writesTo(call, "application.update")).toHaveLength(0);
	});
});

describe("MCP saveEnvironment merge (T-7007)", () => {
	it("sets and adds keys, keeps the rest, and answers with counts", async () => {
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
		expect(result.structuredContent).toEqual({
			saved: true,
			merge: [
				{ block: "env", added: 1, updated: 1, unset: 0, unsetMissing: [] },
			],
		});
		expectNoSecrets(textOf(result));
		expect(textOf(result)).not.toContain("changed");
	});

	it("removes named keys with unsetKeys and reports the ones that were not stored", async () => {
		const array = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "",
			buildArgs: "",
			buildSecrets: "",
			mergeEnv: true,
			unsetKeys: ["A", "MISSING"],
		});
		const arrayResult = await array.promise;
		expect(arrayResult.isError).toBeUndefined();
		expect(array.call).toHaveBeenCalledWith("application.saveEnvironment", {
			applicationId: "app-1",
			env: `B=${SECRET_B}\n`,
			buildArgs: `ARG=${SECRET_BUILD}\n`,
			buildSecrets: "",
		});
		expect(arrayResult.structuredContent).toEqual({
			saved: true,
			merge: [
				{
					block: "env",
					added: 0,
					updated: 0,
					unset: 1,
					unsetMissing: ["MISSING"],
				},
			],
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

	it("reports a merge that matched nothing instead of a bare true", async () => {
		const { promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "",
			buildArgs: "",
			buildSecrets: "",
			mergeEnv: true,
			unsetKeys: ["NOPE"],
		});
		const result = await promise;
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			saved: true,
			merge: [
				{
					block: "env",
					added: 0,
					updated: 0,
					unset: 0,
					unsetMissing: ["NOPE"],
				},
			],
		});
	});

	it("refuses an unparseable block", async () => {
		const { call, promise } = run("application-saveEnvironment", {
			applicationId: "app-1",
			env: "this is not a variable definition",
			buildArgs: "",
			buildSecrets: "",
			mergeEnv: true,
		});
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("no KEY=VALUE");
		expect(writesOf(call)).toHaveLength(0);
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
			expect(textOf(result)).not.toContain(SECRET_A);
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

describe("env-merge helpers", () => {
	it("keeps comments, quoting and multiline values of untouched keys byte for byte", () => {
		const current = `# header\nexport A="multi\nline"\n\nB='x y'  # note\nC=3\n`;
		const merged = mergeEnvText(current, "C=4\nD=5", []);
		expect(merged).toBe(
			`# header\nexport A="multi\nline"\n\nB='x y'  # note\nC=4\nD=5\n`,
		);
	});

	it("replaces a repeated definition once and removes unset keys including multiline ones", () => {
		const merged = mergeEnvText(`A=1\nB="x\ny"\nA=2\nC=3`, "A=9", ["B"]);
		expect(merged).toBe("A=9\nC=3");
	});

	it("keeps values with escaped quotes and backticks intact", () => {
		const current = "A='it\\'s'\nB=\"say \\\"hi\\\"\"\nC=`a\\`b`\nD=1\n";
		const merged = mergeEnvText(current, "D=2", []);
		expect(merged).toBe("A='it\\'s'\nB=\"say \\\"hi\\\"\"\nC=`a\\`b`\nD=2\n");
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

	it("envBlockLosses reports dropped and blanked names only", () => {
		expect(envBlockLosses("A=1\nB=2\nC=\nD=4", "A=\nC=\nE=5")).toEqual({
			dropped: ["B", "D"],
			blanked: ["A"],
		});
		expect(envBlockLosses(null, "A=1")).toEqual({ dropped: [], blanked: [] });
		expect(envBlockLosses("A=1", null)).toEqual({
			dropped: ["A"],
			blanked: [],
		});
	});

	it("summarizeMerge counts without values", () => {
		expect(summarizeMerge("A=1\nB=2", "B=3\nC=4", ["A", "Z"])).toEqual({
			added: 1,
			updated: 1,
			unset: 1,
			unsetMissing: ["Z"],
		});
	});
});

describe("saveDockerProvider write guard (T-7007)", () => {
	const base = {
		applicationId: "app-1",
		dockerImage: "nginx:latest",
		registryUrl: "",
	};
	const dockerTool = tool("application-saveDockerProvider");

	const save = (
		args: Record<string, unknown>,
		stored: Record<string, unknown>,
		scopes = WRITE,
	) =>
		run("application-saveDockerProvider", { ...base, ...args }, stored, scopes);

	it("allows an empty password and username when no credentials are stored", async () => {
		for (const username of ["", " ", null]) {
			const { call, promise } = save(
				{ username, password: "" },
				{ username: null, password: null },
			);
			const result = await promise;
			expect(result.isError, String(username)).toBeUndefined();
			expect(call).toHaveBeenCalledWith("application.saveDockerProvider", {
				...base,
				username: username === null ? null : "",
				password: "",
			});
		}
	});

	it("keeps the admin requirement when credentials are stored", async () => {
		for (const stored of [
			{ username: "me", password: "pw" },
			{ username: null, password: "pw" },
			{ username: "me", password: null },
		]) {
			const { call, promise } = save({ username: "", password: "" }, stored);
			const result = await promise;
			expect(result.isError, JSON.stringify(stored)).toBe(true);
			expect(textOf(result)).toContain("`password`");
			expect(writesTo(call, "application.saveDockerProvider")).toHaveLength(0);
		}
		const admin = save(
			{ username: "", password: "", allowEmptySecrets: true },
			{ username: "me", password: "pw" },
			WRITE_ADMIN,
		);
		expect((await admin.promise).isError).toBeUndefined();
	});

	it("still refuses a blank password next to a username, or with no username sent", async () => {
		for (const args of [{ username: "me", password: "" }, { password: "" }]) {
			const { call, promise } = save(args, { username: null, password: null });
			const result = await promise;
			expect(result.isError, JSON.stringify(args)).toBe(true);
			expect(writesTo(call, "application.saveDockerProvider")).toHaveLength(0);
		}
	});

	it("refuses when the stored row cannot be read, or another secret is emptied", async () => {
		const redacted = save(
			{ username: "", password: "" },
			{ username: null, password: null, secretsRedacted: true },
		);
		expect((await redacted.promise).isError).toBe(true);
		const other = await executeMcpTool({
			tool: dockerTool,
			args: { ...base, username: "", password: "", env: "" },
			scopes: WRITE,
			call: makeCall({ username: null, password: null }),
		});
		expect(other.isError).toBe(true);
	});

	it("the strict guard itself never exempts a password", () => {
		expect(
			guardSecretWriteBack(
				dockerTool,
				{ ...base, username: "", password: "" },
				WRITE,
			).error,
		).toContain("`password`");
		expect(
			guardSecretWriteBack(
				tool("registry-update"),
				{ registryId: "r", username: "", password: "" },
				new Set(["dokploy:admin"]),
			).error,
		).toContain("`password`");
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
