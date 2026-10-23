import { beforeEach, describe, expect, it, vi } from "vitest";

// A transfer copies a volume by name on the source host and writes it by name
// on the target host. A reserved or foreign name, from the stored mounts or
// from the compose file, refuses the whole transfer before anything is read or
// written (T-6822).
const mocks = vi.hoisted(() => {
	const table = () => ({ findFirst: vi.fn(), findMany: vi.fn() });
	return {
		query: {
			applications: table(),
			compose: table(),
			libsql: table(),
			mariadb: table(),
			mongo: table(),
			mysql: table(),
			postgres: table(),
			redis: table(),
			mounts: table(),
			volumeBackups: table(),
		},
		findMountsByApplicationId: vi.fn(),
		findComposeById: vi.fn(),
		loadDockerCompose: vi.fn(),
		loadDockerComposeRemote: vi.fn(),
		execAsync: vi.fn(),
		execAsyncRemote: vi.fn(),
		scanVolume: vi.fn(),
		scanBindMount: vi.fn(),
		createVolumeOnTarget: vi.fn(),
		createDirectoryOnTarget: vi.fn(),
	};
});

vi.mock("@dokploy/server/db", () => ({
	db: { query: mocks.query },
}));

vi.mock("@dokploy/server/services/mount", () => ({
	findMountsByApplicationId: mocks.findMountsByApplicationId,
}));

vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: mocks.findComposeById,
}));

vi.mock("@dokploy/server/utils/docker/domain", () => ({
	loadDockerCompose: mocks.loadDockerCompose,
	loadDockerComposeRemote: mocks.loadDockerComposeRemote,
}));

vi.mock("@dokploy/server/utils/traefik/application", () => ({
	readConfig: vi.fn(() => null),
	readRemoteConfig: vi.fn(async () => null),
	writeConfig: vi.fn(),
	writeConfigRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/utils/transfer/preflight", () => ({
	createVolumeOnTarget: mocks.createVolumeOnTarget,
	createDirectoryOnTarget: mocks.createDirectoryOnTarget,
}));

vi.mock("@dokploy/server/utils/transfer/scanner", () => ({
	compareFileLists: vi.fn(() => []),
	computeFileHash: vi.fn(),
	scanBindMount: mocks.scanBindMount,
	scanVolume: mocks.scanVolume,
}));

const { scanServiceForTransfer, executeTransfer } = await import(
	"@dokploy/server/services/transfer"
);

const orgOf = (organizationId: string) => ({
	environment: { project: { organizationId } },
});

const options = (overrides: Record<string, unknown> = {}) =>
	({
		serviceId: "app-1",
		serviceType: "application",
		appName: "app-one-x",
		sourceServerId: null,
		targetServerId: "server-t",
		...overrides,
	}) as never;

const dbVolume = (volumeName: string) => ({
	mountId: `m-${volumeName}`,
	type: "volume",
	volumeName,
	hostPath: null,
	mountPath: "/data",
});

beforeEach(() => {
	vi.clearAllMocks();
	for (const table of Object.values(mocks.query)) {
		table.findMany.mockResolvedValue([]);
	}
	mocks.query.applications.findFirst.mockResolvedValue({
		appName: "app-one-x",
		serverId: null,
		...orgOf("org-a"),
	});
	mocks.query.compose.findFirst.mockResolvedValue({
		appName: "stack-x",
		serverId: null,
		composeFile: "",
		...orgOf("org-a"),
	});
	mocks.findMountsByApplicationId.mockResolvedValue([]);
	mocks.scanVolume.mockResolvedValue([]);
	mocks.scanBindMount.mockResolvedValue([]);
	mocks.execAsync.mockResolvedValue({ stdout: "0\n", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "0\n", stderr: "" });
});

