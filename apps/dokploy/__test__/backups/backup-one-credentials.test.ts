import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `backup.one` and `volumeBackups.one` answer from `findBackupById` /
 * `findVolumeBackupById`, which load whole service rows for the backup
 * runners. The routers must not hand those rows' credentials to the client,
 * while the finders (internal callers) keep returning them.
 */

const mocks = vi.hoisted(() => ({
	findBackupById: vi.fn(),
	findVolumeBackupById: vi.fn(),
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findServiceOrganizationId: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: { destinations: { findFirst: vi.fn() } } },
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	findServiceOrganizationId: mocks.findServiceOrganizationId,
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findBackupById: mocks.findBackupById,
	findVolumeBackupById: mocks.findVolumeBackupById,
	findServerById: vi.fn(),
	isRootOrganization: vi.fn(),
	scheduleBackup: vi.fn(),
	removeScheduleBackup: vi.fn(),
	scheduleVolumeBackup: vi.fn(),
	removeVolumeBackupJob: vi.fn(),
	removeVolumeBackup: vi.fn(),
	createVolumeBackup: vi.fn(),
	updateVolumeBackup: vi.fn(),
	restoreVolume: vi.fn(),
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
const { volumeBackupsRouter } = await import(
	"@/server/api/routers/volume-backups"
);

const ctx = (role: string) =>
	({
		session: { activeOrganizationId: "org-a" },
		user: { id: "user-1", email: "user@example.com", role },
	}) as never;

// Distinct, recognisable values, so a leak is found wherever the field sits.
const SECRET = {
	dbPassword: "SECRET-database-password",
	dbRootPassword: "SECRET-database-root-password",
	refreshToken: "SECRET-compose-refresh-token",
	env: "SECRET_KEY=SECRET-service-env",
	accessKey: "SECRET-access-key",
	secretAccessKey: "SECRET-secret-access-key",
	encryptionKey: "SECRET-encryption-key",
	encryptionPassword2: "SECRET-encryption-password-2",
	additionalFlag: "--header=Authorization: SECRET-flag",
	customGitUrl: "https://user:SECRET-git-token@example.com/repo.git",
	projectEnv: "SECRET-project-env",
	metadataPassword: "SECRET-metadata-password",
	metadataRootPassword: "SECRET-metadata-root-password",
};

const dbRow = (idKey: string, id: string) => ({
	[idKey]: id,
	name: "main-db",
	appName: `${id}-app`,
	description: "a database",
	serverId: "srv-1",
	environmentId: "env-1",
	applicationStatus: "done",
	createdAt: "2026-01-01T00:00:00.000Z",
	databaseName: "app",
	databaseUser: "app",
	databasePassword: SECRET.dbPassword,
	databaseRootPassword: SECRET.dbRootPassword,
	password: SECRET.dbPassword,
	env: SECRET.env,
});

const composeRow = () => ({
	composeId: "compose-1",
	name: "stack",
	appName: "stack-app",
	description: null,
	serverId: null,
	environmentId: "env-1",
	composeStatus: "done",
	composeType: "docker-compose",
	sourceType: "git",
	createdAt: "2026-01-01T00:00:00.000Z",
	refreshToken: SECRET.refreshToken,
	env: SECRET.env,
	customGitUrl: SECRET.customGitUrl,
	composeFile: "services: {}",
});

const destinationRow = () => ({
	destinationId: "dest-a",
	name: "offsite",
	provider: "AWS",
	bucket: "bucket",
	region: "us-east-1",
	endpoint: "https://s3.example.com",
	organizationId: "org-a",
	createdAt: "2026-01-01T00:00:00.000Z",
	encryptionEnabled: true,
	filenameEncryption: "off",
	directoryNameEncryption: false,
	// Not loaded by the real finder (`accessKey: false`), but the two below are.
	accessKey: SECRET.accessKey,
	secretAccessKey: SECRET.secretAccessKey,
	encryptionKey: SECRET.encryptionKey,
	encryptionPassword2: SECRET.encryptionPassword2,
	additionalFlags: [SECRET.additionalFlag],
});

const none = {
	postgresId: null,
	mysqlId: null,
	mariadbId: null,
	mongoId: null,
	libsqlId: null,
	composeId: null,
	postgres: null,
	mysql: null,
	mariadb: null,
	mongo: null,
	libsql: null,
	compose: null,
};

const databaseBackup = () => ({
	...none,
	backupId: "backup-1",
	appName: "backup-app",
	schedule: "0 0 * * *",
	enabled: true,
	database: "app",
	prefix: "/",
	customName: null,
	serviceName: null,
	destinationId: "dest-a",
	keepLatestCount: 3,
	includeEncryptionKey: true,
	backupType: "database",
	databaseType: "postgres",
	userId: null,
	backupPolicyId: null,
	metadata: null,
	postgresId: "pg-1",
	postgres: dbRow("postgresId", "pg-1"),
	mysql: null,
	destination: destinationRow(),
});

const composeBackup = () => ({
	...none,
	...databaseBackup(),
	backupType: "compose",
	databaseType: "mysql",
	postgresId: null,
	postgres: null,
	composeId: "compose-1",
	compose: composeRow(),
	serviceName: "db",
	metadata: {
		mysql: {
			databaseUser: "app",
			databasePassword: SECRET.metadataPassword,
			databaseRootPassword: SECRET.metadataRootPassword,
		},
	},
});

const volumeBackup = () => ({
	volumeBackupId: "vb-1",
	name: "data",
	volumeName: "pg_data",
	prefix: "/",
	appName: "vb-app",
	serviceName: null,
	turnOff: false,
	cronExpression: "0 0 * * *",
	keepLatestCount: null,
	enabled: true,
	serviceType: "postgres",
	applicationId: null,
	postgresId: "pg-1",
	mariadbId: null,
	mongoId: null,
	mysqlId: null,
	redisId: null,
	libsqlId: null,
	composeId: null,
	backupPolicyId: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	destinationId: "dest-a",
	application: null,
	postgres: {
		...dbRow("postgresId", "pg-1"),
		environment: {
			environmentId: "env-1",
			name: "production",
			projectId: "proj-1",
			env: SECRET.env,
			project: {
				projectId: "proj-1",
				name: "Project",
				organizationId: "org-a",
				env: SECRET.projectEnv,
			},
		},
	},
	mysql: null,
	mariadb: null,
	mongo: null,
	redis: null,
	libsql: null,
	compose: null,
	destination: destinationRow(),
});

const leaked = (value: unknown) => {
	const text = JSON.stringify(value);
	return Object.values(SECRET).filter((secret) => text.includes(secret));
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkPermission.mockResolvedValue(undefined);
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findServiceOrganizationId.mockResolvedValue("org-a");
});

describe("backup.one", () => {
	it("does not return a database backup's service credentials or destination keys", async () => {
		mocks.findBackupById.mockResolvedValue(databaseBackup());

		const result = await backupRouter
			.createCaller(ctx("owner"))
			.one({ backupId: "backup-1" });

		expect(leaked(result)).toEqual([]);
	});

	it("does not return a compose backup's refresh token, env or git credentials", async () => {
		mocks.findBackupById.mockResolvedValue(composeBackup());

		const result = await backupRouter
			.createCaller(ctx("owner"))
			// Metadata credentials are a separate case, tested below.
			.one({ backupId: "backup-1" });
		const text = JSON.stringify(result.compose);

		expect(text).not.toContain(SECRET.refreshToken);
		expect(text).not.toContain(SECRET.env);
		expect(text).not.toContain(SECRET.customGitUrl);
		expect(JSON.stringify(result.destination)).not.toContain(
			SECRET.encryptionKey,
		);
	});

	it("keeps what identifies the backup and what the edit form shows", async () => {
		mocks.findBackupById.mockResolvedValue(composeBackup());

		const result = await backupRouter
			.createCaller(ctx("owner"))
			.one({ backupId: "backup-1" });

		expect(result).toMatchObject({
			backupId: "backup-1",
			database: "app",
			destinationId: "dest-a",
			schedule: "0 0 * * *",
			prefix: "/",
			enabled: true,
			includeEncryptionKey: true,
			keepLatestCount: 3,
			serviceName: "db",
			databaseType: "mysql",
			backupType: "compose",
			composeId: "compose-1",
			compose: { composeId: "compose-1", appName: "stack-app", name: "stack" },
			destination: { destinationId: "dest-a", name: "offsite" },
		});
		// The edit form sends these back when it saves, so a caller who may
		// update the backup still reads them.
		expect(result.metadata).toEqual({
			mysql: {
				databaseUser: "app",
				databasePassword: SECRET.metadataPassword,
				databaseRootPassword: SECRET.metadataRootPassword,
			},
		});
	});

	it("blanks the metadata credentials for a caller who may only read the backup", async () => {
		mocks.findBackupById.mockResolvedValue(composeBackup());
		mocks.checkServicePermissionAndAccess.mockImplementation(
			async (
				_ctx: unknown,
				_id: string,
				permissions: { backup?: string[] },
			) => {
				if (permissions.backup?.includes("update")) {
					throw new Error("no update permission");
				}
			},
		);

		const result = await backupRouter
			.createCaller(ctx("member"))
			.one({ backupId: "backup-1" });

		expect(leaked(result)).toEqual([]);
		expect(result.metadata).toEqual({
			mysql: {
				databaseUser: "app",
				databasePassword: "",
				databaseRootPassword: "",
			},
		});
	});
});

describe("volumeBackups.one", () => {
	it("does not return the service's passwords, env or the project env", async () => {
		mocks.findVolumeBackupById.mockResolvedValue(volumeBackup());

		const result = await volumeBackupsRouter
			.createCaller(ctx("owner"))
			.one({ volumeBackupId: "vb-1" });

		expect(leaked(result)).toEqual([]);
		expect(result).toMatchObject({
			volumeBackupId: "vb-1",
			volumeName: "pg_data",
			destinationId: "dest-a",
			cronExpression: "0 0 * * *",
			postgresId: "pg-1",
			postgres: {
				postgresId: "pg-1",
				appName: "pg-1-app",
				environment: { project: { organizationId: "org-a" } },
			},
		});
	});
});

describe("the finders keep what the backup runners need", () => {
	it("passes the finder result to the router unchanged, so internal callers are not affected", async () => {
		const row = databaseBackup();
		mocks.findBackupById.mockResolvedValue(row);

		await backupRouter.createCaller(ctx("owner")).one({ backupId: "backup-1" });

		// The router must not mutate what findBackupById returned: the same
		// object is what the cron and the manual runners read the password from.
		expect(row.postgres.databasePassword).toBe(SECRET.dbPassword);
		expect(row.destination.encryptionKey).toBe(SECRET.encryptionKey);
	});
});
