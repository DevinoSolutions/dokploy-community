import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CatchupMigration,
	FORK_CATCHUP_TAG,
	hashMigration,
	readForkCatchupMigrations,
	selectPendingCatchups,
	splitStatements,
} from "../../server/db/fork-schema-catchup";

/**
 * Regression coverage for the upstream-to-fork switch that skipped fork
 * migrations 0195..0199 on a v0.30.6 upstream database (Sentry
 * DOKPLOY-COMMUNITY-3C/3J/H: organization.wildcard_domain, oauth_access_token
 * and server.default_domain missing while build_policy_* existed). The boot
 * runner applies catch-ups by file hash, so these tests pin the pure parts:
 * discovery, hashing parity with drizzle, statement splitting and selection.
 */

const drizzleDir = path.resolve(__dirname, "../../drizzle");

describe("fork schema catch-up runner", () => {
	const catchups = readForkCatchupMigrations(drizzleDir);

	it("discovers every *_fork_schema_catchup* journal entry in journal order", () => {
		expect(catchups.map((c) => c.tag)).toEqual([
			"0195_fork_schema_catchup",
			"0202_fork_schema_catchup_v2",
		]);
		for (let i = 1; i < catchups.length; i++) {
			expect(catchups[i]?.when).toBeGreaterThan(catchups[i - 1]?.when ?? 0);
		}
		expect(FORK_CATCHUP_TAG.test("0201_steep_sage")).toBe(false);
	});

	it("hashes the raw file exactly like drizzle records it", () => {
		for (const catchup of catchups) {
			const raw = fs.readFileSync(
				path.join(drizzleDir, `${catchup.tag}.sql`),
				"utf8",
			);
			expect(catchup.hash).toBe(
				crypto.createHash("sha256").update(raw).digest("hex"),
			);
			expect(hashMigration(raw)).toBe(catchup.hash);
		}
	});

	it("splits on the drizzle breakpoint and drops empty chunks", () => {
		expect(
			splitStatements(
				"--> statement-breakpoint\nA;--> statement-breakpoint\n\n  B;  \n--> statement-breakpoint",
			),
		).toEqual(["A;", "B;"]);
		for (const catchup of catchups) {
			expect(catchup.statements.length).toBeGreaterThan(5);
		}
	});

	it("selects only catch-ups whose hash drizzle never recorded", () => {
		const [first, second] = catchups as [CatchupMigration, CatchupMigration];
		expect(selectPendingCatchups(catchups, [first.hash, second.hash])).toEqual(
			[],
		);
		// The v0.30.6 switcher: drizzle applied 0202 (newest `when`) but skipped
		// 0195, whose `when` sits below upstream's high-water mark.
		expect(
			selectPendingCatchups(catchups, [second.hash, "unrelated"]).map(
				(c) => c.tag,
			),
		).toEqual([first.tag]);
		expect(selectPendingCatchups(catchups, []).map((c) => c.tag)).toEqual([
			first.tag,
			second.tag,
		]);
	});

	it("0202 re-issues every fork-original migration older than upstream v0.30.6's newest", () => {
		const sql = fs.readFileSync(
			path.join(drizzleDir, "0202_fork_schema_catchup_v2.sql"),
			"utf8",
		);
		for (const marker of [
			'"network" ADD COLUMN IF NOT EXISTS "dockerId"', // 0196
			'"organization" ADD COLUMN IF NOT EXISTS "wildcard_domain"', // 0197
			'CREATE TABLE IF NOT EXISTS "oauth_access_token"', // 0198
			'"onboardingCompletedAt"', // 0199
			'CREATE TABLE IF NOT EXISTS "build_policy_settings"', // 0200
		]) {
			expect(sql).toContain(marker);
		}
	});
});
