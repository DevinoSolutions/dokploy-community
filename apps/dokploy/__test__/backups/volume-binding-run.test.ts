import { beforeEach, describe, expect, it, vi } from "vitest";

// Rows written before volume names were bound to their service (or edited in
// the database) are checked again on every run, scheduled or manual (T-6808).
const mocks = vi.hoisted(() => ({
	findDestinationRow: vi.fn(),
	createDeploymentVolumeBackup: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	findVolumeBackupById: vi.fn(),
	loadVolumeBindingFacts: vi.fn(),
	backupVolume: vi.fn(),
	sendVolumeBackupNotifications: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: { destinations: { findFirst: mocks.findDestinationRow } } },
}));

vi.mock("@dokploy/server/constants", () => ({
	paths: () => ({ VOLUME_BACKUPS_PATH: "/tmp/volume-backups" }),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeploymentVolumeBackup: mocks.createDeploymentVolumeBackup,
	updateDeploymentStatus: mocks.updateDeploymentStatus,
}));

vi.mock("@dokploy/server/services/volume-backups", () => ({
	findVolumeBackupById: mocks.findVolumeBackupById,
}));

vi.mock("@dokploy/server/services/volume-binding", () => ({
	loadVolumeBindingFacts: mocks.loadVolumeBindingFacts,
}));

vi.mock("@dokploy/server/utils/backups/log-tail", () => ({
	readBackupLogTail: vi.fn(async () => ""),
	buildBackupErrorMessage: (error: Error) => error.message,
}));

vi.mock("@dokploy/server/utils/backups/utils", () => ({
	getRclonePathAndFlags: vi.fn(),
	normalizeS3Path: vi.fn(),
}));

vi.mock("@dokploy/server/utils/volume-backups/backup", () => ({
	backupVolume: mocks.backupVolume,
	getVolumeServiceAppName: vi.fn(() => "app"),
}));

vi.mock("@dokploy/server/utils/notifications/volume-backup", () => ({
	sendVolumeBackupNotifications: mocks.sendVolumeBackupNotifications,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

const { runVolumeBackup } = await import(
	"@dokploy/server/utils/volume-backups/utils"
);

const row = (overrides: Record<string, unknown> = {}) => ({
	volumeBackupId: "vb-1",
	name: "data",
	appName: "vb-app",
	volumeName: "app-one-x_data",
	serviceType: "application",
	applicationId: "app-1",
	destinationId: "dest-a",
	keepLatestCount: 0,
	application: {
		appName: "app-one-x",
		serverId: null,
		environment: { project: { name: "project", organizationId: "org-a" } },
	},
	...overrides,
});

const facts = (overrides: Record<string, unknown> = {}) => ({
	volumeName: "app-one-x_data",
	serviceType: "application",
	serviceId: "app-1",
	appName: "app-one-x",
	serverId: null,
	recordedOnOwnMount: false,
	recordedOnOtherSameOrgMount: false,
	declaredByComposeFile: false,
	claimedByOtherOrganization: false,
	...overrides,
});

const dockerCommandsRun = () =>
	[...mocks.execAsync.mock.calls, ...mocks.execAsyncRemote.mock.calls]
		.map((call) => String(call.at(-1)))
		.filter((command) => command.includes("docker"));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findDestinationRow.mockResolvedValue({
		destinationId: "dest-a",
		organizationId: "org-a",
	});
	mocks.createDeploymentVolumeBackup.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "/tmp/dep-1.log",
	});
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.backupVolume.mockResolvedValue("docker run --rm -v vol:/volume_data");
	mocks.findVolumeBackupById.mockResolvedValue(row());
	mocks.loadVolumeBindingFacts.mockResolvedValue(facts());
});