describe("scanServiceForTransfer", () => {
	it("scans the service's own volume and an organization's own outside-named volume", async () => {
		mocks.findMountsByApplicationId.mockResolvedValue([
			dbVolume("app-one-x-data"),
			dbVolume("shared-assets"),
		]);

		const result = await scanServiceForTransfer(options());

		expect(result.volumes.map((volume) => volume.volumeName)).toEqual([
			"app-one-x-data",
			"shared-assets",
		]);
	});

	it("refuses a stored mount that names Dokploy's own volume, before reading it", async () => {
		mocks.findMountsByApplicationId.mockResolvedValue([
			dbVolume("app-one-x-data"),
			dbVolume("dokploy-postgres"),
		]);

		await expect(scanServiceForTransfer(options())).rejects.toThrow(
			/Transfer refused: Volume "dokploy-postgres" is not one of this service's volumes/,
		);
		expect(mocks.scanVolume).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("refuses a stored mount another organization's service claims", async () => {
		mocks.query.mariadb.findMany.mockResolvedValue([
			{ appName: "mariadb-b-Zz9999", serverId: null, ...orgOf("org-b") },
		]);
		mocks.findMountsByApplicationId.mockResolvedValue([
			dbVolume("mariadb-b-Zz9999-data"),
		]);

		await expect(scanServiceForTransfer(options())).rejects.toThrow(
			/Transfer refused/,
		);
		expect(mocks.scanVolume).not.toHaveBeenCalled();
	});

	it("also checks the claims on the target server", async () => {
		// org B has a service on the target server that owns this name there
		mocks.query.postgres.findMany.mockResolvedValue([
			{ appName: "postgres-b-AbC123", serverId: "server-t", ...orgOf("org-b") },
		]);
		mocks.findMountsByApplicationId.mockResolvedValue([
			dbVolume("postgres-b-AbC123-data"),
		]);

		await expect(scanServiceForTransfer(options())).rejects.toThrow(
			/Transfer refused/,
		);

		// the same claim does not matter when neither host is server-t
		await expect(
			scanServiceForTransfer(options({ targetServerId: "server-other" })),
		).resolves.toMatchObject({ volumes: [expect.anything()] });
	});

	it("refuses a compose-declared volume that is reserved or foreign, and keeps the service's own", async () => {
		mocks.findComposeById.mockResolvedValue({
			appName: "stack-x",
			serverId: null,
			sourceType: "raw",
			composePath: "docker-compose.yml",
		});
		const compose = (volumes: Record<string, unknown>) => ({
			services: { db: { volumes: Object.keys(volumes).map((k) => `${k}:/d`) } },
			volumes,
		});
		const input = options({
			serviceId: "compose-1",
			serviceType: "compose",
			appName: "stack-x",
		});

		mocks.loadDockerCompose.mockResolvedValue(
			compose({ pgdata: {}, assets: { external: { name: "shared-assets" } } }),
		);
		await expect(scanServiceForTransfer(input)).resolves.toMatchObject({
			volumes: [
				{ volumeName: "stack-x_pgdata" },
				{ volumeName: "shared-assets" },
			],
		});

		mocks.scanVolume.mockClear();
		mocks.loadDockerCompose.mockResolvedValue(
			compose({ pgdata: {}, secret: { external: { name: "dokploy-redis" } } }),
		);
		await expect(scanServiceForTransfer(input)).rejects.toThrow(
			/Transfer refused: Volume "dokploy-redis"/,
		);
		expect(mocks.scanVolume).not.toHaveBeenCalled();
	});
});

describe("executeTransfer", () => {
	it("fails with the refusal before creating anything on the target", async () => {
		mocks.findMountsByApplicationId.mockResolvedValue([
			dbVolume("dokploy-postgres"),
		]);

		const result = await executeTransfer(options(), {}, vi.fn());

		expect(result.success).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatch(
			/Transfer refused: Volume "dokploy-postgres" is not one of this service's volumes/,
		);
		expect(mocks.createVolumeOnTarget).not.toHaveBeenCalled();
		expect(mocks.scanVolume).not.toHaveBeenCalled();
	});
});
