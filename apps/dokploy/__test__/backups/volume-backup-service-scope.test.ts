import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createVolumeBackup: vi.fn(),
	findVolumeBackupById: vi.fn(),
	updateVolumeBackup: vi.fn(),
	runVolumeBackup: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findDestinationRow: vi.fn(),
	findVolumeBackupRows: vi.fn(),
	findMountRows: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			destinations: { findFirst: mocks.findDestinationRow },
			volumeBackups: { findMany: mocks.findVolumeBackupRows },
			mounts: { findMany: mocks.findMountRows },
		},
	},
}));

// The volume-name binding has its own tests (volume-binding*.test.ts); here
// every volume sits in the service's own namespace.
vi.mock("@dokploy/server/services/volume-binding", () => ({
	loadVolumeBindingFacts: async ({
		serviceType,
		serviceId,
		volumeName,
	}: {
		serviceType: string;
		serviceId: string;
		volumeName: string;
	}) => ({
		volumeName,
		serviceType,
		serviceId,
		appName: "app",
		recordedOnOwnMount: false,
		recordedOnOtherSameOrgMount: false,
		declaredByComposeFile: false,
		claimedByOtherOrganization: false,
	}),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	createVolumeBackup: mocks.createVolumeBackup,
	findVolumeBackupById: mocks.findVolumeBackupById,
	updateVolumeBackup: mocks.updateVolumeBackup,
	scheduleVolumeBackup: vi.fn(),
	removeVolumeBackupJob: vi.fn(),
	removeVolumeBackup: vi.fn(),
	restoreVolume: vi.fn(),
	runVolumeBackup: mocks.runVolumeBackup,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: vi.fn(),
	execAsyncStream: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/api/utils/plan-limits", () => ({
	assertVolumeBackupLimit: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
	updateJob: vi.fn(),
}));

const { volumeBackupsRouter } = await import(
	"@/server/api/routers/volume-backups"
);

const caller = volumeBackupsRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "user@example.com", role: "admin" },
} as Parameters<typeof volumeBackupsRouter.createCaller>[0]);

const createInput = {
	name: "data",
	volumeName: "app_data",
	prefix: "/",
	cronExpression: "0 0 * * *",
	serviceType: "application" as const,
	applicationId: "app-1",
	destinationId: "dest-a",
	enabled: false,
};

describe("volume backups stay bound to the services the caller can reach", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		mocks.findDestinationRow.mockResolvedValue({
			destinationId: "dest-a",
			organizationId: "org-a",
		});
		mocks.findVolumeBackupById.mockResolvedValue({
			volumeBackupId: "vb-1",
			applicationId: "app-1",
			destinationId: "dest-a",
		});
		mocks.createVolumeBackup.mockResolvedValue({
			volumeBackupId: "vb-1",
			enabled: false,
		});
		mocks.updateVolumeBackup.mockResolvedValue({
			volumeBackupId: "vb-1",
			enabled: false,
		});
	});

	it("rejects creating a volume backup without a service", async () => {
		await expect(
			caller.create({ ...createInput, applicationId: undefined }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.createVolumeBackup).not.toHaveBeenCalled();
	});

	it("checks every service id on a new volume backup, not only the first", async () => {
		mocks.checkServicePermissionAndAccess.mockImplementation(
			async (_ctx: unknown, serviceId: string) => {
				if (serviceId === "foreign-compose") {
					throw new Error("denied");
				}
			},
		);

		await expect(
			caller.create({ ...createInput, composeId: "foreign-compose" }),
		).rejects.toThrow("denied");
		expect(mocks.createVolumeBackup).not.toHaveBeenCalled();
	});

	it("rejects re-pointing a volume backup at another service", async () => {
		await expect(
			caller.update({
				...createInput,
				volumeBackupId: "vb-1",
				applicationId: "foreign-app",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateVolumeBackup).not.toHaveBeenCalled();
	});

	it("still updates a volume backup that keeps its service", async () => {
		await caller.update({ ...createInput, volumeBackupId: "vb-1" });

		expect(mocks.updateVolumeBackup).toHaveBeenCalledTimes(1);
	});

	it("reports a row without a service as missing instead of skipping the permission", async () => {
		mocks.findVolumeBackupById.mockResolvedValue({
			volumeBackupId: "vb-1",
			applicationId: null,
			destinationId: "dest-a",
		});

		await expect(caller.one({ volumeBackupId: "vb-1" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			caller.runManually({ volumeBackupId: "vb-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			caller.delete({ volumeBackupId: "vb-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.runVolumeBackup).not.toHaveBeenCalled();
	});

	describe("volume restore", () => {
		const restoreInput = {
			id: "app-1",
			serviceType: "application" as const,
			destinationId: "dest-a",
			backupFileName: "app_data-2024.tar",
			volumeName: "app_data",
		};

		beforeEach(() => {
			mocks.findVolumeBackupRows.mockResolvedValue([
				{ volumeName: "app_data" },
			]);
			mocks.findMountRows.mockResolvedValue([{ volumeName: "app_cache" }]);
		});

		it("rejects a volume name that belongs to no volume of the service", async () => {
			await expect(
				caller.restoreVolumeBackupWithLogs({
					...restoreInput,
					volumeName: "another_org_volume",
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});

		it("accepts the volume of one of the service's volume backups and its named mounts", async () => {
			for (const volumeName of ["app_data", "app_cache"]) {
				await expect(
					caller.restoreVolumeBackupWithLogs({ ...restoreInput, volumeName }),
				).resolves.toBeDefined();
			}
		});

		it("checks the restore permission on the target service first", async () => {
			mocks.checkServicePermissionAndAccess.mockRejectedValue(
				new Error("denied"),
			);

			await expect(
				caller.restoreVolumeBackupWithLogs(restoreInput),
			).rejects.toThrow("denied");
			expect(mocks.findVolumeBackupRows).not.toHaveBeenCalled();
		});
	});
});
