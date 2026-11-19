import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A backup or volume backup row normally names exactly one service. Legacy
 * rows (and, for volume backups, rows made through the API) can name several.
 * For those the order in which the ids are tried decides which service the row
 * is attributed to, and each call site below has always used its own order.
 * These tests pin the result of every site that shares the resolver, so
 * unifying the code cannot change what a multi-id row resolves to.
 */

const mocks = vi.hoisted(() => ({
	findBackupById: vi.fn(),
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findServiceOrganizationId: vi.fn(),
	projectsFindMany: vi.fn(),
	backupsFindMany: vi.fn(),
	volumeBackupsFindMany: vi.fn(),
	mountsFindMany: vi.fn(),
	deploymentsFindMany: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			destinations: { findFirst: vi.fn() },
			backupPolicies: { findFirst: vi.fn() },
			projects: { findMany: mocks.projectsFindMany },
			backups: { findMany: mocks.backupsFindMany },
			volumeBackups: { findMany: mocks.volumeBackupsFindMany },
			mounts: { findMany: mocks.mountsFindMany },
			deployments: { findMany: mocks.deploymentsFindMany },
		},
	},
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	findServiceOrganizationId: mocks.findServiceOrganizationId,
	findMemberByUserId: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findBackupById: mocks.findBackupById,
	removeBackupById: vi.fn(),
	findServerById: vi.fn(),
	isRootOrganization: vi.fn(),
	scheduleBackup: vi.fn(),
	removeScheduleBackup: vi.fn(),
	findVolumeBackupById: vi.fn(),
	runVolumeBackup: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@dokploy/server/utils/restore", () => ({}));
vi.mock("@dokploy/server/utils/backups/compose", () => ({
	runComposeBackup: vi.fn(),
}));
vi.mock("@dokploy/server/utils/backups/utils", () => ({
	buildRcloneCommand: vi.fn(),
	getBackupServerId: vi.fn(),
	getRclonePathAndFlags: vi.fn(),
	normalizeS3Path: vi.fn(),
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	execAsyncStream: vi.fn(),
}));
vi.mock("@dokploy/server/utils/backups/files", () => ({
	getBackupDownloadUrl: vi.fn(),
}));
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(),
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));
vi.mock("@/server/api/utils/plan-limits", () => ({
	assertDatabaseBackupLimit: vi.fn(),
	assertVolumeBackupLimit: vi.fn(),
}));
vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
	updateJob: vi.fn(),
}));

const { backupRouter } = await import("@/server/api/routers/backup");
const { backupPolicyRouter } = await import(
	"@/server/api/routers/backup-policy"
);

const ctx = () =>
	({
		session: { activeOrganizationId: "org-a" },
		user: { id: "user-1", email: "user@example.com", role: "owner" },
	}) as never;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkPermission.mockResolvedValue(undefined);
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findServiceOrganizationId.mockResolvedValue("org-a");
});

const DUMP_IDS: Record<string, string | null> = {
	postgresId: null,
	mysqlId: null,
	mariadbId: null,
	mongoId: null,
	libsqlId: null,
	composeId: null,
};

const VOLUME_IDS: Record<string, string | null> = {
	applicationId: null,
	postgresId: null,
	mysqlId: null,
	mariadbId: null,
	mongoId: null,
	redisId: null,
	libsqlId: null,
	composeId: null,
};

const service = (idKey: string, id: string) => ({
	[idKey]: id,
	name: `${id}-name`,
	appName: `${id}-app`,
	serverId: null,
});

// One environment holding a service of every kind a test row can name.
const environmentWith = (services: Record<string, unknown[]>) => [
	{
		projectId: "proj-1",
		name: "Project",
		logo: null,
		environments: [
			{
				environmentId: "env-1",
				name: "production",
				applications: [],
				postgres: [],
				mysql: [],
				mariadb: [],
				mongo: [],
				libsql: [],
				redis: [],
				compose: [],
				...services,
			},
		],
	},
];

const volumeRow = (ids: Partial<Record<string, string | null>>) => ({
	volumeBackupId: "vb-1",
	name: "data",
	volumeName: "data",
	serviceName: null,
	serviceType: "postgres",
	cronExpression: "0 0 * * *",
	enabled: true,
	prefix: "/",
	backupPolicyId: null,
	...VOLUME_IDS,
	...ids,
	destination: { name: "offsite" },
	backupPolicy: null,
	deployments: [],
});

const dumpRow = (ids: Partial<Record<string, string | null>>) => ({
	backupId: "backup-1",
	schedule: "0 0 * * *",
	enabled: true,
	prefix: "/",
	backupPolicyId: null,
	...DUMP_IDS,
	...ids,
	destination: { name: "offsite" },
	backupPolicy: null,
	deployments: [],
});

const coverage = async (
	services: Record<string, unknown[]>,
	rows: { dump?: unknown[]; volume?: unknown[] },
) => {
	mocks.projectsFindMany.mockResolvedValue(environmentWith(services));
	mocks.backupsFindMany.mockResolvedValue(rows.dump ?? []);
	mocks.volumeBackupsFindMany.mockResolvedValue(rows.volume ?? []);
	mocks.mountsFindMany.mockResolvedValue([]);
	const result = await backupPolicyRouter.createCaller(ctx()).coverage();
	return Object.fromEntries(
		result.services.map((s) => [
			s.serviceId,
			{ dump: s.dumpBackups.length, volume: s.volumeBackups.length },
		]),
	);
};

