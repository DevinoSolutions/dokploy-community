import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The sinks that act on stored mounts (deploy, database rebuild, transfer) have
// no user, so they ask findRefusedVolumeMounts. Only the database facts are
// scripted here; the decision is the real one (T-6822).
const mocks = vi.hoisted(() => {
	const table = () => ({ findFirst: vi.fn(), findMany: vi.fn() });
	return {
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
		warn: vi.fn(),
	};
});

vi.mock("@dokploy/server/lib/logger", () => ({
	logger: { warn: mocks.warn, error: vi.fn(), info: vi.fn() },
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: mocks },
}));

const { assertVolumeMountsBound, findRefusedVolumeMounts } = await import(
	"@dokploy/server/services/volume-binding"
);

const orgOf = (organizationId: string) => ({
	environment: { project: { organizationId } },
});

const service = { serviceType: "application" as const, serviceId: "app-1" };
const volume = (volumeName: string | null) => ({
	type: "volume",
	volumeName,
});

beforeEach(() => {
	vi.resetAllMocks();
	for (const key of Object.keys(mocks) as Array<keyof typeof mocks>) {
		if (key !== "warn") {
			mocks[key].findMany.mockResolvedValue([]);
		}
	}
	mocks.applications.findFirst.mockResolvedValue({
		appName: "app-one-x",
		serverId: null,
		...orgOf("org-a"),
	});
});

describe("findRefusedVolumeMounts", () => {
	it("accepts the service's own namespace and an organization's own outside-named mount", async () => {
		await expect(
			findRefusedVolumeMounts(
				[
					volume("app-one-x-data"),
					volume("app-one-x_cache"),
					// an outside name an owner/admin stored earlier, recorded nowhere else
					volume("shared-assets"),
				],
				service,
			),
		).resolves.toEqual([]);
	});

	it("ignores binds, files and volume mounts without a name", async () => {
		await expect(
			findRefusedVolumeMounts(
				[{ type: "bind", volumeName: "dokploy-postgres" }, volume(null)],
				service,
			),
		).resolves.toEqual([]);
		expect(mocks.applications.findFirst).not.toHaveBeenCalled();
	});

	it("always refuses Dokploy's own volumes", async () => {
		const refused = await findRefusedVolumeMounts(
			[volume("dokploy-postgres"), volume("dokploy"), volume("dokploy_redis")],
			service,
		);
		expect(refused.map((entry) => entry.volumeName)).toEqual([
			"dokploy-postgres",
			"dokploy",
			"dokploy_redis",
		]);
	});

	it("always refuses a name that is not a plain volume name (a host path)", async () => {
		const refused = await findRefusedVolumeMounts(
			[volume("/etc"), volume("../x"), volume("a b")],
			service,
		);
		expect(refused).toHaveLength(3);
	});

	it("refuses a name another organization's service claims on the same server", async () => {
		mocks.postgres.findMany.mockResolvedValue([
			{ appName: "postgres-b-AbC123", serverId: null, ...orgOf("org-b") },
		]);
		const refused = await findRefusedVolumeMounts(
			[volume("postgres-b-AbC123-data")],
			service,
		);
		expect(refused.map((entry) => entry.volumeName)).toEqual([
			"postgres-b-AbC123-data",
		]);
		// the one refusal text of the binding rules
		expect(refused[0]?.message).toContain("app-one-x-<name>");
	});

	it("refuses a name another organization mounts, even though this service stores it too", async () => {
		mocks.mounts.findMany.mockResolvedValue([
			{
				applicationId: "app-1",
				application: {
					appName: "app-one-x",
					serverId: null,
					...orgOf("org-a"),
				},
			},
			{
				postgresId: "pg-b",
				postgres: { appName: "x", serverId: null, ...orgOf("org-b") },
			},
		]);
		const refused = await findRefusedVolumeMounts([volume("pgdata")], service);
		expect(refused).toHaveLength(1);
	});

	it("does not count another organization's claim on a different server", async () => {
		mocks.mounts.findMany.mockResolvedValue([
			{
				postgresId: "pg-b",
				postgres: { appName: "x", serverId: "server-b", ...orgOf("org-b") },
			},
		]);
		await expect(
			findRefusedVolumeMounts([volume("pgdata")], service),
		).resolves.toEqual([]);
	});

	it("reads the claims for every host it is asked about", async () => {
		mocks.mounts.findMany.mockResolvedValue([
			{
				postgresId: "pg-b",
				postgres: { appName: "x", serverId: "server-b", ...orgOf("org-b") },
			},
		]);
		// the service runs on the local host, the other organization on server-b
		await expect(
			findRefusedVolumeMounts([volume("pgdata")], service, {
				serverIds: [null],
			}),
		).resolves.toEqual([]);
		await expect(
			findRefusedVolumeMounts([volume("pgdata")], service, {
				serverIds: [null, "server-b"],
			}),
		).resolves.toHaveLength(1);
	});

	it("fails closed when the service cannot be resolved", async () => {
		mocks.applications.findFirst.mockResolvedValue(undefined);
		const refused = await findRefusedVolumeMounts([volume("app-one-x-data")], {
			serviceType: "application",
			serviceId: "gone",
		});
		expect(refused).toHaveLength(1);
	});
});

