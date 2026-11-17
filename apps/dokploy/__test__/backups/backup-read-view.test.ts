import {
	compose,
	destinations,
	environments,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	projects,
	redis,
} from "@dokploy/server/db/schema";
import {
	DESTINATION_READ_COLUMNS,
	DESTINATION_READ_KEYS,
	ENVIRONMENT_READ_KEYS,
	PROJECT_READ_KEYS,
	redactBackupMetadata,
	SERVICE_RELATION_KEYS,
	toBackupReadView,
	toVolumeBackupReadView,
} from "@dokploy/server/services/backup-read-view";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { EXCLUDED_COLUMNS } from "./backup-read-view.excluded-columns";

/**
 * The views copy related rows through an allowlist. These tests keep that list
 * honest: every column of every table the finders load whole has to be either
 * allowed in the view or listed as excluded, so a credential column added to
 * one of them cannot reach the client by being forgotten.
 */

// The tables findBackupById / findVolumeBackupById load with a bare relation.
// (`application` is not here: its finder already projects three columns.)
const CLASSIFIED = {
	postgres: { table: postgres, allowed: SERVICE_RELATION_KEYS.postgres },
	mysql: { table: mysql, allowed: SERVICE_RELATION_KEYS.mysql },
	mariadb: { table: mariadb, allowed: SERVICE_RELATION_KEYS.mariadb },
	mongo: { table: mongo, allowed: SERVICE_RELATION_KEYS.mongo },
	redis: { table: redis, allowed: SERVICE_RELATION_KEYS.redis },
	libsql: { table: libsql, allowed: SERVICE_RELATION_KEYS.libsql },
	compose: { table: compose, allowed: SERVICE_RELATION_KEYS.compose },
	destinations: { table: destinations, allowed: DESTINATION_READ_KEYS },
	environments: { table: environments, allowed: ENVIRONMENT_READ_KEYS },
	projects: { table: projects, allowed: PROJECT_READ_KEYS },
} as const;

describe.each(Object.entries(CLASSIFIED))(
	"column classification of %s",
	(name, { table, allowed }) => {
		const columns = Object.keys(getTableColumns(table));
		const excluded = EXCLUDED_COLUMNS[name] ?? [];

		it("has no column that is neither allowed nor excluded", () => {
			const unclassified = columns.filter(
				(column) =>
					!(allowed as readonly string[]).includes(column) &&
					!excluded.includes(column),
			);

			// A new column lands here. Allow it in backup-read-view.ts only if it is
			// not a credential and the client needs it; otherwise add it to
			// backup-read-view.excluded-columns.ts.
			expect(unclassified).toEqual([]);
		});

		it("does not allow and exclude the same column", () => {
			expect(
				excluded.filter((column) =>
					(allowed as readonly string[]).includes(column),
				),
			).toEqual([]);
		});

		it("names only columns that exist", () => {
			expect(
				[...allowed, ...excluded].filter((column) => !columns.includes(column)),
			).toEqual([]);
		});
	},
);

describe("the destination column projection", () => {
	it("selects exactly the allowed destination keys", () => {
		expect(Object.keys(DESTINATION_READ_COLUMNS).sort()).toEqual(
			[...DESTINATION_READ_KEYS].sort(),
		);
		expect(Object.values(DESTINATION_READ_COLUMNS).every(Boolean)).toBe(true);
	});

	it("never selects a credential column of the destination table", () => {
		for (const column of [
			"accessKey",
			"secretAccessKey",
			"encryptionKey",
			"encryptionPassword2",
			"additionalFlags",
		]) {
			expect(Object.keys(DESTINATION_READ_COLUMNS)).not.toContain(column);
		}
	});
});

