import type { BackupSchedule } from "@dokploy/server/services/backup";
import {
	getBackupServerId,
	shouldSkipStoppedBackup,
} from "@dokploy/server/utils/backups/utils";
import { describe, expect, it } from "vitest";

// A "backup everything" policy materializes a schedule for every database,
// including intentionally stopped ones. Those scheduled runs must skip instead
// of erroring on every tick; manual ("run now") runs must still report the
// failure the user asked for.

const decide = (
	overrides: Partial<Parameters<typeof shouldSkipStoppedBackup>[0]> = {},
) =>
	shouldSkipStoppedBackup({
		trigger: "schedule",
		backupType: "database",
		databaseType: "postgres",
		targetState: "stopped",
		...overrides,
	});

describe("shouldSkipStoppedBackup", () => {
	it("skips a scheduled run when the database container is stopped", () => {
		expect(decide()).toBe(true);
	});

	it("runs a scheduled backup when the container is running", () => {
		expect(decide({ targetState: "running" })).toBe(false);
	});

	it("never skips when the state could not be determined", () => {
		// docker/SSH unreachable must surface as a real error, not a silent skip.
		expect(decide({ targetState: "unknown" })).toBe(false);
	});

	it("never skips a manual run, even when stopped", () => {
		expect(decide({ trigger: "manual" })).toBe(false);
		expect(decide({ trigger: "manual", targetState: "running" })).toBe(false);
	});

	it("applies to every dump-capable database type", () => {
		for (const databaseType of [
			"postgres",
			"mysql",
			"mariadb",
			"mongo",
			"libsql",
		] as const) {
			expect(decide({ databaseType })).toBe(true);
		}
	});

	it("applies to compose backups", () => {
		expect(decide({ backupType: "compose", databaseType: "mysql" })).toBe(true);
	});

	it("never skips web-server backups", () => {
		expect(decide({ databaseType: "web-server" })).toBe(false);
	});
});

describe("getBackupServerId", () => {
	const base = {
		backupType: "database",
		postgres: null,
		mysql: null,
		mariadb: null,
		mongo: null,
		libsql: null,
		compose: null,
	} as unknown as BackupSchedule;

	it("returns null for a database on the Dokploy host", () => {
		expect(
			getBackupServerId({
				...base,
				mysql: { serverId: null },
			} as unknown as BackupSchedule),
		).toBe(null);
	});

	it("returns the database's server", () => {
		expect(
			getBackupServerId({
				...base,
				mariadb: { serverId: "server-1" },
			} as unknown as BackupSchedule),
		).toBe("server-1");
	});

	it("returns the compose's server for compose backups", () => {
		expect(
			getBackupServerId({
				...base,
				backupType: "compose",
				postgres: { serverId: "wrong" },
				compose: { serverId: "server-2" },
			} as unknown as BackupSchedule),
		).toBe("server-2");
	});
});
