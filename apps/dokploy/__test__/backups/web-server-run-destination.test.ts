import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findDestinationRow: vi.fn(),
	findMemberRow: vi.fn(),
	createDeploymentBackup: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	execAsync: vi.fn(),
	sendDokployBackupNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			destinations: { findFirst: mocks.findDestinationRow },
			member: { findFirst: mocks.findMemberRow },
		},
	},
}));

vi.mock("@dokploy/server/constants", () => ({
	IS_CLOUD: false,
	paths: () => ({ BASE_PATH: join(tmpdir(), "t6800-base-path") }),
}));

vi.mock("@dokploy/server/lib/encryption", () => ({
	ENCRYPTION_KEY_BACKUP_FILE: "keys.json",
	exportEncryptionKeys: vi.fn(() => "{}"),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeploymentBackup: mocks.createDeploymentBackup,
	updateDeploymentStatus: mocks.updateDeploymentStatus,
}));

vi.mock("@dokploy/server/utils/notifications/dokploy-backup", () => ({
	sendDokployBackupNotifications: mocks.sendDokployBackupNotifications,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
}));

vi.mock("@dokploy/server/utils/backups/utils", () => ({
	buildRcloneCommand: vi.fn(() => "rclone copyto"),
	getBackupTimestamp: vi.fn(() => "2024"),
	getRclonePathAndFlags: vi.fn(async () => ({
		flags: [],
		path: "remote:bucket/",
		envVars: {},
	})),
	normalizeS3Path: vi.fn(() => ""),
}));

const { runWebServerBackup } = await import(
	"@dokploy/server/utils/backups/web-server"
);

const backup = {
	backupId: "ws-1",
	prefix: "/",
	database: "dokploy",
	databaseType: "web-server",
	backupType: "database",
	destinationId: "dest-b",
	includeEncryptionKey: false,
	userId: "creator-1",
};

describe("runWebServerBackup checks the destination before zipping or uploading", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.createDeploymentBackup.mockResolvedValue({
			deploymentId: "dep-1",
			logPath: join(tmpdir(), "t6800-web-server-backup.log"),
		});
		mocks.execAsync.mockResolvedValue({ stdout: "container-id", stderr: "" });
		mocks.findMemberRow.mockResolvedValue({ role: "owner" });
	});

	// A refusal is a visible failed run, and nothing is zipped or uploaded.
	const expectRefusedRun = () => {
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.createDeploymentBackup).toHaveBeenCalledTimes(1);
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(mocks.sendDokployBackupNotifications).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "error",
				errorMessage: expect.stringContaining("Backup refused"),
			}),
		);
	};

	it("fails closed when the backup has no recorded creator", async () => {
		mocks.findDestinationRow.mockResolvedValue({
			destinationId: "dest-b",
			organizationId: "org-b",
		});

		await expect(
			runWebServerBackup({ ...backup, userId: null } as never),
		).rejects.toThrow("Backup refused");

		expectRefusedRun();
	});

	it("fails closed when the creator does not administer the destination organization", async () => {
		mocks.findDestinationRow.mockResolvedValue({
			destinationId: "dest-b",
			organizationId: "org-b",
		});
		mocks.findMemberRow.mockResolvedValue(undefined);

		await expect(runWebServerBackup(backup as never)).rejects.toThrow(
			"Backup refused",
		);

		expectRefusedRun();
	});

	it("refuses a row that is attached to a service", async () => {
		mocks.findDestinationRow.mockResolvedValue({
			destinationId: "dest-b",
			organizationId: "org-b",
		});

		await expect(
			runWebServerBackup({ ...backup, postgresId: "pg-1" } as never),
		).rejects.toThrow("Backup refused");

		expectRefusedRun();
	});

	it("runs when the creator administers the destination organization", async () => {
		mocks.findDestinationRow.mockResolvedValue({
			destinationId: "dest-b",
			organizationId: "org-b",
			provider: "s3",
		});

		await runWebServerBackup(backup as never);

		expect(mocks.createDeploymentBackup).toHaveBeenCalledTimes(1);
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "done");
	});
});