describe("the type of a view", () => {
	it("no longer names a removed field", () => {
		const view = toBackupReadView(
			{
				backupId: "b",
				metadata: { mysql: { databaseRootPassword: "x" } },
				postgres: { postgresId: "p", name: "n", databasePassword: "x" },
				compose: null as { composeId: string; refreshToken: string } | null,
				destination: { destinationId: "d", encryptionKey: "x" },
			},
			{ canUpdate: true },
		);

		expect(view.postgres.postgresId).toBe("p");
		// @ts-expect-error databasePassword is not part of the view
		expect(view.postgres.databasePassword).toBeUndefined();
		// @ts-expect-error refreshToken is not part of the view
		expect(view.compose?.refreshToken).toBeUndefined();
		// @ts-expect-error encryptionKey is not part of the view
		expect(view.destination.encryptionKey).toBeUndefined();
		// The top-level columns keep their type.
		expect(view.backupId).toBe("b");
	});

	it("narrows an environment and its project inside a volume backup's service", () => {
		const view = toVolumeBackupReadView({
			volumeBackupId: "v",
			postgres: {
				postgresId: "p",
				databasePassword: "x",
				environment: {
					environmentId: "e",
					env: "x",
					project: { projectId: "pr", env: "x", organizationId: "o" },
				},
			},
		});

		expect(view.postgres.environment.project.organizationId).toBe("o");
		// @ts-expect-error the environment env is not part of the view
		expect(view.postgres.environment.env).toBeUndefined();
		// @ts-expect-error the project env is not part of the view
		expect(view.postgres.environment.project.env).toBeUndefined();
	});
});

describe("redactBackupMetadata", () => {
	const strings = (value: unknown, path = ""): string[] => {
		if (typeof value === "string") return value ? [path] : [];
		if (Array.isArray(value)) {
			return value.flatMap((item, index) => strings(item, `${path}[${index}]`));
		}
		if (typeof value === "object" && value !== null) {
			return Object.entries(value).flatMap(([key, inner]) =>
				strings(inner, `${path}.${key}`),
			);
		}
		return [];
	};

	it("keeps only the database user and the service name, whatever the shape", () => {
		const result = redactBackupMetadata({
			serviceName: "db",
			postgres: { databaseUser: "pg", databasePassword: "s1" },
			mysql: { databaseRootPassword: "s2" },
			// A credential under a name nobody listed, nested, in an array.
			future: {
				connection: { user: "u", dsn: "postgres://u:s3@h/db" },
				hosts: [{ name: "a", apiToken: "s4" }],
				ttl: 30,
				enabled: true,
			},
		});

		expect(result).toEqual({
			serviceName: "db",
			postgres: { databaseUser: "pg", databasePassword: "" },
			mysql: { databaseRootPassword: "" },
			future: {
				connection: { user: "", dsn: "" },
				hosts: [{ name: "", apiToken: "" }],
				ttl: null,
				enabled: null,
			},
		});
		expect(strings(result)).toEqual([".serviceName", ".postgres.databaseUser"]);
	});

	it("does not keep a database user that is an object, which could hide one", () => {
		expect(
			redactBackupMetadata({ mongo: { databaseUser: { name: "u", pw: "s" } } }),
		).toEqual({ mongo: { databaseUser: { name: "", pw: "" } } });
	});

	it("passes null and undefined through, and stops at a bounded depth", () => {
		expect(redactBackupMetadata(null)).toBeNull();
		expect(redactBackupMetadata(undefined)).toBeUndefined();

		let deep: Record<string, unknown> = { secret: "s" };
		for (let i = 0; i < 20; i++) deep = { next: deep };
		expect(JSON.stringify(redactBackupMetadata(deep))).not.toContain('"s"');
	});

	it("does not change its input", () => {
		const input = { mysql: { databaseRootPassword: "s" } };
		redactBackupMetadata(input);
		expect(input.mysql.databaseRootPassword).toBe("s");
	});
});

describe("redactBackupMetadata with a visible key that is not a string", () => {
	it("blanks an array under databaseUser or serviceName", () => {
		expect(
			redactBackupMetadata({
				serviceName: ["db-password"],
				mysql: { databaseUser: ["pw"] },
			}),
		).toEqual({ serviceName: [""], mysql: { databaseUser: [""] } });
	});

	it("blanks a number or boolean under a visible key", () => {
		expect(
			redactBackupMetadata({
				mongo: { databaseUser: 12345, serviceName: true },
			}),
		).toEqual({ mongo: { databaseUser: null, serviceName: null } });
	});
});
