import { destinations } from "@dokploy/server/db/schema";
import { DESTINATION_READ_KEYS } from "@dokploy/server/services/backup-read-view";
import { getTableColumns } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXCLUDED_COLUMNS } from "./backup-read-view.excluded-columns";

/**
 * `findBackupById`, `findBackupsByDbId` and `findVolumeBackupById` load the
 * backup with its destination. The result goes to the routers and to the
 * runners alike, so the nested destination must not hold the encryption key,
 * the second encryption password or the raw rclone flags: a caller that
 * returned a finder result unshaped would leak them. The runners load the
 * destination they use themselves (findDestinationById /
 * findDestinationByIdForOrganization), so nothing here needs the credentials.
 */

type FinderArgs = {
	with?: { destination?: { columns?: Record<string, boolean> } | true };
};

const captured = vi.hoisted(() => ({
	args: {} as Record<string, FinderArgs>,
}));

vi.mock("@dokploy/server/db", () => {
	const table = (name: string) => ({
		findFirst: async (args: FinderArgs) => {
			captured.args[name] = args;
			return { [`${name}Id`]: "x" };
		},
		findMany: async (args: FinderArgs) => {
			captured.args[name] = args;
			return [];
		},
	});
	return {
		db: {
			query: {
				backups: table("backups"),
				volumeBackups: table("volumeBackups"),
			},
		},
	};
});

const { findBackupById, findBackupsByDbId } = await import(
	"@dokploy/server/services/backup"
);
const { findVolumeBackupById } = await import(
	"@dokploy/server/services/volume-backups"
);

const destinationColumns = Object.keys(getTableColumns(destinations));

const FINDERS = {
	findBackupById: ["backups", () => findBackupById("id")],
	findBackupsByDbId: ["backups", () => findBackupsByDbId("id", "postgres")],
	findVolumeBackupById: ["volumeBackups", () => findVolumeBackupById("id")],
} as const;

/** The columns drizzle returns for a relation's `columns` option. */
const loadedColumns = (config: Record<string, boolean> | undefined) => {
	if (!config) return destinationColumns;
	const wanted = Object.entries(config).filter(([, on]) => on);
	return wanted.length > 0
		? wanted.map(([key]) => key)
		: destinationColumns.filter((key) => config[key] !== false);
};

beforeEach(() => {
	captured.args = {};
});

describe.each(Object.entries(FINDERS))(
	"the destination loaded by %s",
	(_name, [table, run]) => {
		const load = async () => {
			await run();
			const destination = captured.args[table]?.with?.destination;
			return loadedColumns(
				destination === true ? undefined : destination?.columns,
			);
		};

		it("loads exactly the allowlisted columns", async () => {
			const loaded = await load();

			expect(loaded.slice().sort()).toEqual([...DESTINATION_READ_KEYS].sort());
		});

		it("loads none of the destination's credential columns", async () => {
			const loaded = await load();

			expect(
				(EXCLUDED_COLUMNS.destinations ?? []).filter((column) =>
					loaded.includes(column),
				),
			).toEqual([]);
			for (const column of [
				"accessKey",
				"secretAccessKey",
				"encryptionKey",
				"encryptionPassword2",
				"additionalFlags",
			]) {
				expect(loaded).not.toContain(column);
			}
		});
	},
);
