import { beforeEach, describe, expect, it, vi } from "vitest";

// A compose transfer copies the volumes the compose file names. #460 refused
// the ones another organization claims; a volume another service of the same
// organization uses is refused as well, as at deploy (T-6822).
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
		scanVolume: vi.fn(),
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
	loadDockerComposeRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/traefik/application", () => ({
	readConfig: vi.fn(() => null),
	readRemoteConfig: vi.fn(async () => null),
	writeConfig: vi.fn(),
	writeConfigRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(async () => ({ stdout: "0\n", stderr: "" })),
	execAsyncRemote: vi.fn(async () => ({ stdout: "0\n", stderr: "" })),
}));

vi.mock("@dokploy/server/utils/transfer/preflight", () => ({
	createVolumeOnTarget: vi.fn(),
	createDirectoryOnTarget: vi.fn(),
}));

vi.mock("@dokploy/server/utils/transfer/scanner", () => ({
	compareFileLists: vi.fn(() => []),
	computeFileHash: vi.fn(),
	scanBindMount: vi.fn(async () => []),
	scanVolume: mocks.scanVolume,
}));

const { scanServiceForTransfer } = await import(
	"@dokploy/server/services/transfer"
);

const orgOf = (organizationId: string) => ({
	environment: { project: { organizationId } },
});

const input = {
	serviceId: "compose-1",
	serviceType: "compose",
	appName: "stack-x",
	sourceServerId: null,
	targetServerId: "server-t",
} as never;

const withExternalVolume = {
	services: { db: { volumes: ["sibling:/d", "pgdata:/p"] } },
	volumes: { sibling: { external: true }, pgdata: {} },
};

beforeEach(() => {
	vi.clearAllMocks();
	for (const table of Object.values(mocks.query)) {
		table.findMany.mockResolvedValue([]);
	}
	mocks.query.compose.findFirst.mockResolvedValue({
		appName: "stack-x",
		serverId: null,
		composeFile: "",
		...orgOf("org-a"),
	});
	mocks.findMountsByApplicationId.mockResolvedValue([]);
	mocks.findComposeById.mockResolvedValue({
		composeId: "compose-1",
		appName: "stack-x",
		serverId: null,
		sourceType: "raw",
		composePath: "docker-compose.yml",
	});
	mocks.loadDockerCompose.mockResolvedValue(withExternalVolume);
	mocks.scanVolume.mockResolvedValue([]);
});

describe("compose transfer", () => {
	it("refuses an external volume another service of the organization mounts", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([
			{
				mountId: "mount-sibling",
				applicationId: "app-9",
				application: { appName: "app-9", serverId: null, ...orgOf("org-a") },
			},
		]);

		await expect(scanServiceForTransfer(input)).rejects.toThrow(
			/Transfer refused: Compose volume "sibling" is refused/,
		);
		expect(mocks.scanVolume).not.toHaveBeenCalled();
	});

	it("refuses an external volume another organization mounts", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([
			{
				mountId: "mount-b",
				mariadbId: "m-b",
				mariadb: { appName: "m-b", serverId: null, ...orgOf("org-b") },
			},
		]);

		await expect(scanServiceForTransfer(input)).rejects.toThrow(
			/Transfer refused/,
		);
		expect(mocks.scanVolume).not.toHaveBeenCalled();
	});

	it("transfers the compose's own volumes and an unrecorded outside volume", async () => {
		const result = await scanServiceForTransfer(input);

		expect(result.volumes.map((volume) => volume.volumeName).sort()).toEqual([
			"sibling",
			"stack-x_pgdata",
		]);
	});
});
