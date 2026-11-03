import { describe, expect, it } from "vitest";
import { appRouter } from "@/server/api/root";
import { buildMcpToolRegistry } from "@/server/mcp/registry";

/** The deploy gate settings reach the MCP tools through the router input, with their bounds. */
describe("ghaConnection MCP tools carry the deploy gate", () => {
	const tools = buildMcpToolRegistry(appRouter, { excludeRouters: ["mcp"] });
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const properties = (name: string) =>
		(byName.get(name)?.inputSchema.properties ?? {}) as Record<
			string,
			Record<string, unknown>
		>;

	it("update and deployAnyway are tools with real descriptions, behind the administration scope", () => {
		for (const name of ["ghaConnection-update", "ghaConnection-deployAnyway"]) {
			const tool = byName.get(name);
			expect(tool, name).toBeDefined();
			expect(tool?.description.length, name).toBeGreaterThan(80);
			expect(tool?.scope, name).toBe("dokploy:admin");
		}
	});

	it.each(["ghaConnection-connect", "ghaConnection-update"])(
		"%s takes gateMode, gateWorkflows and gateTimeoutMinutes with their bounds",
		(name) => {
			const props = properties(name);
			expect(props.gateMode?.enum).toEqual(["image", "checks", "workflows"]);
			expect(props.gateWorkflows).toMatchObject({
				type: "array",
				maxItems: 20,
				items: { type: "string", minLength: 1, maxLength: 100 },
			});
			expect(props.gateTimeoutMinutes).toMatchObject({
				type: "integer",
				minimum: 5,
				maximum: 720,
			});
		},
	);

	it("deployAnyway takes a short reason", () => {
		expect(properties("ghaConnection-deployAnyway").reason).toMatchObject({
			type: "string",
			maxLength: 300,
		});
	});
});