describe("runVolumeBackup binds the volume to the service on every run", () => {
	it("runs a volume of the service", async () => {
		await runVolumeBackup("vb-1");

		expect(mocks.loadVolumeBindingFacts).toHaveBeenCalledWith({
			serviceType: "application",
			serviceId: "app-1",
			volumeName: "app-one-x_data",
		});
		expect(mocks.backupVolume).toHaveBeenCalledTimes(1);
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "done");
	});

	it("runs an older row whose outside name is the service's own mount", async () => {
		mocks.findVolumeBackupById.mockResolvedValue(
			row({ volumeName: "legacy-data" }),
		);
		mocks.loadVolumeBindingFacts.mockResolvedValue(
			facts({ volumeName: "legacy-data", recordedOnOwnMount: true }),
		);

		await runVolumeBackup("vb-1");

		expect(mocks.backupVolume).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"a volume another organization claims",
			{ volumeName: "orgb-data", claimedByOtherOrganization: true },
		],
		[
			"a Dokploy volume",
			{ volumeName: "dokploy-postgres", recordedOnOwnMount: true },
		],
		["a name nothing in the organization knows", { volumeName: "mystery" }],
	])("fails the run closed for %s", async (_label, factOverrides) => {
		mocks.findVolumeBackupById.mockResolvedValue(
			row({ volumeName: factOverrides.volumeName }),
		);
		mocks.loadVolumeBindingFacts.mockResolvedValue(facts(factOverrides));

		await runVolumeBackup("vb-1");

		expect(mocks.backupVolume).not.toHaveBeenCalled();
		expect(dockerCommandsRun()).toEqual([]);
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalledWith(
			"dep-1",
			"done",
		);
		expect(mocks.sendVolumeBackupNotifications).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "error",
				organizationId: "org-a",
				errorMessage: expect.stringContaining("Volume backup refused"),
			}),
		);
	});

	it("writes the reason into the deployment log", async () => {
		mocks.loadVolumeBindingFacts.mockResolvedValue(
			facts({ claimedByOtherOrganization: true, volumeName: "orgb-data" }),
		);
		mocks.findVolumeBackupById.mockResolvedValue(
			row({ volumeName: "orgb-data" }),
		);

		await runVolumeBackup("vb-1");

		const logWrites = mocks.execAsync.mock.calls
			.map((call) => String(call[0]))
			.filter((command) => command.includes("/tmp/dep-1.log"));
		expect(logWrites[0]).toContain("Volume backup refused");
	});

	it("writes the reason on the service's own server for a remote service", async () => {
		mocks.findVolumeBackupById.mockResolvedValue(
			row({
				volumeName: "orgb-data",
				application: {
					appName: "app-one-x",
					serverId: "server-1",
					environment: {
						project: { name: "project", organizationId: "org-a" },
					},
				},
			}),
		);
		mocks.loadVolumeBindingFacts.mockResolvedValue(
			facts({
				volumeName: "orgb-data",
				serverId: "server-1",
				claimedByOtherOrganization: true,
			}),
		);

		await runVolumeBackup("vb-1");

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"server-1",
			expect.stringContaining("Volume backup refused"),
		);
		expect(mocks.backupVolume).not.toHaveBeenCalled();
	});

	describe("database volume backups run on the database's own server", () => {
		const databaseRow = (serverId: string | null) =>
			row({
				applicationId: null,
				application: null,
				serviceType: "postgres",
				postgresId: "pg-1",
				volumeName: "postgres-db-AbC123-data",
				postgres: {
					appName: "postgres-db-AbC123",
					serverId,
					environment: {
						project: { name: "project", organizationId: "org-a" },
					},
				},
			});
		const databaseFacts = (serverId: string | null) =>
			facts({
				volumeName: "postgres-db-AbC123-data",
				serviceType: "postgres",
				serviceId: "pg-1",
				appName: "postgres-db-AbC123",
				serverId,
			});

		it("evaluates the claims for, and executes on, the remote server of the database", async () => {
			mocks.findVolumeBackupById.mockResolvedValue(databaseRow("server-db"));
			mocks.loadVolumeBindingFacts.mockResolvedValue(
				databaseFacts("server-db"),
			);

			await runVolumeBackup("vb-1");

			expect(mocks.loadVolumeBindingFacts).toHaveBeenCalledWith({
				serviceType: "postgres",
				serviceId: "pg-1",
				volumeName: "postgres-db-AbC123-data",
			});
			expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
			expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("server-db");
			expect(mocks.execAsync).not.toHaveBeenCalled();
			expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
				"dep-1",
				"done",
			);
		});

		it("still runs a database on the local host locally", async () => {
			mocks.findVolumeBackupById.mockResolvedValue(databaseRow(null));
			mocks.loadVolumeBindingFacts.mockResolvedValue(databaseFacts(null));

			await runVolumeBackup("vb-1");

			expect(mocks.execAsync).toHaveBeenCalledTimes(1);
			expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		});

		it("refuses when the claims were read for a different host than the one it runs on", async () => {
			mocks.findVolumeBackupById.mockResolvedValue(databaseRow("server-db"));
			mocks.loadVolumeBindingFacts.mockResolvedValue(databaseFacts(null));

			await runVolumeBackup("vb-1");

			expect(mocks.backupVolume).not.toHaveBeenCalled();
			expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
				"dep-1",
				"error",
			);
		});
	});

	it("fails closed for a row that does not belong to exactly one service", async () => {
		mocks.findVolumeBackupById.mockResolvedValue(
			row({ composeId: "compose-1" }),
		);

		await runVolumeBackup("vb-1");

		expect(mocks.loadVolumeBindingFacts).not.toHaveBeenCalled();
		expect(mocks.backupVolume).not.toHaveBeenCalled();
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
	});

	it("fails closed when the service cannot be loaded", async () => {
		mocks.loadVolumeBindingFacts.mockRejectedValue(
			new Error("Service not found"),
		);

		await runVolumeBackup("vb-1");

		expect(mocks.backupVolume).not.toHaveBeenCalled();
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
	});
});
