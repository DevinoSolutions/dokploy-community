import { describe, expect, it } from "vitest";
import {
	MCP_SECRET_KEYS,
	redactToolResult,
} from "@dokploy/server/services/service-secrets";

describe("redactToolResult", () => {
	it("blanks every known secret key at any depth, in objects and arrays", () => {
		const result = redactToolResult({
			name: "env-1",
			env: "A=SECRET-1",
			applications: [
				{
					name: "web",
					buildArgs: "SECRET-2",
					registry: { password: "SECRET-3" },
					nested: { deeper: [{ token: "SECRET-4" }] },
				},
			],
		}) as Record<string, unknown>;
		expect(JSON.stringify(result)).not.toContain("SECRET-");
		expect(result.secretsRedacted).toBe(true);
	});

	it("covers the whole key list", () => {
		for (const key of [
			"env",
			"buildArgs",
			"buildSecrets",
			"previewEnv",
			"previewBuildArgs",
			"previewBuildSecrets",
			"password",
			"databasePassword",
			"databaseRootPassword",
			"refreshToken",
			"accessToken",
			"token",
			"secret",
			"clientSecret",
			"privateKey",
			"encryptionKey",
			"encryptionPassword",
			"encryptionPassword2",
			"secretAccessKey",
			"accessKey",
			"apiKey",
			"webhookSecret",
		]) {
			expect(MCP_SECRET_KEYS.has(key), key).toBe(true);
			const out = redactToolResult({ [key]: "SECRET-x" }) as Record<
				string,
				unknown
			>;
			expect(out[key], key).toBe("");
		}
	});

	it("leaves non-secret fields untouched", () => {
		const input = {
			name: "web",
			appName: "web-abc",
			description: "uses a password manager",
			publishedPort: 8080,
			enabled: true,
			hasKey: true,
			tokenCount: 3,
			host: "web.example.com",
		};
		expect(redactToolResult(input)).toBe(input);
	});

	it("does not set the marker when only empty values were present", () => {
		const input = { env: "", password: null, project: { env: "" } };
		expect(redactToolResult(input)).toBe(input);
	});

	it("blanks a non-empty object or array under a secret key", () => {
		const out = redactToolResult({
			env: { A: "SECRET-1" },
			token: ["SECRET-2"],
			secret: {},
		}) as Record<string, unknown>;
		expect(out.env).toBe("");
		expect(out.token).toBe("");
		expect(out.secret).toEqual({});
	});

	it("strips userinfo from customGitUrl and nothing else in it", () => {
		const out = redactToolResult({
			customGitUrl: "https://ci:SECRET-tok@git.example.com/o/r.git",
			other: { customGitUrl: "git@github.com:o/r.git" },
		}) as Record<string, unknown>;
		expect(out.customGitUrl).toBe("https://git.example.com/o/r.git");
		expect(out.other).toEqual({ customGitUrl: "git@github.com:o/r.git" });
		expect(out.secretsRedacted).toBe(true);
	});

	it("does not mutate its input and shares untouched subtrees", () => {
		const untouched = { name: "keep", list: [1, 2, 3] };
		const input = { a: { env: "SECRET-1" }, b: untouched };
		const out = redactToolResult(input) as {
			a: { env: string };
			b: unknown;
		};
		expect(input.a.env).toBe("SECRET-1");
		expect(out.a.env).toBe("");
		expect(out.b).toBe(untouched);
		expect(out).not.toBe(input);
	});

	it("marks only the top-level object, and leaves an array result unmarked", () => {
		const list = redactToolResult([{ env: "SECRET-1" }]) as unknown[];
		expect(Array.isArray(list)).toBe(true);
		expect(list).toEqual([{ env: "" }]);
		const obj = redactToolResult({ items: [{ env: "SECRET-1" }] }) as {
			secretsRedacted?: boolean;
			items: Array<Record<string, unknown>>;
		};
		expect(obj.secretsRedacted).toBe(true);
		expect(obj.items[0]).not.toHaveProperty("secretsRedacted");
	});

	it("survives a cycle and a shared (non-cyclic) reference", () => {
		const cyclic: Record<string, unknown> = { name: "loop", env: "SECRET-1" };
		cyclic.self = cyclic;
		const out = redactToolResult(cyclic) as Record<string, unknown>;
		expect(out.env).toBe("");
		const shared = { password: "SECRET-2" };
		const both = redactToolResult({ x: shared, y: shared }) as {
			x: { password: string };
			y: { password: string };
		};
		expect(both.x.password).toBe("");
		expect(both.y.password).toBe("");
	});

	it("passes primitives, null and dates through", () => {
		const input = { at: new Date() };
		expect(redactToolResult(null)).toBeNull();
		expect(redactToolResult("text")).toBe("text");
		expect(redactToolResult(7)).toBe(7);
		expect(redactToolResult(input)).toBe(input);
	});
});
