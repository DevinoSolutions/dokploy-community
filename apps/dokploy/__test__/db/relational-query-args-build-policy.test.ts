import * as schema from "@dokploy/server/db/schema";
import { buildPolicyUnitProjection } from "@dokploy/server/services/build-policy/unit-projection";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

/**
 * Postgres caps any function call at 100 arguments (error 54023, "cannot pass
 * more than 100 arguments to a function"). Drizzle's relational queries pack
 * every selected column of a joined resource into one json_build_array(...),
 * and `application` now has 100+ columns, so `with: { application: true }`
 * throws on every instance.
 *
 * `listBuildPolicyExclusions` and `listBuildPolicyAudit`
 * (packages/server/src/services/build-policy/{exclusions,audit}.ts) shipped
 * exactly that shape and failed the Settings → Build policy page (Sentry
 * DOKPLOY-COMMUNITY-3G/5 and siblings). They now select through
 * `buildPolicyUnitProjection`; these tests mirror the query shapes and assert
 * the generated SQL stays within the cap. SQL is built via .toSQL() only — no
 * DB connection.
 */

const PG_MAX_FUNCTION_ARGS = 100;

// Lazy postgres-js client: only .toSQL() is called, so it never connects.
const client = postgres("postgres://user:pass@127.0.0.1:5432/db", { max: 1 });
const db = drizzle(client, { schema });

function maxJsonBuildArrayArgs(sqlStr: string): number {
	const marker = "json_build_array(";
	let max = 0;
	let start = sqlStr.indexOf(marker);
	while (start !== -1) {
		let depth = 0;
		let args = 1;
		let inString: string | null = null;
		for (let i = start + marker.length - 1; i < sqlStr.length; i++) {
			const ch = sqlStr[i];
			if (inString) {
				if (ch === inString) inString = null;
				continue;
			}
			if (ch === '"' || ch === "'") inString = ch;
			else if (ch === "(") depth++;
			else if (ch === ")") {
				depth--;
				if (depth === 0) break;
			} else if (ch === "," && depth === 1) args++;
		}
		if (args > max) max = args;
		start = sqlStr.indexOf(marker, start + 1);
	}
	return max;
}

describe("build-policy relational queries stay within the 100-argument cap", () => {
	it("listBuildPolicyExclusions", () => {
		const { sql } = db.query.buildPolicyExclusion
			.findMany({
				where: eq(schema.buildPolicyExclusion.organizationId, "org"),
				with: buildPolicyUnitProjection,
			})
			.toSQL();
		expect(maxJsonBuildArrayArgs(sql)).toBeLessThanOrEqual(
			PG_MAX_FUNCTION_ARGS,
		);
	});

	it("listBuildPolicyAudit", () => {
		const { sql } = db.query.buildPolicyAudit
			.findMany({
				where: eq(schema.buildPolicyAudit.organizationId, "org"),
				orderBy: [desc(schema.buildPolicyAudit.createdAt)],
				limit: 50,
				offset: 0,
				with: buildPolicyUnitProjection,
			})
			.toSQL();
		expect(maxJsonBuildArrayArgs(sql)).toBeLessThanOrEqual(
			PG_MAX_FUNCTION_ARGS,
		);
	});

	it("selecting the units in full exceeds the cap (regression guard)", () => {
		// Documents why the projection is required: the shape that shipped in
		// v0.30.6-community.1 blows the limit.
		const { sql } = db.query.buildPolicyExclusion
			.findMany({
				where: eq(schema.buildPolicyExclusion.organizationId, "org"),
				with: { application: true, compose: true },
			})
			.toSQL();
		expect(maxJsonBuildArrayArgs(sql)).toBeGreaterThan(PG_MAX_FUNCTION_ARGS);
	});
});
