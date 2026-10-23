import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	scheduleJob: vi.fn(),
	runMySqlBackup: vi.fn(),
	runPostgresBackup: vi.fn(),
	runComposeBackup: vi.fn(),
	runWebServerBackup: vi.fn(),
	keepLatestNBackups: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("node-schedule", () => ({
	scheduleJob: mocks.scheduleJob,
	scheduledJobs: {},
}));

vi.mock("@dokploy/server/lib/logger", () => ({
	logger: { error: mocks.loggerError, info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@dokploy/server/utils/backups/index", () => ({
	keepLatestNBackups: mocks.keepLatestNBackups,
}));

vi.mock("@dokploy/server/utils/backups/concurrency", () => ({
	withBackupSlot: async (_key: unknown, _id: string, fn: () => Promise<void>) =>
		fn(),
}));

vi.mock("@dokploy/server/utils/backups/mysql", () => ({
	runMySqlBackup: mocks.runMySqlBackup,
}));
vi.mock("@dokploy/server/utils/backups/postgres", () => ({
	runPostgresBackup: mocks.runPostgresBackup,
}));
vi.mock("@dokploy/server/utils/backups/compose", () => ({
	runComposeBackup: mocks.runComposeBackup,
}));
vi.mock("@dokploy/server/utils/backups/web-server", () => ({
	runWebServerBackup: mocks.runWebServerBackup,
}));
vi.mock("@dokploy/server/utils/backups/mariadb", () => ({
	runMariadbBackup: vi.fn(),
}));
vi.mock("@dokploy/server/utils/backups/mongo", () => ({
	runMongoBackup: vi.fn(),
}));
vi.mock("@dokploy/server/utils/backups/libsql", () => ({
	runLibsqlBackup: vi.fn(),
}));

const { scheduleBackup } = await import("@dokploy/server/utils/backups/utils");

const noServices = {
	postgresId: null,
	mysqlId: null,
	mariadbId: null,
	mongoId: null,
	libsqlId: null,
	composeId: null,
	postgres: null,
	mysql: null,
	mariadb: null,
	mongo: null,
	libsql: null,
	compose: null,
};

const runScheduled = async (row: Record<string, unknown>) => {
	scheduleBackup({
		backupId: "b-1",
		schedule: "0 0 * * *",
		...noServices,
		...row,
	} as never);
	const tick = mocks.scheduleJob.mock.calls[0]?.[2] as () => Promise<void>;
	await tick();
};

describe("scheduled backups only run rows bound to exactly one matching service", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("refuses a database backup that carries a second service of another organization", async () => {
		await runScheduled({
			backupType: "database",
			databaseType: "mysql",
			postgresId: "pg-own",
			mysqlId: "mysql-foreign",
			postgres: { postgresId: "pg-own" },
			mysql: { mysqlId: "mysql-foreign" },
		});

		expect(mocks.runMySqlBackup).not.toHaveBeenCalled();
		expect(mocks.runPostgresBackup).not.toHaveBeenCalled();
		expect(mocks.loggerError).toHaveBeenCalledTimes(1);
	});

	it("refuses a compose backup that also carries a database service id", async () => {
		await runScheduled({
			backupType: "compose",
			databaseType: "mysql",
			composeId: "compose-own",
			mysqlId: "mysql-foreign",
			compose: { composeId: "compose-own" },
			mysql: { mysqlId: "mysql-foreign" },
		});

		expect(mocks.runComposeBackup).not.toHaveBeenCalled();
		expect(mocks.runMySqlBackup).not.toHaveBeenCalled();
	});

	it("refuses a web-server backup that is attached to a service", async () => {
		await runScheduled({
			backupType: "database",
			databaseType: "web-server",
			postgresId: "pg-own",
			postgres: { postgresId: "pg-own" },
		});

		expect(mocks.runWebServerBackup).not.toHaveBeenCalled();
	});

	it("runs a well-formed database backup", async () => {
		await runScheduled({
			backupType: "database",
			databaseType: "mysql",
			mysqlId: "mysql-own",
			mysql: { mysqlId: "mysql-own", serverId: null },
		});

		expect(mocks.runMySqlBackup).toHaveBeenCalledTimes(1);
	});

	it("runs a well-formed compose backup", async () => {
		await runScheduled({
			backupType: "compose",
			databaseType: "postgres",
			composeId: "compose-own",
			compose: { composeId: "compose-own", serverId: null },
		});

		expect(mocks.runComposeBackup).toHaveBeenCalledTimes(1);
	});
});
