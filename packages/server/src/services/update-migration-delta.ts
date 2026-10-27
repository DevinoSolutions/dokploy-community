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

/**
 * The body of a response as text, or null once it is past `max` bytes. The
 * size is checked from content-length first and then while reading, so a body
 * that lies about its size, or has none, is cancelled at the cap instead of
 * being held in memory.
 */
const readBoundedText = async (response: Response, max: number) => {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) {
		await response.body?.cancel().catch(() => undefined);
		return null;
	}
	if (!response.body) {
		return null;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
};

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
			redirect: "error",
			signal: AbortSignal.timeout(JOURNAL_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			return null;
		}
		const body = await readBoundedText(response, JOURNAL_MAX_BYTES);
		if (body === null) {
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

const TARGET_CACHE_TTL_MS = 5 * 60_000;
const TARGET_CACHE_MISS_TTL_MS = 30_000;
const TARGET_CACHE_MAX_ENTRIES = 50;

const targetCache = new Map<
	string,
	{ journal: MigrationJournalEntry[] | null; expires: number }
>();

export const clearTargetMigrationJournalCache = () => targetCache.clear();

/**
 * `fetchTargetMigrationJournal` with a small in-memory cache per tag, so the
 * dialog (which asks as a tag is typed) doesn't go to GitHub for every ask. A
 * journal is kept for 5 minutes and a failure for 30 seconds; the cache holds
 * at most 50 tags, oldest out first. A string that is not a release tag is
 * refused before the cache, so it can't fill it.
 */
export const getTargetMigrationJournal = async (
	tag: string,
	{
		fetchJournal = fetchTargetMigrationJournal,
		now = Date.now,
	}: {
		fetchJournal?: (tag: string) => Promise<MigrationJournalEntry[] | null>;
		now?: () => number;
	} = {},
): Promise<MigrationJournalEntry[] | null> => {
	if (!DOKPLOY_RELEASE_TAG_REGEX.test(tag)) {
		return null;
	}
	const cached = targetCache.get(tag);
	if (cached && cached.expires > now()) {
		return cached.journal;
	}
	const journal = await fetchJournal(tag);
	targetCache.delete(tag);
	while (targetCache.size >= TARGET_CACHE_MAX_ENTRIES) {
		const oldest = targetCache.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		targetCache.delete(oldest);
	}
	targetCache.set(tag, {
		journal,
		expires: now() + (journal ? TARGET_CACHE_TTL_MS : TARGET_CACHE_MISS_TTL_MS),
	});
	return journal;
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
	fetchTarget: getTargetMigrationJournal,
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