describe("backupPolicy.coverage attributes a multi-id row", () => {
	it("to the libsql service of a volume row that names libsql and redis", async () => {
		const result = await coverage(
			{
				libsql: [service("libsqlId", "libsql-1")],
				redis: [service("redisId", "redis-1")],
			},
			{ volume: [volumeRow({ redisId: "redis-1", libsqlId: "libsql-1" })] },
		);
		expect(result["libsql-1"]).toEqual({ dump: 0, volume: 1 });
		expect(result["redis-1"]).toEqual({ dump: 0, volume: 0 });
	});

	it("to the application of a volume row that names an application and compose", async () => {
		const result = await coverage(
			{
				applications: [service("applicationId", "app-1")],
				compose: [service("composeId", "compose-1")],
			},
			{
				volume: [volumeRow({ applicationId: "app-1", composeId: "compose-1" })],
			},
		);
		expect(result["app-1"]).toEqual({ dump: 0, volume: 1 });
		expect(result["compose-1"]).toEqual({ dump: 0, volume: 0 });
	});

	it("to the database of a dump row that names a database and compose", async () => {
		const result = await coverage(
			{
				postgres: [service("postgresId", "pg-1")],
				compose: [service("composeId", "compose-1")],
			},
			{ dump: [dumpRow({ postgresId: "pg-1", composeId: "compose-1" })] },
		);
		expect(result["pg-1"]).toEqual({ dump: 1, volume: 0 });
		expect(result["compose-1"]).toEqual({ dump: 0, volume: 0 });
	});
});

describe("backupPolicy.recentActivity attributes a multi-id row", () => {
	const activity = async (
		services: Record<string, unknown[]>,
		rows: { dump?: unknown[]; volume?: unknown[] },
		deployment: Record<string, unknown>,
	) => {
		mocks.projectsFindMany.mockResolvedValue(environmentWith(services));
		mocks.backupsFindMany.mockResolvedValue(rows.dump ?? []);
		mocks.volumeBackupsFindMany.mockResolvedValue(rows.volume ?? []);
		mocks.deploymentsFindMany.mockResolvedValue([
			{
				deploymentId: "dep-1",
				backupId: null,
				volumeBackupId: null,
				status: "done",
				logPath: null,
				serverId: null,
				errorMessage: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				startedAt: null,
				finishedAt: null,
				...deployment,
			},
		]);
		const result = await backupPolicyRouter
			.createCaller(ctx())
			.recentActivity({ limit: 10, offset: 0 });
		return result.runs[0]?.serviceName;
	};

	it("to the libsql service of a volume row that names libsql and redis", async () => {
		const name = await activity(
			{
				libsql: [service("libsqlId", "libsql-1")],
				redis: [service("redisId", "redis-1")],
			},
			{ volume: [volumeRow({ redisId: "redis-1", libsqlId: "libsql-1" })] },
			{ volumeBackupId: "vb-1" },
		);
		expect(name).toBe("libsql-1-name");
	});

	it("to the database of a dump row that names a database and compose", async () => {
		const name = await activity(
			{
				postgres: [service("postgresId", "pg-1")],
				compose: [service("composeId", "compose-1")],
			},
			{ dump: [dumpRow({ postgresId: "pg-1", composeId: "compose-1" })] },
			{ backupId: "backup-1" },
		);
		expect(name).toBe("pg-1-name");
	});
});

describe("backup.backupContext serverId on a row whose service does not match its type", () => {
	const row = (overrides: Record<string, unknown>) => ({
		backupId: "backup-1",
		appName: "backup-app",
		schedule: "0 0 * * *",
		enabled: true,
		database: "app",
		prefix: "/",
		serviceName: null,
		destinationId: "dest-a",
		destination: {
			destinationId: "dest-a",
			name: "offsite",
			organizationId: "org-a",
		},
		metadata: null,
		...DUMP_IDS,
		postgres: null,
		mysql: null,
		mariadb: null,
		mongo: null,
		libsql: null,
		compose: null,
		...overrides,
	});

	it("is the compose server for a database-type row that only names compose", async () => {
		mocks.findBackupById.mockResolvedValue(
			row({
				backupType: "database",
				databaseType: "postgres",
				composeId: "compose-1",
				compose: { serverId: "srv-compose" },
			}),
		);
		const result = await backupRouter
			.createCaller(ctx())
			.backupContext({ backupId: "backup-1" });
		expect(result.serverId).toBe("srv-compose");
	});

	it("is the database server for a compose-type row that also names a database", async () => {
		mocks.findBackupById.mockResolvedValue(
			row({
				backupType: "compose",
				databaseType: "postgres",
				composeId: "compose-1",
				compose: { serverId: "srv-compose" },
				postgresId: "pg-1",
				postgres: { serverId: "srv-pg" },
			}),
		);
		const result = await backupRouter
			.createCaller(ctx())
			.backupContext({ backupId: "backup-1" });
		expect(result.serverId).toBe("srv-pg");
	});

	it("is null for a row with no server on any relation", async () => {
		mocks.findBackupById.mockResolvedValue(
			row({
				backupType: "database",
				databaseType: "postgres",
				postgresId: "pg-1",
				postgres: { serverId: null },
			}),
		);
		const result = await backupRouter
			.createCaller(ctx())
			.backupContext({ backupId: "backup-1" });
		expect(result.serverId).toBeNull();
	});
});
