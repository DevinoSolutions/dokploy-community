import { destinations } from "@dokploy/server/db/schema";
import { DESTINATION_READ_KEYS } from "@dokploy/server/services/backup-read-view";
import { getTableColumns } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXCLUDED_COLUMNS } from "./backup-read-view.excluded-columns";

/**
 * `compose.one`, `postgres.one` and the other service reads load the service's
 * backups with their destination. That row holds the encryption key, the second
 * encryption password and raw rclone flags, none of which a reader of the
 * service needs. The backup runners load the destination themselves
 * (findDestinationByIdForOrganization), so the nested one is a plain allowlist.
 */

const captured = vi.hoisted(() => ({
	args: {} as Record<string, { with?: Record<string, unknown> }>,
}));

vi.mock("@dokploy/server/db", () => {
	const table = (name: string) => ({
		findFirst: async (args: { with?: Record<string, unknown> }) => {
			captured.args[name] = args;
			return { [`${name}Id`]: "x" };
		},
	});
	return {
		db: {
			query: {
				compose: table("compose"),
				postgres: table("postgres"),
				mysql: table("mysql"),
				mariadb: table("mariadb"),
				mongo: table("mongo"),
				libsql: table("libsql"),
			},
		},
	};
});

const { findComposeById } = await import("@dokploy/server/services/compose");
const { findPostgresById } = await import("@dokploy/server/services/postgres");
const { findMySqlById } = await import("@dokploy/server/services/mysql");
const { findMariadbById } = await import("@dokploy/server/services/mariadb");
const { findMongoById } = await import("@dokploy/server/services/mongo");
const { findLibsqlById } = await import("@dokploy/server/services/libsql");

const FINDERS = {
	compose: findComposeById,
	postgres: findPostgresById,
	mysql: findMySqlById,
	mariadb: findMariadbById,
	mongo: findMongoById,
	libsql: findLibsqlById,
} as const;

/** The columns drizzle returns for a relation's `columns` option. */
const selectedColumns = (
	all: string[],
	config: Record<string, boolean> | undefined,
) => {
	if (!config) return all;
	const wanted = Object.entries(config).filter(([, on]) => on);
	return wanted.length > 0
		? wanted.map(([key]) => key)
		: all.filter((key) => config[key] !== false);
};

const destinationColumns = Object.keys(getTableColumns(destinations));

const loadedDestinationColumns = (name: keyof typeof FINDERS) => {
	const backups = captured.args[name]?.with?.backups as
		| {
				with?: {
					destination?: { columns?: Record<string, boolean> } | true;
				};
		  }
		| undefined;
	const destination = backups?.with?.destination;
	return selectedColumns(
		destinationColumns,
		destination === true ? undefined : destination?.columns,
	);
};

beforeEach(() => {
	captured.args = {};
});

describe.each(Object.entries(FINDERS))(
	"the destination nested in %s's backups",
	(name, finder) => {
		it("loads exactly the allowlisted columns", async () => {
			await finder("id");

			const loaded = loadedDestinationColumns(name as keyof typeof FINDERS);

			// Every table column is either loaded because it is allowed, or not
			// loaded: a column added to the table, or a switch to a deny list, that
			// would load something unreviewed fails here.
			expect(loaded.slice().sort()).toEqual([...DESTINATION_READ_KEYS].sort());
			expect(
				destinationColumns.filter(
					(column) =>
						loaded.includes(column) !==
						(DESTINATION_READ_KEYS as readonly string[]).includes(column),
				),
			).toEqual([]);
		});

		it("loads none of the destination's excluded columns", async () => {
			await finder("id");

			const loaded = loadedDestinationColumns(name as keyof typeof FINDERS);

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
