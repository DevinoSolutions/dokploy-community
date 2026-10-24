import { db } from "@dokploy/server/db";
import { webServerSettings } from "@dokploy/server/db/schema";
import type { WatchdogExclusion } from "@dokploy/server/utils/deployments/watchdog-config";
import { eq, sql } from "drizzle-orm";

/**
 * Get the web server settings (singleton - only one row should exist)
 */
export const getWebServerSettings = async () => {
	const settings = await db.query.webServerSettings.findFirst({
		orderBy: (settings, { asc }) => [asc(settings.createdAt)],
	});

	if (!settings) {
		// Create default settings if none exist
		const [newSettings] = await db
			.insert(webServerSettings)
			.values({})
			.returning();

		return newSettings;
	}

	return settings;
};

/**
 * Update web server settings
 */
export const updateWebServerSettings = async (
	updates: Partial<typeof webServerSettings.$inferInsert>,
) => {
	const current = await getWebServerSettings();

	const [updated] = await db
		.update(webServerSettings)
		.set({
			...updates,
			updatedAt: new Date(),
		})
		.where(eq(webServerSettings.id, current?.id ?? ""))
		.returning();

	return updated;
};

/**
 * The SQL that rewrites the watchdog exclusion list in ONE statement. The list
 * is edited from three places (the service switch, the admin card's add and
 * remove), possibly at the same moment: a read in JS and a write of the whole
 * list back would let two edits lose one entry. A single UPDATE is atomic per
 * row: concurrent edits queue on the row lock and each one is applied to the
 * list the previous one left.
 */
const column = sql`${webServerSettings.deploymentWatchdogExclusions}`;

/** The list without the entry for this service, in the same order. */
const withoutService = (type: string, id: string) => sql`(
	SELECT COALESCE(jsonb_agg(t.e ORDER BY t.ord), '[]'::jsonb)
	FROM jsonb_array_elements(${column}) WITH ORDINALITY AS t(e, ord)
	WHERE NOT (t.e->>'type' = ${type} AND t.e->>'id' = ${id})
)`;

export const buildWatchdogExclusionUpdate = (
	change:
		| { op: "add"; entry: WatchdogExclusion; keepExisting: boolean }
		| { op: "remove"; type: WatchdogExclusion["type"]; id: string },
) => {
	if (change.op === "remove") return withoutService(change.type, change.id);
	const { entry } = change;
	const appended = JSON.stringify([entry]);
	if (!change.keepExisting) {
		return sql`${withoutService(entry.type, entry.id)} || ${appended}::jsonb`;
	}
	return sql`CASE WHEN EXISTS (
		SELECT 1 FROM jsonb_array_elements(${column}) AS e
		WHERE e->>'type' = ${entry.type} AND e->>'id' = ${entry.id}
	) THEN ${column} ELSE ${column} || ${appended}::jsonb END`;
};

const applyWatchdogExclusionChange = async (
	change: Parameters<typeof buildWatchdogExclusionUpdate>[0],
) => {
	// Makes sure the singleton row exists, and names it.
	const current = await getWebServerSettings();
	await db
		.update(webServerSettings)
		.set({
			deploymentWatchdogExclusions: buildWatchdogExclusionUpdate(change),
			updatedAt: new Date(),
		})
		.where(eq(webServerSettings.id, current?.id ?? ""));
};

/**
 * Adds a service to the watchdog exclusion list. `keepExisting` leaves an
 * entry that is already there as it is (the service switch must not drop the
 * reason an admin wrote); otherwise the entry is replaced.
 */
export const addWatchdogExclusion = (
	entry: WatchdogExclusion,
	options: { keepExisting: boolean },
) =>
	applyWatchdogExclusionChange({
		op: "add",
		entry,
		keepExisting: options.keepExisting,
	});

export const removeWatchdogExclusion = (
	type: WatchdogExclusion["type"],
	id: string,
) => applyWatchdogExclusionChange({ op: "remove", type, id });
