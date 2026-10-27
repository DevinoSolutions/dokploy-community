// Which database migrations an update applies, from the drizzle journals of
// the running version and of the version being installed. Pure: reading the
// journals and the migrations table is up to the caller.

export interface MigrationJournalEntry {
	tag: string;
	when: number;
}

export interface MigrationDelta {
	/** Migrations of the target that the running install does not have yet. */
	applies: string[];
	/** Migrations of the running install that the target does not ship. */
	staysApplied: string[];
}

/** The entries of a drizzle `_journal.json`; null when it is not one. */
export const parseMigrationJournal = (
	raw: unknown,
): MigrationJournalEntry[] | null => {
	const entries = (raw as { entries?: unknown } | null)?.entries;
	if (!Array.isArray(entries) || entries.length === 0) {
		return null;
	}
	const journal: MigrationJournalEntry[] = [];
	for (const entry of entries) {
		const { tag, when } = (entry ?? {}) as Record<string, unknown>;
		if (typeof tag !== "string" || !tag || typeof when !== "number") {
			return null;
		}
		journal.push({ tag, when });
	}
	return journal;
};

/**
 * Drizzle applies a journal entry when its `when` is newer than the last
 * migration in the database, so with `appliedUpTo` (that last `when`) the
 * delta follows the same rule: an entry the database is already past is not
 * applied again, which is the case after an image-only rollback. Without it
 * the delta is the plain difference between the two journals.
 */
export const computeMigrationDelta = ({
	running,
	target,
	appliedUpTo,
}: {
	running: MigrationJournalEntry[];
	target: MigrationJournalEntry[];
	appliedUpTo?: number | null;
}): MigrationDelta => {
	const hasCutoff = typeof appliedUpTo === "number";
	const runningTags = new Set(running.map((entry) => entry.tag));
	const targetTags = new Set(target.map((entry) => entry.tag));
	const byWhen = (a: MigrationJournalEntry, b: MigrationJournalEntry) =>
		a.when - b.when;
	return {
		applies: target
			.filter(
				(entry) =>
					!runningTags.has(entry.tag) &&
					(!hasCutoff || entry.when > appliedUpTo),
			)
			.sort(byWhen)
			.map((entry) => entry.tag),
		staysApplied: running
			.filter(
				(entry) =>
					!targetTags.has(entry.tag) &&
					(!hasCutoff || entry.when <= appliedUpTo),
			)
			.sort(byWhen)
			.map((entry) => entry.tag),
	};
};
