import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

/**
 * The exclusion list is edited by one UPDATE statement, from three call sites
 * that can run at the same moment. A read in JavaScript followed by a write of
 * the whole list would lose an entry; the statement must therefore be built
 * from the stored column itself and bind every value as a parameter.
 */

vi.mock("@dokploy/server/db", () => ({ db: {} }));

const { buildWatchdogExclusionUpdate } = await import(
	"@dokploy/server/services/web-server-settings"
);

const dialect = new PgDialect();
const render = (change: Parameters<typeof buildWatchdogExclusionUpdate>[0]) =>
	dialect.sqlToQuery(buildWatchdogExclusionUpdate(change));

describe("removing a service", () => {
	it("is computed from the stored column, in its order, in one expression", () => {
		const { sql, params } = render({ op: "remove", type: "compose", id: "c1" });

		expect(sql).toContain('"webServerSettings"."deploymentWatchdogExclusions"');
		expect(sql).toContain("jsonb_array_elements");
		expect(sql).toContain("WITH ORDINALITY");
		expect(sql).toContain("ORDER BY t.ord");
		// An empty result stays a list, never null.
		expect(sql).toContain("COALESCE");
		expect(sql).toContain("'[]'::jsonb");
		expect(params).toEqual(["compose", "c1"]);
	});

	it("never puts the values in the statement text", () => {
		const { sql } = render({
			op: "remove",
			type: "application",
			id: "x'; DROP TABLE y; --",
		});

		expect(sql).not.toContain("DROP TABLE");
	});
});

describe("adding a service", () => {
	it("replaces the entry of the same service when it does not keep the existing one", () => {
		const { sql, params } = render({
			op: "add",
			entry: { type: "application", id: "a1", reason: "new" },
			keepExisting: false,
		});

		// The old entry is filtered out of the stored list, the new one appended.
		expect(sql).toContain("WITH ORDINALITY");
		expect(sql).toContain("||");
		expect(sql).not.toContain("CASE WHEN EXISTS");
		expect(params).toEqual([
			"application",
			"a1",
			JSON.stringify([{ type: "application", id: "a1", reason: "new" }]),
		]);
	});

	it("leaves an entry that is already there as it is when asked to keep it", () => {
		const { sql, params } = render({
			op: "add",
			entry: { type: "compose", id: "c1" },
			keepExisting: true,
		});

		expect(sql).toContain("CASE WHEN EXISTS");
		expect(sql).toContain("THEN");
		expect(sql).toContain("ELSE");
		expect(params).toContain("compose");
		expect(params).toContain("c1");
		expect(params).toContain(JSON.stringify([{ type: "compose", id: "c1" }]));
	});

	it("does not read or write the list anywhere but through the column", () => {
		const { sql } = render({
			op: "add",
			entry: { type: "compose", id: "c1" },
			keepExisting: true,
		});

		// Only the one column of the web server settings is named.
		expect(sql.match(/"webServerSettings"\./g)?.length ?? 0).toBeGreaterThan(0);
		expect(sql).not.toMatch(/SELECT\s+\*/i);
	});
});
