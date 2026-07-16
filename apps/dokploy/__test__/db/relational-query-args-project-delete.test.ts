import * as schema from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

/**
 * Postgres caps any function call at 100 arguments (error 54023,
 * "cannot pass more than 100 arguments to a function"). Drizzle's relational
 * queries pack every selected column of a joined resource, plus one entry per
 * nested relation, into a single json_build_array(...). The `application` table
 * has exactly 100 columns, so selecting it in full inside a relational query
 * that also nests a relation (e.g. `domains`) emits json_build_array(100
 * columns + 1) = 101 args and throws.
 *
 * `deleteProject` gathers every Cloudflare-published domain under a project
 * before the FK cascade drops the rows. Its tree query therefore projects
 * `application`/`compose` down to their primary keys and only loads `domains`
 * in full. This test mirrors that query shape (see
 * packages/server/src/services/project.ts) and asserts the generated SQL stays
 * within the cap. It builds SQL via .toSQL() only — no DB connection.
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

describe("deleteProject tree query json_build_array argument limit", () => {
	it("deleteProject domain-gathering query stays within the Postgres 100-argument cap", () => {
		const { sql } = db.query.projects
			.findFirst({
				where: eq(schema.projects.projectId, "x"),
				with: {
					environments: {
						columns: { environmentId: true },
						with: {
							applications: {
								columns: { applicationId: true },
								with: { domains: true },
							},
							compose: {
								columns: { composeId: true },
								with: { domains: true },
							},
						},
					},
				},
			})
			.toSQL();
		expect(maxJsonBuildArrayArgs(sql)).toBeLessThanOrEqual(
			PG_MAX_FUNCTION_ARGS,
		);
	});

	it("selecting application in full with nested domains exceeds the cap (regression guard)", () => {
		// Documents why the projection is required: the un-projected tree query
		// that shipped with the Cloudflare feature blows the limit and 500s
		// project.remove instance-wide. If `application` ever shrinks below the
		// threshold this will flag that the projection can be revisited.
		const { sql } = db.query.projects
			.findFirst({
				where: eq(schema.projects.projectId, "x"),
				with: {
					environments: {
						with: {
							applications: { with: { domains: true } },
							compose: { with: { domains: true } },
						},
					},
				},
			})
			.toSQL();
		expect(maxJsonBuildArrayArgs(sql)).toBeGreaterThan(PG_MAX_FUNCTION_ARGS);
	});
});
