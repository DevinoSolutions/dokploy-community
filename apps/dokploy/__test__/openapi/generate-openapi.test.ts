import { generateOpenApiDocument } from "@dokploy/trpc-openapi";
import { describe, expect, it } from "vitest";
import { appRouter } from "@/server/api/root";

type OpenApiMeta = { enabled?: boolean; path?: string } | undefined;

type RouterProcedure = {
	_def: { type: string; meta?: { openapi?: OpenApiMeta } };
};

const document = generateOpenApiDocument(appRouter, {
	title: "Dokploy API",
	version: "1.0.0",
	baseUrl: "http://localhost:3000/api",
});

const paths = document.paths ?? {};

/** Every router procedure with the path the document keys it by. */
const procedures = Object.entries(
	(appRouter as unknown as { _def: { procedures: Record<string, unknown> } })
		._def.procedures,
).map(([name, procedure]) => {
	const { type, meta } = (procedure as RouterProcedure)._def;
	const openapi = meta?.openapi;
	return {
		name,
		type,
		optedOut: openapi?.enabled === false,
		// A procedure without a custom `openapi.path` is keyed by its name.
		path: openapi?.path ?? `/${name}`,
	};
});

const served = procedures.filter((procedure) => !procedure.optedOut);
const optedOut = procedures.filter((procedure) => procedure.optedOut);

/**
 * /swagger and settings.getOpenApiDocument build the document from the whole
 * router. OpenAPI v3 can't describe a subscription, so one subscription
 * without `openapi: { enabled: false }` makes every request for the spec fail.
 */
describe("OpenAPI document", () => {
	it("generates from the full app router", () => {
		expect(Object.keys(paths).length).toBeGreaterThan(0);
	});

	it("documents every procedure that has not opted out", () => {
		const missing = served
			.filter((procedure) => !(procedure.path in paths))
			.map((procedure) => procedure.name);

		expect(missing).toEqual([]);
		// Guards the guard: an empty `served` list would make the check above pass
		// for the wrong reason.
		expect(served.length).toBeGreaterThan(500);
	});

	it("documents nothing the router does not serve", () => {
		const servedPaths = new Set(served.map((procedure) => procedure.path));
		const phantom = Object.keys(paths).filter((path) => !servedPaths.has(path));

		expect(phantom).toEqual([]);
	});

	it("keeps every procedure that opted out of OpenAPI out of the document", () => {
		const leaked = optedOut
			.filter((procedure) => procedure.path in paths)
			.map((procedure) => procedure.name);

		expect(leaked).toEqual([]);
	});

	it("keeps the internal-only procedures out of the public document", () => {
		// Pinned by name: the check above only proves the document agrees with
		// the flag on each procedure, not that the flag is the right one. These
		// are real procedures (the first assertion fails if one is renamed or
		// removed, so this list cannot rot into a vacuous check).
		const internalOnly = [
			"backupPolicy.runNow",
			"mcp.connectionInfo",
			"mcp.listAuthorizations",
			"mcp.revokeAuthorization",
			"mcp.approveAuthorization",
		];
		const known = new Set(procedures.map((procedure) => procedure.name));

		expect(internalOnly.filter((name) => !known.has(name))).toEqual([]);
		expect(
			Object.keys(paths).filter((path) =>
				internalOnly.some((name) => path === `/${name}`),
			),
		).toEqual([]);
	});

	it("opts out every subscription, which OpenAPI cannot describe", () => {
		const exposed = procedures
			.filter((procedure) => procedure.type === "subscription")
			.filter((procedure) => !procedure.optedOut)
			.map((procedure) => procedure.name);

		expect(exposed).toEqual([]);
	});

	it("gives every operation a unique operationId", () => {
		const ids = Object.values(paths).flatMap((item) =>
			Object.values(item ?? {}).map(
				(operation) => (operation as { operationId?: string }).operationId,
			),
		);

		expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(
			true,
		);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
