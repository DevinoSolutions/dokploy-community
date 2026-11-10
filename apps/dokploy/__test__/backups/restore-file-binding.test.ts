import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
	query: { backups: { findMany: vi.fn() } },
}));
vi.mock("@dokploy/server/db", () => ({ db: mockDb }));
vi.mock("@dokploy/server/services/destination", () => ({
	findDestinationById: vi.fn(),
}));

const { isBackupFileInPrefixes } = await import(
	"@dokploy/server/db/validations/backup"
);
const { assertBackupFileBelongsToService } = await import(
	"@dokploy/server/services/backup"
);

// The fork writes `normalizeS3Path(prefix)` + file, with no per-service folder,
// so a restore is bound to the prefixes the service's own backups write to.
describe("isBackupFileInPrefixes", () => {
	it("accepts a file below one of the prefixes (slashes around the prefix ignored)", () => {
		expect(isBackupFileInPrefixes("daily/pg/x.sql.gz", ["/daily/pg/"])).toBe(
			true,
		);
		expect(
			isBackupFileInPrefixes("daily/pg/x.sql.gz", ["other", "daily/pg"]),
		).toBe(true);
	});

	it("refuses a file outside every prefix, including a sibling that only shares the start", () => {
		expect(isBackupFileInPrefixes("other/x.sql.gz", ["daily/pg"])).toBe(false);
		expect(isBackupFileInPrefixes("daily/pg-2/x.sql.gz", ["daily/pg"])).toBe(
			false,
		);
		expect(isBackupFileInPrefixes("x.sql.gz", [])).toBe(false);
	});

	it("refuses '..' segments, even when the start matches a prefix", () => {
		expect(
			isBackupFileInPrefixes("daily/pg/../other/x.sql.gz", ["daily/pg"]),
		).toBe(false);
		expect(isBackupFileInPrefixes("../x.sql.gz", ["/"])).toBe(false);
		// a name that merely contains dots is fine
		expect(isBackupFileInPrefixes("daily/pg/x..y.sql.gz", ["daily/pg"])).toBe(
			true,
		);
	});

	it("refuses an absolute path, even under a root prefix", () => {
		expect(isBackupFileInPrefixes("/daily/pg/x.sql.gz", ["daily/pg"])).toBe(
			false,
		);
		expect(isBackupFileInPrefixes("/etc/passwd", ["/"])).toBe(false);
	});

	it("lets a root prefix cover the destination, as the backups themselves do", () => {
		expect(isBackupFileInPrefixes("x.sql.gz", ["/"])).toBe(true);
		expect(isBackupFileInPrefixes("any/folder/x.sql.gz", [""])).toBe(true);
	});
});

describe("assertBackupFileBelongsToService", () => {
	beforeEach(() => mockDb.query.backups.findMany.mockReset());

	it("allows a file under the prefix of a backup of the service", async () => {
		mockDb.query.backups.findMany.mockResolvedValue([{ prefix: "daily/pg/" }]);
		await expect(
			assertBackupFileBelongsToService("pg-1", "daily/pg/x.sql.gz"),
		).resolves.toBeUndefined();
	});

	it("refuses another service's folder, '..' and absolute paths with UNAUTHORIZED", async () => {
		mockDb.query.backups.findMany.mockResolvedValue([{ prefix: "daily/pg" }]);
		for (const file of [
			"daily/mysql/x.sql.gz",
			"daily/pg/../mysql/x.sql.gz",
			"/daily/pg/x.sql.gz",
		]) {
			await expect(
				assertBackupFileBelongsToService("pg-1", file),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		}
	});

	it("lets an owner or admin restore from any prefix, but never '..' or an absolute path", async () => {
		mockDb.query.backups.findMany.mockResolvedValue([{ prefix: "daily/pg" }]);
		await expect(
			assertBackupFileBelongsToService("pg-1", "renamed/pg/x.sql.gz", {
				anyPrefix: true,
			}),
		).resolves.toBeUndefined();
		// also for a recreated database with no backup row yet
		mockDb.query.backups.findMany.mockResolvedValue([]);
		await expect(
			assertBackupFileBelongsToService("pg-2", "old-project/x.sql.gz", {
				anyPrefix: true,
			}),
		).resolves.toBeUndefined();
		for (const file of ["../x.sql.gz", "a/../../x.sql.gz", "/etc/x.sql.gz"]) {
			await expect(
				assertBackupFileBelongsToService("pg-1", file, { anyPrefix: true }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		}
	});

	it("keeps a member bound to the current prefixes", async () => {
		mockDb.query.backups.findMany.mockResolvedValue([{ prefix: "daily/pg" }]);
		await expect(
			assertBackupFileBelongsToService("pg-1", "renamed/pg/x.sql.gz", {
				anyPrefix: false,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("refuses every file when the service has no backup at all", async () => {
		mockDb.query.backups.findMany.mockResolvedValue([]);
		await expect(
			assertBackupFileBelongsToService("pg-1", "daily/pg/x.sql.gz"),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
