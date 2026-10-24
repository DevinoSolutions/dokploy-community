import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

/**
 * The exclusion list of the restricted-compose audit is edited by one UPDATE
 * statement (the per-service switch and the card in Settings can run at the
 * same moment). A read in JavaScript followed by a write of the whole list
 * would lose an entry; the statement must be built from the stored column and
 * bind every value as a parameter.
 */

vi.mock("@dokploy/server/db", () => ({ db: {} }));

const { buildComposePolicyExclusionUpdate } = await import(
	"@dokploy/server/services/compose-policy-audit"
);

const dialect = new PgDialect();
const render = (
	change: Parameters<typeof buildComposePolicyExclusionUpdate>[0],
) => dialect.sqlToQuery(buildComposePolicyExclusionUpdate(change));

describe("removing a compose", () => {
	it("is computed from the stored column, in its order, in one expression", () => {
		const { sql, params } = render({ op: "remove", id: "c1" });

		expect(sql).toContain(
			'"organization"."restricted_compose_audit_exclusions"',
		);
		expect(sql).toContain("jsonb_array_elements");
		expect(sql).toContain("WITH ORDINALITY");
		expect(sql).toContain("ORDER BY t.ord");
		// An empty result stays a list, never null.
		expect(sql).toContain("COALESCE");
		expect(sql).toContain("'[]'::jsonb");
		expect(params).toEqual(["c1"]);
	});

	it("never puts the value in the statement text", () => {
		const { sql } = render({ op: "remove", id: "x'; DROP TABLE y; --" });

		expect(sql).not.toContain("DROP TABLE");
	});
});

describe("adding a compose", () => {
	it("keeps an entry that is already there as it is, and appends otherwise", () => {
		const { sql, params } = render({
			op: "add",
			entry: { id: "c1" },
		});

		expect(sql).toContain("CASE WHEN EXISTS");
		expect(sql).toContain("||");
		expect(params).toEqual(["c1", JSON.stringify([{ id: "c1" }])]);
	});

	it("never puts the value in the statement text", () => {
		const { sql } = render({
			op: "add",
			entry: { id: "x'; DROP TABLE y; --" },
		});

		expect(sql).not.toContain("DROP TABLE");
	});
});
