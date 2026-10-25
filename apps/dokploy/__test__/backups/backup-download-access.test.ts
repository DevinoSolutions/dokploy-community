import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findBackupById: vi.fn(),
	findServerById: vi.fn(),
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findServiceOrganizationId: vi.fn(),
	findDestinationRow: vi.fn(),
	getBackupDownloadUrl: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: { destinations: { findFirst: mocks.findDestinationRow } } },
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	findServiceOrganizationId: mocks.findServiceOrganizationId,
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findBackupById: mocks.findBackupById,
	findServerById: mocks.findServerById,
	scheduleBackup: vi.fn(),
	removeScheduleBackup: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@dokploy/server/utils/restore", () => ({}));
vi.mock("@dokploy/server/utils/backups/compose", () => ({
	runComposeBackup: vi.fn(),
}));
vi.mock("@dokploy/server/utils/backups/utils", () => ({
	buildRcloneCommand: vi.fn(),
	getBackupServerId: (backup: {
		postgres?: { serverId?: string | null } | null;
	}) => backup.postgres?.serverId ?? null,
	getRclonePathAndFlags: vi.fn(),
	normalizeS3Path: vi.fn(),
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));
vi.mock("@dokploy/server/utils/backups/files", () => ({
	getBackupDownloadUrl: mocks.getBackupDownloadUrl,
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));
vi.mock("@/server/api/utils/plan-limits", () => ({
	assertDatabaseBackupLimit: vi.fn(),
}));
vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
	updateJob: vi.fn(),
}));

const { backupRouter } = await import("@/server/api/routers/backup");

type Role = "owner" | "admin" | "member";

const callerAs = (role: Role, organizationId = "org-a") =>
	backupRouter.createCaller({
		session: { activeOrganizationId: organizationId },
		user: { id: "user-1", email: "user@example.com", role },
	} as Parameters<typeof backupRouter.createCaller>[0]);

const ownDestination = { destinationId: "dest-a", organizationId: "org-a" };
const foreignDestination = { destinationId: "dest-b", organizationId: "org-b" };

const noService = {
	postgresId: null,
	mysqlId: null,
	mariadbId: null,
	mongoId: null,
	libsqlId: null,
	composeId: null,
};

const serviceBackup = {
	...noService,
	backupId: "pg-backup",
	databaseType: "postgres",
	backupType: "database",
	destinationId: "dest-a",
	postgresId: "pg-1",
	postgres: { serverId: null },
};

const instanceBackup = {
	...noService,
	backupId: "ws-1",
	databaseType: "web-server",
	backupType: "database",
	destinationId: "dest-a",
};

const input = {
	backupId: "pg-backup",
	fileName: "2026-10-24T10-00-00Z.sql.gz",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkPermission.mockResolvedValue(undefined);
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findServiceOrganizationId.mockResolvedValue("org-a");
	mocks.findBackupById.mockResolvedValue(serviceBackup);
	mocks.findDestinationRow.mockResolvedValue(ownDestination);
	mocks.findServerById.mockResolvedValue({
		serverId: "srv-1",
		organizationId: "org-a",
	});
	mocks.getBackupDownloadUrl.mockResolvedValue({ url: "https://s3/x" });
	mocks.audit.mockResolvedValue(undefined);
});

const expectNoLink = () => {
	expect(mocks.getBackupDownloadUrl).not.toHaveBeenCalled();
	expect(mocks.audit).not.toHaveBeenCalled();
};

