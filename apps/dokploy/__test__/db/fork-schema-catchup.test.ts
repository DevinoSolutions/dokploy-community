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
			"0235_fork_schema_catchup_v3",
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
		const [first, second, third] = catchups as [
			CatchupMigration,
			CatchupMigration,
			CatchupMigration,
		];
		expect(
			selectPendingCatchups(catchups, [first.hash, second.hash, third.hash]),
		).toEqual([]);
		// The v0.30.6 switcher: drizzle applied 0202 (newest `when` then) but skipped
		// 0195, whose `when` sits below upstream's high-water mark.
		expect(
			selectPendingCatchups(catchups, [second.hash, "unrelated"]).map(
				(c) => c.tag,
			),
		).toEqual([first.tag, third.tag]);
		// The v0.31.0 switcher: drizzle applied 0235 (newest `when`) but skipped the two older ones.
		expect(
			selectPendingCatchups(catchups, [third.hash]).map((c) => c.tag),
		).toEqual([first.tag, second.tag]);
		expect(selectPendingCatchups(catchups, []).map((c) => c.tag)).toEqual([
			first.tag,
			second.tag,
			third.tag,
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

	it("0235 re-issues every fork-original migration older than upstream v0.31.0's newest", () => {
		const sql = fs.readFileSync(
			path.join(drizzleDir, "0235_fork_schema_catchup_v3.sql"),
			"utf8",
		);
		for (const marker of [
			"ADD VALUE IF NOT EXISTS 'infomaniak'", // 0201
			'CREATE TABLE IF NOT EXISTS "uptimely_integration"', // 0203
			'CREATE TABLE IF NOT EXISTS "sendly"', // 0204
			'CREATE TABLE IF NOT EXISTS "dodomain_integration"', // 0205
			'CREATE TABLE IF NOT EXISTS "snapvisor_integration"', // 0206
			'CREATE TABLE IF NOT EXISTS "deployment_queue_job"', // 0207
			'"compose" ADD COLUMN IF NOT EXISTS "buildServerId"', // 0208
			'"application" ADD COLUMN IF NOT EXISTS "previewDockerImage"', // 0209
			'CREATE TABLE IF NOT EXISTS "oauth_client"', // 0210
			'CREATE TABLE IF NOT EXISTS "uptimely_channel"', // 0212
			'"compose" ADD COLUMN IF NOT EXISTS "snapvisorProjectName"', // 0213
			'"dodomain_connect_session" ADD COLUMN IF NOT EXISTS "token"', // 0214
			'CREATE TABLE IF NOT EXISTS "snapvisor_build_check"', // 0215
			'"compose" ADD COLUMN IF NOT EXISTS "deployGuardrails"', // 0216
			'"compose" ADD COLUMN IF NOT EXISTS "rollingReplace"', // 0217
			'CREATE TABLE IF NOT EXISTS "deployment_cancel_audit"', // 0218
			'"oauthClientId"', // 0219
			'"server" ADD COLUMN IF NOT EXISTS "dockerCleanupCron"', // 0220
			'"deploymentWatchdogExclusions"', // 0221
		]) {
			expect(sql).toContain(marker);
		}
	});

	it("0235 never rewrites data or undoes a later default", () => {
		const sql = fs.readFileSync(
			path.join(drizzleDir, "0235_fork_schema_catchup_v3.sql"),
			"utf8",
		);
		const code = sql
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("--"))
			.join("\n");
		// 0211 copies 1.6 grants and is deliberately not repeated; 0234 owns the whitelabel default.
		// A statement that starts with a data verb is a rewrite; "ON UPDATE no action" in a foreign key is not.
		expect(code).not.toMatch(/^\s*(INSERT\s+INTO|UPDATE\s|DELETE\s+FROM)/im);
		expect(code).not.toMatch(/\b(DROP|RENAME)\b/i);
		expect(code).not.toContain("whitelabelingConfig");
	});
});
