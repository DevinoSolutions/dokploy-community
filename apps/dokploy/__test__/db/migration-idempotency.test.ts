import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fork-delta migrations (idx >= 174) must be idempotent.
 *
 * A user switching from OFFICIAL Dokploy to this fork can have upstream's own
 * migrations already applied at an EARLIER `when` timestamp than the fork's
 * journal records. Drizzle's migrator replays every journal entry whose `when`
 * is greater than the last-applied `created_at`, so any fork-delta migration
 * that re-runs unguarded DDL (e.g. a plain `ADD COLUMN`) throws (duplicate
 * column/type/constraint), which rolls back the WHOLE pending batch and leaves
 * the install missing every later fork table/column.
 *
 * This guards against a regression: every CREATE TABLE / CREATE TYPE /
 * CREATE INDEX / ADD COLUMN / ADD CONSTRAINT in a fork-delta migration must be
 * idempotent — either `IF NOT EXISTS`, or wrapped in a
 * `DO $$ BEGIN ... EXCEPTION WHEN ... THEN null; END $$;` block (the style
 * drizzle emits for types/constraints, which have no `IF NOT EXISTS` form).
 *
 * The linter is intentionally pragmatic (statement-split + regex). It must pass
 * on the current fixed set and fail if someone adds an unguarded fork migration.
 * Upstream-owned migrations (idx < 174) are out of scope.
 */

const FORK_DELTA_START = 174;
const drizzleDir = path.resolve(__dirname, "../../drizzle");

interface JournalEntry {
	idx: number;
	tag: string;
}

const journal = JSON.parse(
	fs.readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8"),
) as { entries: JournalEntry[] };

const forkEntries = journal.entries.filter((e) => e.idx >= FORK_DELTA_START);

/** Drizzle separates statements with a `--> statement-breakpoint` marker. */
const splitStatements = (sql: string): string[] =>
	sql
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter(Boolean);

/**
 * A statement is idempotent when it is a `DO $$ ... EXCEPTION WHEN ...` block
 * (which swallows duplicate_object/duplicate_column), or when the bare DDL
 * carries an `IF NOT EXISTS` clause.
 */
const isGuarded = (stmt: string): boolean => {
	if (/^DO\s+\$\$/i.test(stmt)) {
		return /EXCEPTION\s+WHEN/i.test(stmt);
	}
	return /IF\s+NOT\s+EXISTS/i.test(stmt);
};

/** DDL that fails on re-apply unless guarded. */
const NON_IDEMPOTENT_DDL: { label: string; pattern: RegExp }[] = [
	{ label: "CREATE TABLE", pattern: /CREATE\s+TABLE/i },
	{ label: "CREATE TYPE", pattern: /CREATE\s+TYPE/i },
	{ label: "CREATE INDEX", pattern: /CREATE\s+(UNIQUE\s+)?INDEX/i },
	{ label: "ADD COLUMN", pattern: /ADD\s+COLUMN/i },
	{ label: "ADD CONSTRAINT", pattern: /ADD\s+CONSTRAINT/i },
];

describe("fork-delta migration idempotency (idx >= 174)", () => {
	it("has fork-delta migrations to check", () => {
		expect(forkEntries.length).toBeGreaterThan(0);
	});

	it.each(forkEntries.map((e) => [e.tag] as const))(
		"%s only contains idempotent DDL",
		(tag) => {
			const file = path.join(drizzleDir, `${tag}.sql`);
			expect(fs.existsSync(file)).toBe(true);
			const sql = fs.readFileSync(file, "utf8");

			const offenders: string[] = [];
			for (const stmt of splitStatements(sql)) {
				const kinds = NON_IDEMPOTENT_DDL.filter((d) =>
					d.pattern.test(stmt),
				).map((d) => d.label);
				if (kinds.length === 0) continue;
				if (isGuarded(stmt)) continue;
				offenders.push(
					`[${kinds.join(", ")}] ${stmt.replace(/\s+/g, " ").slice(0, 100)}`,
				);
			}

			expect(
				offenders,
				`Unguarded DDL in ${tag}.sql — wrap in DO $$ ... EXCEPTION or add IF NOT EXISTS:\n${offenders.join("\n")}`,
			).toEqual([]);
		},
	);
});
