import { describe, expect, it } from "vitest";
import { appRouter } from "@/server/api/root";
import { buildMcpToolRegistry } from "@/server/mcp/registry";

/**
 * Pins tool → scope for every exposed procedure. A change here is a
 * permission change and must be reviewed as one: update the snapshot on
 * purpose with `pnpm vitest run -u __test__/mcp/scopes-snapshot.test.ts`.
 */
describe("MCP tool scope table", () => {
	const tools = buildMcpToolRegistry(appRouter, { excludeRouters: ["mcp"] });

	it("exposes the expected well-known tools with @dokploy/mcp names", () => {
		const names = new Set(tools.map((tool) => tool.name));
		for (const expected of [
			"application-deploy",
			"application-one",
			"compose-one",
			"postgres-create",
			"project-all",
			"settings-getDokployVersion",
			"user-get",
			"backup-create",
		]) {
			expect(names.has(expected), expected).toBe(true);
		}
		expect(tools.length).toBeGreaterThan(400);
		for (const tool of tools) {
			expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
		}
	});

	it("tool → scope snapshot", () => {
		const table = Object.fromEntries(
			tools
				.map((tool) => [tool.name, tool.scope] as const)
				.sort(([a], [b]) => a.localeCompare(b)),
		);
		expect(table).toMatchSnapshot();
	});
});