describe("backup.getDownloadUrl access", () => {
	it("hands out the link of an own backup and records the download", async () => {
		const result = await callerAs("admin").getDownloadUrl(input);

		expect(result).toEqual({ url: "https://s3/x" });
		expect(mocks.getBackupDownloadUrl).toHaveBeenCalledWith({
			backup: serviceBackup,
			destination: ownDestination,
			serverId: null,
			fileName: input.fileName,
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.objectContaining({ session: { activeOrganizationId: "org-a" } }),
			{
				action: "download",
				resourceType: "backup",
				resourceId: "pg-backup",
				metadata: { file: input.fileName },
			},
		);
	});

	it("takes the restore permission, not just read", async () => {
		mocks.checkPermission.mockRejectedValue(
			new TRPCError({ code: "UNAUTHORIZED", message: "no" }),
		);

		await expect(
			callerAs("member").getDownloadUrl(input),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			backup: ["restore"],
		});
		expect(mocks.findBackupById).not.toHaveBeenCalled();
		expectNoLink();
	});

	it("takes the restore permission on the service, so a member needs access to it", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new TRPCError({ code: "UNAUTHORIZED", message: "no access" }),
		);

		await expect(
			callerAs("member").getDownloadUrl(input),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"pg-1",
			{ backup: ["restore"] },
		);
		expectNoLink();
	});

	it("answers an unknown backup with not found", async () => {
		mocks.findBackupById.mockRejectedValue(
			new TRPCError({ code: "NOT_FOUND", message: "Backup not found" }),
		);

		await expect(callerAs("owner").getDownloadUrl(input)).rejects.toMatchObject(
			{
				code: "NOT_FOUND",
			},
		);
		expectNoLink();
	});

	it("answers the backup of a service of another organization like a missing one", async () => {
		mocks.findServiceOrganizationId.mockResolvedValue("org-b");

		await expect(callerAs("owner").getDownloadUrl(input)).rejects.toMatchObject(
			{
				code: "NOT_FOUND",
				message: "Backup not found",
			},
		);
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		expectNoLink();
	});

	it("refuses a destination of another organization", async () => {
		mocks.findDestinationRow.mockResolvedValue(foreignDestination);

		await expect(callerAs("owner").getDownloadUrl(input)).rejects.toMatchObject(
			{
				code: "UNAUTHORIZED",
				message: "You don't have access to this destination.",
			},
		);
		expectNoLink();
	});

	it("refuses a server of another organization", async () => {
		mocks.findBackupById.mockResolvedValue({
			...serviceBackup,
			postgres: { serverId: "srv-1" },
		});
		mocks.findServerById.mockResolvedValue({
			serverId: "srv-1",
			organizationId: "org-b",
		});

		await expect(callerAs("owner").getDownloadUrl(input)).rejects.toMatchObject(
			{
				code: "UNAUTHORIZED",
				message: "You don't have access to this server.",
			},
		);
		expectNoLink();
	});

	it("runs the link on the server of the service", async () => {
		mocks.findBackupById.mockResolvedValue({
			...serviceBackup,
			postgres: { serverId: "srv-1" },
		});

		await callerAs("owner").getDownloadUrl(input);

		expect(mocks.getBackupDownloadUrl).toHaveBeenCalledWith(
			expect.objectContaining({ serverId: "srv-1" }),
		);
	});

	it("keeps the instance backup to owners and admins of the organization", async () => {
		mocks.findBackupById.mockResolvedValue(instanceBackup);
		const webServerInput = { backupId: "ws-1", fileName: "webserver-x.zip" };

		await expect(
			callerAs("member").getDownloadUrl(webServerInput),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expectNoLink();

		await expect(
			callerAs("admin").getDownloadUrl(webServerInput),
		).resolves.toEqual({ url: "https://s3/x" });
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
	});

	it("answers an instance backup of another organization like a missing one", async () => {
		mocks.findBackupById.mockResolvedValue(instanceBackup);
		mocks.findDestinationRow.mockResolvedValue(foreignDestination);

		await expect(
			callerAs("owner").getDownloadUrl({
				backupId: "ws-1",
				fileName: "webserver-x.zip",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND", message: "Backup not found" });
		expectNoLink();
	});

	it("records no download when no link was handed out", async () => {
		mocks.getBackupDownloadUrl.mockRejectedValue(
			new TRPCError({
				code: "BAD_REQUEST",
				message: "Invalid backup file name",
			}),
		);

		await expect(
			callerAs("owner").getDownloadUrl({ ...input, fileName: "../x.sql.gz" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("rejects an empty or oversized file name before looking anything up", async () => {
		for (const fileName of ["", "a".repeat(256)]) {
			await expect(
				callerAs("owner").getDownloadUrl({ ...input, fileName }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(mocks.findBackupById).not.toHaveBeenCalled();
	});
});
