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
 * has 100 columns (including this fork's added `networkIds`), so selecting it in
 * full inside a relational query emits json_build_array(100 columns + 1 nested
 * relation) = 101 args and throws.
 *
 * `findScheduleById` and `findVolumeBackupById` are hit by the schedule/volume
 * backup scheduler on every job fire and therefore project `application` down to
 * only the columns their consumers read. These tests mirror those query shapes
 * (see packages/server/src/services/schedule.ts and
 * packages/server/src/services/volume-backups.ts) and assert the generated SQL
 * stays within the cap. They build SQL via .toSQL() only — no DB connection.
 */

const PG_MAX_FUNCTION_ARGS = 100;

// Lazy postgres-js client: only .toSQL() is called, so it never connects.
const client = postgres("postgres://user:pass@127.0.0.1:5432/db", { max: 1 });
const db = drizzle(client, { schema });

// The projection applied to `application` by the fixed service queries.
const applicationProjection = {
	columns: { appName: true, serverId: true },
	with: {
		environment: {
			columns: {},
			with: { project: { columns: { name: true, organizationId: true } } },
		},
	},
} as const;

// Full nested select (`environment -> project`) used by the narrower resources.
const withEnvProject = {
	with: { environment: { with: { project: true } } },
} as const;

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

describe("relational query json_build_array argument limit", () => {
	it("findScheduleById query stays within the Postgres 100-argument cap", () => {
		const { sql } = db.query.schedules
			.findFirst({
				where: eq(schema.schedules.scheduleId, "x"),
				with: {
					application: applicationProjection,
					compose: withEnvProject,
					server: { with: { organization: true } },
				},
			})
			.toSQL();
		expect(maxJsonBuildArrayArgs(sql)).toBeLessThanOrEqual(
			PG_MAX_FUNCTION_ARGS,
		);
	});

	it("findVolumeBackupById query stays within the Postgres 100-argument cap", () => {
		const { sql } = db.query.volumeBackups
			.findFirst({
				where: eq(schema.volumeBackups.volumeBackupId, "x"),
				with: {
					application: applicationProjection,
					postgres: withEnvProject,
					mysql: withEnvProject,
					mariadb: withEnvProject,
					mongo: withEnvProject,
					redis: withEnvProject,
					compose: withEnvProject,
					libsql: withEnvProject,
					destination: {
						columns: { accessKey: false, secretAccessKey: false },
					},
				},
			})
			.toSQL();
		expect(maxJsonBuildArrayArgs(sql)).toBeLessThanOrEqual(
			PG_MAX_FUNCTION_ARGS,
		);
	});

	it("selecting application in full exceeds the cap (regression guard)", () => {
		// Documents why the projection is required: the un-projected select that
		// shipped previously blows the limit. If application ever shrinks below the
		// threshold this will flag that the projection can be revisited.
		const { sql } = db.query.schedules
			.findFirst({
				where: eq(schema.schedules.scheduleId, "x"),
				with: { application: withEnvProject },
			})
			.toSQL();
		expect(maxJsonBuildArrayArgs(sql)).toBeGreaterThan(PG_MAX_FUNCTION_ARGS);
	});
});