describe("other organizations' rows on a shared host", () => {
	const orgBVolumeBackup = {
		volumeBackupId: "vb-stale",
		postgresId: "pg-b",
		postgres: { appName: "x", serverId: null, ...orgOf("org-b") },
	};
	const orgBMount = {
		mountId: "mount-b",
		postgresId: "pg-b",
		postgres: { appName: "x", serverId: null, ...orgOf("org-b") },
	};

	it("lets a stale volume backup row of another organization not lock the service out of its own namespace", async () => {
		mocks.volumeBackups.findMany.mockResolvedValue([orgBVolumeBackup]);

		await expect(
			findRefusedVolumeMounts(
				[
					volume("app-one-x"),
					volume("app-one-x-data"),
					volume("app-one-x_cache"),
				],
				service,
			),
		).resolves.toEqual([]);
		expect(mocks.warn).not.toHaveBeenCalled();
	});

	it("still refuses an outside name that only another organization's volume backup row claims", async () => {
		mocks.volumeBackups.findMany.mockResolvedValue([orgBVolumeBackup]);

		await expect(
			findRefusedVolumeMounts([volume("shared-assets")], service),
		).resolves.toHaveLength(1);
	});

	it("still refuses a name in the service's namespace when another organization MOUNTS it", async () => {
		mocks.mounts.findMany.mockResolvedValue([orgBMount]);

		await expect(
			findRefusedVolumeMounts([volume("app-one-x-data")], service),
		).resolves.toHaveLength(1);
	});

	it("still refuses when a mount and a volume backup row both claim the name", async () => {
		mocks.mounts.findMany.mockResolvedValue([orgBMount]);
		mocks.volumeBackups.findMany.mockResolvedValue([orgBVolumeBackup]);

		await expect(
			findRefusedVolumeMounts([volume("app-one-x-data")], service),
		).resolves.toHaveLength(1);
	});

	it("logs the service and the conflicting rows on the server, and keeps them out of the message", async () => {
		mocks.mounts.findMany.mockResolvedValue([orgBMount]);
		mocks.volumeBackups.findMany.mockResolvedValue([orgBVolumeBackup]);

		const [refused] = await findRefusedVolumeMounts(
			[volume("app-one-x-data")],
			service,
		);

		expect(refused?.message).not.toMatch(/mount-b|vb-stale|org-b/);
		expect(mocks.warn).toHaveBeenCalledTimes(1);
		expect(mocks.warn.mock.calls[0]?.[0]).toMatchObject({
			serviceType: "application",
			serviceId: "app-1",
			volumeName: "app-one-x-data",
			conflictingRows: [
				{ source: "mount", id: "mount-b" },
				{ source: "volumeBackup", id: "vb-stale" },
			],
		});
	});

	it("logs a reserved name without any conflicting row", async () => {
		await findRefusedVolumeMounts([volume("dokploy-postgres")], service);

		expect(mocks.warn.mock.calls[0]?.[0]).toMatchObject({
			serviceId: "app-1",
			volumeName: "dokploy-postgres",
			conflictingRows: [],
		});
	});
});

describe("assertVolumeMountsBound", () => {
	it("throws the refusal message for a reserved name", async () => {
		await expect(
			assertVolumeMountsBound([volume("dokploy-postgres")], service),
		).rejects.toThrow(/is not one of this service's volumes/);
	});

	it("passes when every volume is the service's", async () => {
		await expect(
			assertVolumeMountsBound([volume("app-one-x-data")], service),
		).resolves.toBeUndefined();
	});
});

// A new generateVolumeMounts caller that forgets the check would silently
// reopen the deploy sink, so every caller must be paired with it.
describe("every generateVolumeMounts caller runs the binding check first", () => {
	const root = path.resolve(__dirname, "../../../../packages/server/src");
	const callers = [
		"utils/builders/index.ts",
		"utils/databases/libsql.ts",
		"utils/databases/mariadb.ts",
		"utils/databases/mongo.ts",
		"utils/databases/mysql.ts",
		"utils/databases/postgres.ts",
		"utils/databases/redis.ts",
		"services/rollbacks.ts",
	];

	it.each(callers)("%s", (file) => {
		const source = fs.readFileSync(path.join(root, file), "utf8");
		const call = source.indexOf("generateVolumeMounts(mounts)");
		const check = source.indexOf("assertVolumeMountsBound(mounts");
		expect(call).toBeGreaterThan(-1);
		expect(check).toBeGreaterThan(-1);
		expect(check).toBeLessThan(call);
	});

	it("covers every caller in the package", () => {
		const found: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (
					entry.name.endsWith(".ts") &&
					fs.readFileSync(full, "utf8").includes("generateVolumeMounts(")
				) {
					found.push(path.relative(root, full).split(path.sep).join("/"));
				}
			}
		};
		walk(root);
		expect(found.sort()).toEqual([...callers].sort());
	});
});
