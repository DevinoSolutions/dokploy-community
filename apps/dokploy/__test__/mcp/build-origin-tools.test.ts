import { describe, expect, it } from "vitest";
import { appRouter } from "@/server/api/root";
import { buildMcpToolRegistry } from "@/server/mcp/registry";

/**
 * T-12149: the build origin of a service is queryable through the API, so the
 * MCP tools (generated from the routers) must carry the inputs and say what the
 * fields mean.
 */
describe("MCP tools for the build origin", () => {
	const tools = buildMcpToolRegistry(appRouter, { excludeRouters: ["mcp"] });
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const props = (name: string) =>
		(byName.get(name)?.inputSchema.properties ?? {}) as Record<
			string,
			{ enum?: string[]; description?: string }
		>;

	it("overview-services takes a buildOrigin filter and describes the fields", () => {
		const tool = byName.get("overview-services");
		expect(tool).toBeDefined();
		expect(tool?.type).toBe("query");
		expect(props("overview-services").buildOrigin?.enum).toEqual([
			"dokploy",
			"github-actions",
			"external",
		]);
		expect(tool?.description).toContain("buildOrigin");
		expect(tool?.description).toContain("buildRunUrl");
		expect(tool?.description).toContain("GitHub Actions");
		expect(tool?.description).toContain("latest deployment with status done");
	});

	it.each([
		"application-deploy",
		"application-redeploy",
		"compose-deploy",
		"compose-redeploy",
	])("%s accepts buildOrigin and buildRunUrl", (name) => {
		const p = props(name);
		expect(p.buildOrigin?.enum).toEqual([
			"dokploy",
			"github-actions",
			"external",
		]);
		expect(p.buildOrigin?.description).toContain("Where the image was built");
		expect(p.buildRunUrl?.description).toContain(
			"https://github.com/<owner>/<repo>/actions/runs/<id>",
		);
	});

	it.each([
		"application-one",
		"compose-one",
		"environment-one",
		"deployment-all",
		"deployment-allByCompose",
		"deployment-allByType",
	])("%s says what buildOrigin means", (name) => {
		const description = byName.get(name)?.description ?? "";
		expect(description).toContain("buildOrigin");
		expect(description).toContain("'dokploy'");
		expect(description).toContain("'github-actions'");
		expect(description).toContain("'external'");
	});
});
