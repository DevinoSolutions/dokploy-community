import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../db";
import {
	computeMigrationDelta,
	type MigrationJournalEntry,
	parseMigrationJournal,
} from "../utils/dokploy-migration-delta";
import { DOKPLOY_RELEASE_TAG_REGEX } from "../utils/dokploy-update-target";

export type UpdateMigrationDelta =
	| {
			status: "ok";
			runningVersion: string;
			targetVersion: string;
			applies: string[];
			staysApplied: string[];
	  }
	| { status: "unavailable" };

const JOURNAL_FETCH_TIMEOUT_MS = 10_000;
// A journal is about 40 KB; anything far past that is not one.
const JOURNAL_MAX_BYTES = 1024 * 1024;

const journalUrl = (tag: string) =>
	`https://raw.githubusercontent.com/DevinoSolutions/dokploy-community/${tag}/apps/dokploy/drizzle/meta/_journal.json`;

/**
 * The drizzle journal of a release, read from its tag on GitHub (read-only,
 * with a timeout). Null for anything that is not a release tag, and when the
 * journal can't be fetched or is not a journal; never throws.
 */
export const fetchTargetMigrationJournal = async (
	tag: string,
	fetchImpl: typeof fetch = fetch,
): Promise<MigrationJournalEntry[] | null> => {
	if (!DOKPLOY_RELEASE_TAG_REGEX.test(tag)) {
		return null;
	}
	try {
		const response = await fetchImpl(journalUrl(tag), {
			method: "GET",
			headers: { "User-Agent": "dokploy-community" },
			signal: AbortSignal.timeout(JOURNAL_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			return null;
		}
		const body = await response.text();
		if (body.length > JOURNAL_MAX_BYTES) {
			return null;
		}
		return parseMigrationJournal(JSON.parse(body));
	} catch (error) {
		console.error(
			`Error fetching the migration journal of ${tag}:`,
			error instanceof Error ? error.message : String(error),
		);
		return null;
	}
};

/** The journal the running image ships (the folder the migrator reads). */
export const readRunningMigrationJournal = async (
	folder = join(process.cwd(), "drizzle"),
): Promise<MigrationJournalEntry[] | null> => {
	try {
		const raw = await readFile(join(folder, "meta", "_journal.json"), "utf8");
		return parseMigrationJournal(JSON.parse(raw));
	} catch {
		return null;
	}
};

/** The `when` of the last migration the database has, or null if unreadable. */
export const readLastAppliedMigration = async (): Promise<number | null> => {
	try {
		const rows = (await db.execute(
			sql`select max(created_at) as last from drizzle.__drizzle_migrations`,
		)) as unknown as Array<{ last: string | number | null }>;
		const raw = rows[0]?.last;
		const last = raw === null || raw === undefined ? Number.NaN : Number(raw);
		return Number.isFinite(last) ? last : null;
	} catch {
		return null;
	}
};

const defaultSources = {
	fetchTarget: fetchTargetMigrationJournal,
	readRunning: readRunningMigrationJournal,
	readLastApplied: readLastAppliedMigration,
};

/**
 * The migrations installing `targetVersion` applies, and those of the running
 * install that stay applied if it is older. "unavailable" when the target is
 * not a release tag or either journal can't be read; never throws, so a failed
 * check never gets in the way of the update itself.
 */
export const getUpdateMigrationDelta = async (
	runningVersion: string,
	targetVersion: string,
	sources: Partial<typeof defaultSources> = {},
): Promise<UpdateMigrationDelta> => {
	const { fetchTarget, readRunning, readLastApplied } = {
		...defaultSources,
		...sources,
	};
	try {
		const [target, running, appliedUpTo] = await Promise.all([
			fetchTarget(targetVersion),
			readRunning(),
			readLastApplied(),
		]);
		if (!target || !running) {
			return { status: "unavailable" };
		}
		return {
			status: "ok",
			runningVersion,
			targetVersion,
			...computeMigrationDelta({ running, target, appliedUpTo }),
		};
	} catch {
		return { status: "unavailable" };
	}
};
