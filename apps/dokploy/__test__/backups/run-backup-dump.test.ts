import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findPostgresByBackupId: vi.fn(),
	findMySqlByBackupId: vi.fn(),
	findMariadbByBackupId: vi.fn(),
	findMongoByBackupId: vi.fn(),
	findLibsqlByBackupId: vi.fn(),
	findComposeByBackupId: vi.fn(),
	runPostgresBackup: vi.fn(),
	runMySqlBackup: vi.fn(),
	runMariadbBackup: vi.fn(),
	runMongoBackup: vi.fn(),
	runLibsqlBackup: vi.fn(),
	runComposeBackup: vi.fn(),
	keepLatestNBackups: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	findPostgresByBackupId: mocks.findPostgresByBackupId,
	findMySqlByBackupId: mocks.findMySqlByBackupId,
	findMariadbByBackupId: mocks.findMariadbByBackupId,
	findMongoByBackupId: mocks.findMongoByBackupId,
	findLibsqlByBackupId: mocks.findLibsqlByBackupId,
	findComposeByBackupId: mocks.findComposeByBackupId,
	runPostgresBackup: mocks.runPostgresBackup,
	runMySqlBackup: mocks.runMySqlBackup,
	runMariadbBackup: mocks.runMariadbBackup,
	runMongoBackup: mocks.runMongoBackup,
	runLibsqlBackup: mocks.runLibsqlBackup,
	keepLatestNBackups: mocks.keepLatestNBackups,
}));
vi.mock("@dokploy/server/utils/backups/compose", () => ({
	runComposeBackup: mocks.runComposeBackup,
}));

const { runBackupDump } = await import("@/server/utils/run-backup-dump");

const backup = { backupId: "backup-1" } as never;

const CASES = [
	["postgres", "findPostgresByBackupId", "runPostgresBackup"],
	["mysql", "findMySqlByBackupId", "runMySqlBackup"],
	["mariadb", "findMariadbByBackupId", "runMariadbBackup"],
	["mongo", "findMongoByBackupId", "runMongoBackup"],
	["libsql", "findLibsqlByBackupId", "runLibsqlBackup"],
	["compose", "findComposeByBackupId", "runComposeBackup"],
] as const;

describe("runBackupDump", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each(CASES)(
		"%s: loads the service, runs the dump, then applies retention",
		async (target, finder, runner) => {
			const order: string[] = [];
			const service = { serverId: `${target}-server` };
			mocks[finder].mockImplementation(async (backupId: string) => {
				order.push(`find:${backupId}`);
				return service;
			});
			mocks[runner].mockImplementation(async () => {
				order.push("run");
			});
			mocks.keepLatestNBackups.mockImplementation(async () => {
				order.push("retain");
			});

			await runBackupDump(target, backup);

			expect(order).toEqual(["find:backup-1", "run", "retain"]);
			expect(mocks[runner]).toHaveBeenCalledWith(service, backup);
			expect(mocks.keepLatestNBackups).toHaveBeenCalledWith(
				backup,
				`${target}-server`,
			);
			// No other service kind is touched.
			for (const [, otherFinder, otherRunner] of CASES) {
				if (otherRunner === runner) continue;
				expect(mocks[otherFinder]).not.toHaveBeenCalled();
				expect(mocks[otherRunner]).not.toHaveBeenCalled();
			}
		},
	);

	it("refuses the instance backup and unknown kinds without running anything", async () => {
		await expect(runBackupDump("web-server", backup)).rejects.toThrow(
			'Unsupported database type "web-server"',
		);
		await expect(runBackupDump("sqlite", backup)).rejects.toThrow(
			'Unsupported database type "sqlite"',
		);
		expect(mocks.keepLatestNBackups).not.toHaveBeenCalled();
		for (const [, finder, runner] of CASES) {
			expect(mocks[finder]).not.toHaveBeenCalled();
			expect(mocks[runner]).not.toHaveBeenCalled();
		}
	});

	it("skips retention when the dump fails", async () => {
		mocks.findPostgresByBackupId.mockResolvedValue({ serverId: null });
		mocks.runPostgresBackup.mockRejectedValue(new Error("dump failed"));

		await expect(runBackupDump("postgres", backup)).rejects.toThrow(
			"dump failed",
		);
		expect(mocks.keepLatestNBackups).not.toHaveBeenCalled();
	});
});
