import { beforeEach, describe, expect, it, vi } from "vitest";

// `docker volume rm --force` on a name that is reserved or claimed by another
// organization would destroy that tenant's data. Rebuild never removes such a
// name; it logs and skips it (T-6822).
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
		execAsync: vi.fn(),
		execAsyncRemote: vi.fn(),
		removeService: vi.fn(),
		deployPostgres: vi.fn(),
		warn: vi.fn(),
	};
});

vi.mock("@dokploy/server/db", () => ({
	db: { query: mocks.query },
}));

vi.mock("@dokploy/server/lib/logger", () => ({
	logger: { warn: mocks.warn, error: vi.fn(), info: vi.fn() },
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	removeService: mocks.removeService,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/services/postgres", () => ({
	deployPostgres: mocks.deployPostgres,
}));
vi.mock("@dokploy/server/services/libsql", () => ({}));
vi.mock("@dokploy/server/services/mariadb", () => ({}));
vi.mock("@dokploy/server/services/mongo", () => ({}));
vi.mock("@dokploy/server/services/mysql", () => ({}));
vi.mock("@dokploy/server/services/redis", () => ({}));

const { rebuildDatabase } = await import(
	"@dokploy/server/utils/databases/rebuild"
);

const orgOf = (organizationId: string) => ({
	environment: { project: { organizationId } },
});

const volumeMount = (volumeName: string) => ({
	type: "volume",
	volumeName,
});

const setMounts = (
	mounts: Array<Record<string, unknown>>,
	serverId: string | null = null,
) => {
	mocks.query.postgres.findFirst.mockImplementation(
		async (args: { with?: { mounts?: boolean } }) => {
			// the rebuild loads the database with its mounts; the binding facts load
			// the service columns and its organization
			if (args.with?.mounts) {
				return {
					postgresId: "pg-1",
					appName: "postgres-db-AbC123",
					serverId,
					mounts,
				};
			}
			return {
				appName: "postgres-db-AbC123",
				serverId,
				...orgOf("org-a"),
			};
		},
	);
};

const removedVolumes = () =>
	[...mocks.execAsync.mock.calls, ...mocks.execAsyncRemote.mock.calls]
		.map((call) => String(call[call.length - 1]))
		.filter((command) => command.startsWith("docker volume rm"));

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	for (const table of Object.values(mocks.query)) {
		table.findMany.mockResolvedValue([]);
	}
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
});

const rebuild = async () => {
	// settle first so a refusal is not an unhandled rejection while timers run
	const settled = rebuildDatabase("pg-1", "postgres").then(
		() => null,
		(error: Error) => error,
	);
	await vi.advanceTimersByTimeAsync(6000);
	const error = await settled;
	if (error) {
		throw error;
	}
};

describe("rebuildDatabase", () => {
	it("removes the service's own volume", async () => {
		setMounts([volumeMount("postgres-db-AbC123-data")]);

		await rebuild();

		expect(removedVolumes()).toEqual([
			"docker volume rm postgres-db-AbC123-data --force",
		]);
		expect(mocks.deployPostgres).toHaveBeenCalledWith("pg-1");
	});

	it("still removes an organization's own outside-named volume", async () => {
		setMounts([volumeMount("shared-assets")]);

		await rebuild();

		expect(removedVolumes()).toEqual([
			"docker volume rm shared-assets --force",
		]);
	});

	it("refuses a rebuild that includes Dokploy's own volume and touches nothing", async () => {
		setMounts([
			volumeMount("postgres-db-AbC123-data"),
			volumeMount("dokploy-postgres"),
		]);

		await expect(rebuild()).rejects.toThrow(
			/is not one of this service's volumes/,
		);

		// not even the service is removed, and no volume of the list is
		expect(mocks.removeService).not.toHaveBeenCalled();
		expect(removedVolumes()).toEqual([]);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.deployPostgres).not.toHaveBeenCalled();
		expect(mocks.warn).toHaveBeenCalledTimes(1);
		expect(mocks.warn.mock.calls[0]?.[0]).toMatchObject({
			serviceId: "pg-1",
			volumeName: "dokploy-postgres",
		});
	});

	it("refuses, touching nothing, when another organization's service claims a volume", async () => {
		mocks.query.mariadb.findMany.mockResolvedValue([
			{ appName: "mariadb-b-Zz9999", serverId: null, ...orgOf("org-b") },
		]);
		setMounts([volumeMount("mariadb-b-Zz9999-data")]);

		await expect(rebuild()).rejects.toThrow(
			/is not one of this service's volumes/,
		);

		expect(mocks.removeService).not.toHaveBeenCalled();
		expect(removedVolumes()).toEqual([]);
	});

	it("names the conflicting rows in the server log, not in the error", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([
			{
				mountId: "mount-of-org-b",
				postgresId: "pg-b",
				postgres: { appName: "x", serverId: null, ...orgOf("org-b") },
			},
		]);
		setMounts([volumeMount("pgdata")]);

		const error = await rebuild().catch((caught: Error) => caught);

		expect((error as Error).message).not.toContain("mount-of-org-b");
		expect(mocks.warn.mock.calls[0]?.[0]).toMatchObject({
			serviceId: "pg-1",
			conflictingRows: [{ source: "mount", id: "mount-of-org-b" }],
		});
	});

	it("still rebuilds when the only conflict is another organization's stale volume backup row in the service's own namespace", async () => {
		mocks.query.volumeBackups.findMany.mockResolvedValue([
			{
				volumeBackupId: "vb-stale",
				postgresId: "pg-b",
				postgres: { appName: "x", serverId: null, ...orgOf("org-b") },
			},
		]);
		setMounts([volumeMount("postgres-db-AbC123-data")]);

		await rebuild();

		expect(removedVolumes()).toEqual([
			"docker volume rm postgres-db-AbC123-data --force",
		]);
	});

	it("does not let a stale volume backup row of another organization excuse an outside name", async () => {
		mocks.query.volumeBackups.findMany.mockResolvedValue([
			{
				volumeBackupId: "vb-stale",
				postgresId: "pg-b",
				postgres: { appName: "x", serverId: null, ...orgOf("org-b") },
			},
		]);
		setMounts([volumeMount("shared-assets")]);

		await expect(rebuild()).rejects.toThrow(
			/is not one of this service's volumes/,
		);
		expect(mocks.removeService).not.toHaveBeenCalled();
	});

	it("never passes a host path to docker volume rm", async () => {
		setMounts([volumeMount("/var/lib/docker")]);

		await expect(rebuild()).rejects.toThrow();

		expect(removedVolumes()).toEqual([]);
		expect(mocks.removeService).not.toHaveBeenCalled();
	});

	it("keeps removing on the service's remote server", async () => {
		setMounts([volumeMount("postgres-db-AbC123-data")], "server-1");

		await rebuild();

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"server-1",
			"docker volume rm postgres-db-AbC123-data --force",
		);
	});
});
