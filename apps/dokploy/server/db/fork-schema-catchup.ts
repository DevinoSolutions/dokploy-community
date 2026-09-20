import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Boot-time safety net for the fork's own schema.
 *
 * Drizzle's migrator applies a journal entry only when its `when` timestamp
 * exceeds the newest `created_at` in drizzle.__drizzle_migrations. A database
 * created by upstream Dokploy therefore skips every fork-original migration
 * stamped earlier than upstream's newest migration when the instance is
 * switched to this fork (upstream v0.30.6 stamps up to 2026-09-08; fork
 * 0195..0199 are older). The fork keeps guarded, idempotent
 * `*_fork_schema_catchup*` migrations that re-issue that schema; this module
 * applies any of them whose file hash drizzle never recorded, regardless of
 * `when` ordering, and records them the way drizzle would have.
 */

/** Journal tags of fork catch-up migrations carry this marker. */
export const FORK_CATCHUP_TAG = /fork_schema_catchup/;

export interface CatchupMigration {
	tag: string;
	when: number;
	/** sha256 of the raw .sql file, identical to drizzle's `hash` column. */
	hash: string;
	statements: string[];
}

interface JournalEntry {
	idx: number;
	when: number;
	tag: string;
}

/** Drizzle separates statements with a `--> statement-breakpoint` marker. */
export const splitStatements = (content: string): string[] =>
	content
		.split("--> statement-breakpoint")
		.map((statement) => statement.trim())
		.filter(Boolean);

/** The digest drizzle records in `__drizzle_migrations.hash`. */
export const hashMigration = (content: string): string =>
	crypto.createHash("sha256").update(content).digest("hex");

export const readForkCatchupMigrations = (
	migrationsFolder: string,
): CatchupMigration[] => {
	const journal = JSON.parse(
		fs.readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
	) as { entries: JournalEntry[] };

	return journal.entries
		.filter((entry) => FORK_CATCHUP_TAG.test(entry.tag))
		.sort((a, b) => a.idx - b.idx)
		.map((entry) => {
			const content = fs.readFileSync(
				path.join(migrationsFolder, `${entry.tag}.sql`),
				"utf8",
			);
			return {
				tag: entry.tag,
				when: entry.when,
				hash: hashMigration(content),
				statements: splitStatements(content),
			};
		});
};

/** Catch-ups drizzle never recorded, in journal order. */
export const selectPendingCatchups = (
	catchups: CatchupMigration[],
	appliedHashes: Iterable<string>,
): CatchupMigration[] => {
	const applied = new Set(appliedHashes);
	return catchups.filter((catchup) => !applied.has(catchup.hash));
};

/**
 * Apply every fork catch-up migration missing from drizzle's bookkeeping.
 * Runs after `migrate()`, which guarantees the bookkeeping table exists.
 * Returns the tags that were applied.
 */
export const applyForkSchemaCatchups = async (
	db: PostgresJsDatabase,
	migrationsFolder = "drizzle",
): Promise<string[]> => {
	const catchups = readForkCatchupMigrations(migrationsFolder);
	if (catchups.length === 0) {
		return [];
	}

	const rows = await db.execute<{ hash: string }>(
		sql`select hash from drizzle.__drizzle_migrations`,
	);
	const pending = selectPendingCatchups(
		catchups,
		rows.map((row) => row.hash),
	);

	for (const catchup of pending) {
		await db.transaction(async (tx) => {
			for (const statement of catchup.statements) {
				await tx.execute(sql.raw(statement));
			}
			await tx.execute(
				sql`insert into drizzle.__drizzle_migrations ("hash", "created_at") values (${catchup.hash}, ${catchup.when})`,
			);
		});
		console.log(`Fork schema catch-up applied: ${catchup.tag}`);
	}

	return pending.map((catchup) => catchup.tag);
};
