import { backups, volumeBackups } from "@dokploy/server/db/schema";
import {
	BACKUP_SERVICE_ID_KEYS,
	COMPOSE_FIRST_BACKUP_SERVICE_ID_KEYS,
	COMPOSE_SECOND_VOLUME_BACKUP_SERVICE_KEYS,
	getBackupServiceId,
	getBackupServiceIds,
	getVolumeBackupServiceId,
	getVolumeBackupServiceIds,
	LIBSQL_BEFORE_REDIS_VOLUME_BACKUP_SERVICE_KEYS,
	VOLUME_BACKUP_SERVICE_KEYS,
} from "@dokploy/server/services/backup-service-ids";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

describe("getBackupServiceIds", () => {
	it("returns the one id of a well-formed row, whatever its kind", () => {
		for (const key of BACKUP_SERVICE_ID_KEYS) {
			expect(getBackupServiceIds({ [key]: "svc-1" })).toEqual(["svc-1"]);
			expect(getBackupServiceId({ [key]: "svc-1" })).toBe("svc-1");
		}
	});

	it("returns nothing for an instance backup row", () => {
		const row = {
			postgresId: null,
			mysqlId: null,
			mariadbId: null,
			mongoId: null,
			libsqlId: null,
			composeId: null,
		};
		expect(getBackupServiceIds(row)).toEqual([]);
		expect(getBackupServiceId(row)).toBeNull();
		expect(getBackupServiceId({})).toBeNull();
	});

	it("lists every id of a malformed row, first id first", () => {
		const row = { composeId: "compose-1", postgresId: "pg-1" };
		expect(getBackupServiceIds(row)).toEqual(["pg-1", "compose-1"]);
		expect(getBackupServiceId(row)).toBe("pg-1");
	});

	it("covers every service column of the backups table", () => {
		const serviceColumns = Object.keys(getTableColumns(backups)).filter(
			(column) => column.endsWith("Id") && column !== "backupId",
		);
		const nonServiceColumns = [
			"destinationId",
			"userId",
			"backupPolicyId",
			"appId",
		];
		const expected = serviceColumns.filter(
			(column) => !nonServiceColumns.includes(column),
		);
		expect([...BACKUP_SERVICE_ID_KEYS].sort()).toEqual(expected.sort());
	});
});

describe("getVolumeBackupServiceIds", () => {
	it("returns the one id of a well-formed row, whatever its kind", () => {
		for (const key of VOLUME_BACKUP_SERVICE_KEYS) {
			expect(getVolumeBackupServiceIds({ [key]: "svc-1" })).toEqual(["svc-1"]);
			expect(getVolumeBackupServiceId({ [key]: "svc-1" })).toBe("svc-1");
		}
	});

	it("returns null for a row that points at no service", () => {
		expect(getVolumeBackupServiceIds({ applicationId: null })).toEqual([]);
		expect(getVolumeBackupServiceId({ applicationId: null })).toBeNull();
		expect(getVolumeBackupServiceId({})).toBeNull();
	});

	it("keeps the application, database, redis, libsql, compose order", () => {
		const row = {
			composeId: "compose-1",
			libsqlId: "libsql-1",
			redisId: "redis-1",
			applicationId: "app-1",
		};
		expect(getVolumeBackupServiceIds(row)).toEqual([
			"app-1",
			"redis-1",
			"libsql-1",
			"compose-1",
		]);
		expect(getVolumeBackupServiceId(row)).toBe("app-1");
	});

	it("covers every service column of the volume_backup table", () => {
		const serviceColumns = Object.keys(getTableColumns(volumeBackups)).filter(
			(column) => column.endsWith("Id"),
		);
		const nonServiceColumns = [
			"volumeBackupId",
			"destinationId",
			"backupPolicyId",
		];
		const expected = serviceColumns.filter(
			(column) => !nonServiceColumns.includes(column),
		);
		expect([...VOLUME_BACKUP_SERVICE_KEYS].sort()).toEqual(expected.sort());
	});
});

describe("explicit key orders for multi-id rows", () => {
	it("tries compose first with the compose-first dump order", () => {
		const row = { postgresId: "pg-1", libsqlId: "libsql-1", composeId: "c-1" };
		expect(getBackupServiceId(row)).toBe("pg-1");
		expect(getBackupServiceId(row, COMPOSE_FIRST_BACKUP_SERVICE_ID_KEYS)).toBe(
			"c-1",
		);
		expect(
			getBackupServiceIds(row, COMPOSE_FIRST_BACKUP_SERVICE_ID_KEYS),
		).toEqual(["c-1", "pg-1", "libsql-1"]);
	});

	it("tries compose right after the application with the compose-second volume order", () => {
		const row = { applicationId: "app-1", redisId: "r-1", composeId: "c-1" };
		expect(getVolumeBackupServiceId(row)).toBe("app-1");
		expect(
			getVolumeBackupServiceIds(row, COMPOSE_SECOND_VOLUME_BACKUP_SERVICE_KEYS),
		).toEqual(["app-1", "c-1", "r-1"]);
		const noApp = { redisId: "r-1", composeId: "c-1" };
		expect(getVolumeBackupServiceId(noApp)).toBe("r-1");
		expect(
			getVolumeBackupServiceId(
				noApp,
				COMPOSE_SECOND_VOLUME_BACKUP_SERVICE_KEYS,
			),
		).toBe("c-1");
	});

	it("tries libsql before redis with the libsql-before-redis volume order", () => {
		const row = { redisId: "r-1", libsqlId: "l-1" };
		expect(getVolumeBackupServiceId(row)).toBe("r-1");
		expect(
			getVolumeBackupServiceId(
				row,
				LIBSQL_BEFORE_REDIS_VOLUME_BACKUP_SERVICE_KEYS,
			),
		).toBe("l-1");
	});

	it("keeps every named order a permutation of its key list", () => {
		expect([...COMPOSE_FIRST_BACKUP_SERVICE_ID_KEYS].sort()).toEqual(
			[...BACKUP_SERVICE_ID_KEYS].sort(),
		);
		expect([...COMPOSE_SECOND_VOLUME_BACKUP_SERVICE_KEYS].sort()).toEqual(
			[...VOLUME_BACKUP_SERVICE_KEYS].sort(),
		);
		expect([...LIBSQL_BEFORE_REDIS_VOLUME_BACKUP_SERVICE_KEYS].sort()).toEqual(
			[...VOLUME_BACKUP_SERVICE_KEYS].sort(),
		);
	});
});
