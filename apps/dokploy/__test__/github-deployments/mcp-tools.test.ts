import { describe, expect, it } from "vitest";
import { appRouter } from "@/server/api/root";
import { buildMcpToolRegistry } from "@/server/mcp/registry";

describe("GitHub Deployments MCP tools", () => {
	const tools = buildMcpToolRegistry(appRouter, { excludeRouters: ["mcp"] });
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const names = [
		"githubDeployment-connections",
		"githubDeployment-startConnect",
		"githubDeployment-completeConnect",
		"githubDeployment-disconnect",
		"githubDeployment-toggleShare",
		"githubDeployment-watches",
		"githubDeployment-watchOne",
		"githubDeployment-watchSet",
		"githubDeployment-watchRemove",
	];

	it("are generated from the router, each with a real description", () => {
		for (const name of names) {
			const tool = byName.get(name);
			expect(tool, name).toBeDefined();
			expect(tool?.description.length, name).toBeGreaterThan(80);
			expect(tool?.description, name).not.toMatch(/^(GET|POST) \//);
		}
	});

	it("reads need the read scope, changes need administration", () => {
		for (const name of [
			"githubDeployment-connections",
			"githubDeployment-watches",
			"githubDeployment-watchOne",
		]) {
			expect(byName.get(name)?.scope, name).toBe("dokploy:read");
		}
		for (const name of [
			"githubDeployment-startConnect",
			"githubDeployment-completeConnect",
			"githubDeployment-disconnect",
			"githubDeployment-toggleShare",
			"githubDeployment-watchSet",
			"githubDeployment-watchRemove",
		]) {
			expect(byName.get(name)?.scope, name).toBe("dokploy:admin");
		}
	});

	it("never take a token as input and say the token is never returned", () => {
		for (const name of names) {
			const properties = Object.keys(
				(byName.get(name)?.inputSchema.properties as Record<string, unknown>) ??
					{},
			);
			expect(
				properties.some((key) => /token|secret|password/i.test(key)),
				name,
			).toBe(false);
		}
		expect(byName.get("githubDeployment-connections")?.description).toContain(
			"access token is never returned",
		);
	});

	it("describe the ownership and two-deployer rules", () => {
		expect(byName.get("githubDeployment-toggleShare")?.description).toContain(
			"Only the member who connected it",
		);
		expect(byName.get("githubDeployment-disconnect")?.description).toContain(
			"organization owner or admin",
		);
		const watchSet = byName.get("githubDeployment-watchSet");
		expect(watchSet?.description).toContain("override");
		expect(
			Object.keys(
				(watchSet?.inputSchema.properties as Record<string, unknown>) ?? {},
			),
		).toContain("override");
	});

	it("describe the digest rule on the watch tool", () => {
		const description =
			byName.get("githubDeployment-watchSet")?.description ?? "";
		expect(description).toContain("sha256");
		expect(description).toContain("pinned by digest");
	});
});
