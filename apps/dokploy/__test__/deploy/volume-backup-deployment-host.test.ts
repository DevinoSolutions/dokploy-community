import { beforeEach, describe, expect, it, vi } from "vitest";

// The deployment row and its log are created on the host the backup command
// runs on, databases included (T-6808).
const mocks = vi.hoisted(() => ({
	findVolumeBackupById: vi.fn(),
	findServerById: vi.fn(),
	execAsyncRemote: vi.fn(),
	insertedValues: [] as Array<Record<string, unknown>>,
}));

vi.mock("@dokploy/server/db", () => {
	const insert = () => ({
		values: (values: Record<string, unknown>) => {
			mocks.insertedValues.push(values);
			return { returning: async () => [{ deploymentId: "dep-1", ...values }] };
		},
	});
	return {
		db: {
			insert,
			query: { deployments: { findMany: async () => [] } },
			select: () => ({
				from: () => ({ where: () => ({ orderBy: async () => [] }) }),
			}),
		},
	};
});

vi.mock("@dokploy/server/services/volume-backups", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/volume-backups")
	>()),
	findVolumeBackupById: mocks.findVolumeBackupById,
}));

vi.mock("@dokploy/server/services/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/services/server")>()),
	findServerById: mocks.findServerById,
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsync: vi.fn(),
	execAsyncRemote: mocks.execAsyncRemote,
}));

const { createDeploymentVolumeBackup } = await import(
	"@dokploy/server/services/deployment"
);

const input = {
	volumeBackupId: "vb-1",
	title: "Volume Backup",
	description: "Volume Backup",
} as Parameters<typeof createDeploymentVolumeBackup>[0];

describe("createDeploymentVolumeBackup puts the deployment on the host the backup runs on", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.insertedValues.length = 0;
		mocks.findServerById.mockImplementation(async (serverId: string) => ({
			serverId,
		}));
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	});

	it.each([
		"postgres",
		"mysql",
		"mariadb",
		"mongo",
		"redis",
		"libsql",
	] as const)(
		"records the server of a %s service and creates its log there",
		async (type) => {
			mocks.findVolumeBackupById.mockResolvedValue({
				appName: "vol-backup-1",
				application: null,
				compose: null,
				[type]: { serverId: "db-server" },
			});

			const deployment = await createDeploymentVolumeBackup(input);

			expect(deployment).toMatchObject({ serverId: "db-server" });
			expect(mocks.insertedValues[0]).toMatchObject({
				serverId: "db-server",
				volumeBackupId: "vb-1",
			});
			expect(mocks.findServerById).toHaveBeenCalledWith("db-server");
			expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
			const [host, command] = mocks.execAsyncRemote.mock.calls[0] as [
				string,
				string,
			];
			expect(host).toBe("db-server");
			expect(command).toContain("mkdir -p");
			expect(command).toContain(String(mocks.insertedValues[0]?.logPath));
		},
	);

	it("keeps applications and composes on their own server", async () => {
		for (const type of ["application", "compose"] as const) {
			mocks.insertedValues.length = 0;
			mocks.findVolumeBackupById.mockResolvedValue({
				appName: "vol-backup-1",
				application: null,
				compose: null,
				[type]: { serverId: "svc-server" },
			});

			await createDeploymentVolumeBackup(input);

			expect(mocks.insertedValues[0]).toMatchObject({ serverId: "svc-server" });
		}
	});

	it("keeps a service on the local host local", async () => {
		mocks.findVolumeBackupById.mockResolvedValue({
			appName: "vol-backup-1",
			application: null,
			compose: null,
			postgres: { serverId: null },
		});
		const mkdir = vi
			.spyOn((await import("node:fs")).promises, "mkdir")
			.mockResolvedValue(undefined);
		const write = vi
			.spyOn((await import("node:fs")).promises, "writeFile")
			.mockResolvedValue(undefined);

		await createDeploymentVolumeBackup(input);

		expect(mocks.insertedValues[0]?.serverId ?? null).toBeNull();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mkdir).toHaveBeenCalled();
		mkdir.mockRestore();
		write.mockRestore();
	});
});
