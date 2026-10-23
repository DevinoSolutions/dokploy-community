import { beforeEach, describe, expect, it, vi } from "vitest";

// A stored mount can hold a volume name that predates the binding rules. The
// swarm service spec takes it as the mount Source, so deploy refuses it before
// anything reaches Docker (T-6822). The database facts are scripted; the
// decision is the real one.
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
		getService: vi.fn(),
		createService: vi.fn(),
		inspect: vi.fn(),
		update: vi.fn(),
	};
});

vi.mock("@dokploy/server/db", () => ({
	db: { query: mocks.query },
}));

vi.mock("@dokploy/server/services/network", () => ({
	resolveServiceNetworks: vi.fn(async () => []),
}));

vi.mock("@dokploy/server/utils/vault", () => ({
	withResolvedVaultRefs: async <T>(value: T) => value,
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: async () => ({
		getService: mocks.getService,
		createService: mocks.createService,
	}),
}));

const { buildPostgres } = await import(
	"@dokploy/server/utils/databases/postgres"
);

const orgOf = (organizationId: string) => ({
	environment: { project: { organizationId } },
});

const postgresRow = (mounts: Array<Record<string, unknown>>) =>
	({
		postgresId: "pg-1",
		appName: "postgres-db-AbC123",
		env: null,
		externalPort: null,
		dockerImage: "postgres:16",
		memoryLimit: null,
		memoryReservation: null,
		cpuLimit: null,
		cpuReservation: null,
		databaseName: "db",
		databaseUser: "user",
		databasePassword: "pw",
		command: null,
		args: [],
		serverId: null,
		mounts,
		environment: { env: "", project: { env: "" } },
	}) as never;

const volumeMount = (volumeName: string) => ({
	type: "volume",
	volumeName,
	mountPath: "/var/lib/postgresql/data",
	postgresId: "pg-1",
});

beforeEach(() => {
	vi.clearAllMocks();
	for (const table of Object.values(mocks.query)) {
		table.findMany.mockResolvedValue([]);
	}
	mocks.query.postgres.findFirst.mockResolvedValue({
		appName: "postgres-db-AbC123",
		serverId: null,
		...orgOf("org-a"),
	});
	mocks.getService.mockReturnValue({
		inspect: mocks.inspect.mockResolvedValue({
			Version: { Index: "1" },
			Spec: { TaskTemplate: { ForceUpdate: 0 } },
		}),
		update: mocks.update,
	});
});

describe("deploying a database whose stored mounts name somebody else's volume", () => {
	it("still deploys the service's own volume", async () => {
		await buildPostgres(postgresRow([volumeMount("postgres-db-AbC123-data")]));

		expect(mocks.update).toHaveBeenCalledTimes(1);
		const spec = mocks.update.mock.calls[0]?.[0];
		expect(spec.TaskTemplate.ContainerSpec.Mounts).toEqual([
			{
				Type: "volume",
				Source: "postgres-db-AbC123-data",
				Target: "/var/lib/postgresql/data",
			},
		]);
	});

	it("still deploys an organization's own outside-named mount", async () => {
		await buildPostgres(postgresRow([volumeMount("shared-assets")]));

		expect(mocks.update).toHaveBeenCalledTimes(1);
	});

	it("deploys the service's own volume despite another organization's stale volume backup row", async () => {
		mocks.query.volumeBackups.findMany.mockResolvedValue([
			{
				volumeBackupId: "vb-stale",
				mariadbId: "m-b",
				mariadb: { appName: "x", serverId: null, ...orgOf("org-b") },
			},
		]);

		await buildPostgres(postgresRow([volumeMount("postgres-db-AbC123-data")]));

		expect(mocks.update).toHaveBeenCalledTimes(1);
	});

	it("refuses a name another organization's mount shares on the same server", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([
			{
				mountId: "mount-b",
				mariadbId: "m-b",
				mariadb: { appName: "x", serverId: null, ...orgOf("org-b") },
			},
		]);

		await expect(
			buildPostgres(postgresRow([volumeMount("postgres-db-AbC123-data")])),
		).rejects.toThrow(/is not one of this service's volumes/);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("refuses Dokploy's own volume with the binding message, before Docker is touched", async () => {
		await expect(
			buildPostgres(postgresRow([volumeMount("dokploy-postgres")])),
		).rejects.toThrow(/is not one of this service's volumes/);

		expect(mocks.getService).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.createService).not.toHaveBeenCalled();
	});

	it("refuses a host path stored as a volume name", async () => {
		await expect(
			buildPostgres(postgresRow([volumeMount("/etc")])),
		).rejects.toThrow(/is not one of this service's volumes/);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("refuses a volume another organization's service claims, even next to a valid one", async () => {
		mocks.query.mariadb.findMany.mockResolvedValue([
			{ appName: "mariadb-b-Zz9999", serverId: null, ...orgOf("org-b") },
		]);

		await expect(
			buildPostgres(
				postgresRow([
					volumeMount("postgres-db-AbC123-data"),
					volumeMount("mariadb-b-Zz9999-data"),
				]),
			),
		).rejects.toThrow(/is not one of this service's volumes/);
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.createService).not.toHaveBeenCalled();
	});
});
