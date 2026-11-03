import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	migrationStatements,
	PGliteClass,
} from "../helpers/pglite-deployments";

/**
 * Migration 0232 (T-13879) adds the github-actions source type to both service tables' enums. It runs against a real
 * Postgres (PGlite) holding the enums as 0000 to 0231 leave them, twice, as an update that replays it would; the new
 * value then takes rows. The journal, the snapshot and the drizzle schema must agree with the file.
 */

const { sourceType } = await import("@dokploy/server/db/schema/application");
const { sourceTypeCompose } = await import("@dokploy/server/db/schema/compose");

type Client = {
	exec: (sql: string) => Promise<unknown>;
	query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
	close: () => Promise<void>;
};
let client: Client | null = null;
const ready = PGliteClass !== null;

const FILE = "0232_gha_provider_source.sql";
const drizzleDir = resolve(__dirname, "../../drizzle");

const values = async (type: string) =>
	(
		await client?.query(
			`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = '${type}' ORDER BY e.enumsortorder`,
		)
	)?.rows.map((row) => row.enumlabel);

beforeAll(async () => {
	if (!PGliteClass) return;
	const pg = new PGliteClass() as unknown as Client;
	client = pg;
	await pg.exec(
		`CREATE TYPE "public"."sourceType" AS ENUM ('docker','git','github','gitlab','bitbucket','gitea','drop');
		 CREATE TYPE "public"."sourceTypeCompose" AS ENUM ('git','github','gitlab','bitbucket','gitea','raw');
		 CREATE TABLE "application" ("applicationId" text PRIMARY KEY, "sourceType" "sourceType" NOT NULL DEFAULT 'github');
		 CREATE TABLE "compose" ("composeId" text PRIMARY KEY, "sourceType" "sourceTypeCompose" NOT NULL DEFAULT 'github');`,
	);
}, 120_000);

afterAll(async () => {
	await client?.close();
});

describe.skipIf(!ready)("migration 0232 on a real Postgres", () => {
	it("adds the value once, and a second run is a no-op", async () => {
		for (const run of [1, 2]) {
			for (const statement of migrationStatements(FILE)) {
				await client?.exec(statement);
			}
			expect(await values("sourceType"), `run ${run}`).toEqual([
				"docker",
				"git",
				"github",
				"gitlab",
				"bitbucket",
				"gitea",
				"drop",
				"github-actions",
			]);
			expect(await values("sourceTypeCompose"), `run ${run}`).toEqual([
				"git",
				"github",
				"gitlab",
				"bitbucket",
				"gitea",
				"raw",
				"github-actions",
			]);
		}
	});

	it("lets both tables hold a github-actions service afterwards", async () => {
		await client?.exec(
			`INSERT INTO "application" ("applicationId","sourceType") VALUES ('a1','github-actions');
			 INSERT INTO "compose" ("composeId","sourceType") VALUES ('c1','github-actions');`,
		);
		const rows = await client?.query(
			`SELECT (SELECT "sourceType"::text FROM "application" WHERE "applicationId"='a1') AS a, (SELECT "sourceType"::text FROM "compose" WHERE "composeId"='c1') AS c`,
		);
		expect(rows?.rows[0]).toEqual({ a: "github-actions", c: "github-actions" });
	});

	it("uses the new value in no statement of its own file", () => {
		for (const statement of migrationStatements(FILE)) {
			const code = statement
				.split("\n")
				.filter((line) => !line.startsWith("--"))
				.join("\n");
			expect(code).toMatch(
				/^ALTER TYPE "public"\."sourceType(Compose)?" ADD VALUE IF NOT EXISTS 'github-actions';?$/,
			);
		}
		expect(migrationStatements(FILE)).toHaveLength(2);
	});
});

describe("migration 0232 bookkeeping", () => {
	const journal = JSON.parse(
		readFileSync(resolve(drizzleDir, "meta/_journal.json"), "utf8"),
	) as { entries: Array<{ idx: number; when: number; tag: string }> };

	it("is the next journal entry, later than every earlier one, and an LF file", () => {
		const entry = journal.entries.find(
			(e) => e.tag === "0232_gha_provider_source",
		);
		expect(entry).toMatchObject({ idx: 232, when: 1793890000000 });
		for (const earlier of journal.entries.filter((e) => e.idx < 232)) {
			expect(earlier.when).toBeLessThan(1793890000000);
		}
		expect(readFileSync(resolve(drizzleDir, FILE), "utf8")).not.toContain("\r");
	});

	it("has a snapshot with the value in both enums, chained on the previous snapshot", () => {
		const snapshot = JSON.parse(
			readFileSync(resolve(drizzleDir, "meta/0232_snapshot.json"), "utf8"),
		);
		expect(snapshot.enums["public.sourceType"].values).toContain(
			"github-actions",
		);
		expect(snapshot.enums["public.sourceTypeCompose"].values).toContain(
			"github-actions",
		);
		const previous = JSON.parse(
			readFileSync(resolve(drizzleDir, "meta/0230_snapshot.json"), "utf8"),
		);
		// 0231 (the acceptance PR) sits between them once it lands; until then 0232 chains on 0231's id, which
		// is not in this tree, so only the shape is pinned here.
		expect(snapshot.prevId).not.toBe(snapshot.id);
		expect(snapshot.id).not.toBe(previous.id);
	});

	it("matches the drizzle enums the application and compose tables use", () => {
		expect(sourceType.enumValues).toContain("github-actions");
		expect(sourceTypeCompose.enumValues).toContain("github-actions");
	});
});
