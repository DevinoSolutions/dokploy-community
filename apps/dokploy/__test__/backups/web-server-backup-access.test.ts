import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createBackup: vi.fn(),
	findBackupById: vi.fn(),
	updateBackupById: vi.fn(),
	removeBackupById: vi.fn(),
	runWebServerBackup: vi.fn(),
	runPostgresBackup: vi.fn(),
	keepLatestNBackups: vi.fn(),
	findPostgresByBackupId: vi.fn(),
	findPostgresById: vi.fn(),
	restorePostgresBackup: vi.fn(),
	restoreWebServerBackup: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findDestinationRow: vi.fn(),
	findMemberRow: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			destinations: { findFirst: mocks.findDestinationRow },
			member: { findFirst: mocks.findMemberRow },
		},
	},
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	createBackup: mocks.createBackup,
	findBackupById: mocks.findBackupById,
	updateBackupById: mocks.updateBackupById,
	removeBackupById: mocks.removeBackupById,
	runWebServerBackup: mocks.runWebServerBackup,
	runPostgresBackup: mocks.runPostgresBackup,
	keepLatestNBackups: mocks.keepLatestNBackups,
	findPostgresByBackupId: mocks.findPostgresByBackupId,
	findPostgresById: mocks.findPostgresById,
	scheduleBackup: vi.fn(),
	removeScheduleBackup: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server/utils/restore", () => ({
	restorePostgresBackup: mocks.restorePostgresBackup,
	restoreWebServerBackup: mocks.restoreWebServerBackup,
}));

vi.mock("@dokploy/server/utils/backups/compose", () => ({
	runComposeBackup: vi.fn(),
}));

vi.mock("@dokploy/server/utils/backups/utils", () => ({
	getS3Credentials: vi.fn(),
	normalizeS3Path: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/api/utils/plan-limits", () => ({
	assertDatabaseBackupLimit: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
	updateJob: vi.fn(),
}));

const { backupRouter } = await import("@/server/api/routers/backup");

type Role = "owner" | "admin" | "member";

const callerAs = (role: Role, organizationId = "org-a") =>
	backupRouter.createCaller({
		session: { activeOrganizationId: organizationId },
		user: { id: "user-1", email: "user@example.com", role },
	} as Parameters<typeof backupRouter.createCaller>[0]);

const ownDestination = { destinationId: "dest-a", organizationId: "org-a" };
const foreignDestination = { destinationId: "dest-b", organizationId: "org-b" };

const instanceBackup = {
	backupId: "ws-1",
	databaseType: "web-server",
	backupType: "database",
	destinationId: "dest-a",
	userId: "creator-1",
	enabled: false,
	postgresId: null,
	mysqlId: null,
	mariadbId: null,
	mongoId: null,
	libsqlId: null,
	composeId: null,
};

const createInput = {
	schedule: "0 0 * * *",
	prefix: "/",
	database: "dokploy",
	databaseType: "web-server" as const,
	destinationId: "dest-a",
	enabled: false,
};

const updateInput = {
	backupId: "ws-1",
	schedule: "0 0 * * *",
	enabled: false,
	prefix: "/",
	database: "dokploy",
	keepLatestCount: 0,
	serviceName: null,
	metadata: {},
	databaseType: "web-server" as const,
	destinationId: "dest-a",
};

const restoreInput = {
	databaseId: "",
	databaseType: "web-server" as const,
	backupType: "database" as const,
	databaseName: "dokploy",
	backupFile: "webserver-backup-2024.zip",
	destinationId: "dest-a",
};

const drain = async (stream: unknown) => {
	for await (const _ of stream as AsyncIterable<string>) {
	}
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createBackup.mockResolvedValue({ backupId: "ws-1" });
	mocks.findBackupById.mockResolvedValue(instanceBackup);
	mocks.updateBackupById.mockResolvedValue({});
	mocks.removeBackupById.mockResolvedValue({ schedule: "0 0 * * *" });
	mocks.runWebServerBackup.mockResolvedValue(true);
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findDestinationRow.mockResolvedValue(ownDestination);
	// The creator of the stored row administers org-a.
	mocks.findMemberRow.mockResolvedValue({ role: "admin" });
});

describe("a plain member cannot manage web-server backups", () => {
	const member = callerAs("member");

	it("cannot create one, even towards a destination of the own organization", async () => {
		await expect(member.create(createInput)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.createBackup).not.toHaveBeenCalled();
	});

	it("cannot update one", async () => {
		await expect(member.update(updateInput)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.updateBackupById).not.toHaveBeenCalled();
	});

	it("cannot run one manually", async () => {
		await expect(
			member.manualBackupWebServer({ backupId: "ws-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.runWebServerBackup).not.toHaveBeenCalled();
	});

	it("cannot restore one, with or without a database id", async () => {
		for (const databaseId of ["", "user-1"]) {
			const stream = await member.restoreBackupWithLogs({
				...restoreInput,
				databaseId,
			});
			await expect(drain(stream)).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		}
		expect(mocks.restoreWebServerBackup).not.toHaveBeenCalled();
	});

	it("cannot read or remove one", async () => {
		await expect(member.one({ backupId: "ws-1" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(member.remove({ backupId: "ws-1" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.removeBackupById).not.toHaveBeenCalled();
	});
});

describe("an admin of one organization cannot reach another organization", () => {
	const admin = callerAs("admin");

	it("rejects creating a web-server backup on a foreign destination", async () => {
		mocks.findDestinationRow.mockResolvedValue(foreignDestination);

		await expect(
			admin.create({ ...createInput, destinationId: "dest-b" }),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "You don't have access to this destination.",
		});
		expect(mocks.createBackup).not.toHaveBeenCalled();
	});

	it("rejects attaching a web-server backup to a service", async () => {
		await expect(
			admin.create({ ...createInput, postgresId: "pg-1" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.createBackup).not.toHaveBeenCalled();
	});

	it("rejects a backup that targets no service and is not a web-server backup", async () => {
		await expect(
			admin.create({ ...createInput, databaseType: "postgres" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.createBackup).not.toHaveBeenCalled();
	});

	it("rejects moving a web-server backup to a foreign destination", async () => {
		mocks.findDestinationRow
			.mockResolvedValueOnce(ownDestination)
			.mockResolvedValueOnce(foreignDestination);

		await expect(
			admin.update({ ...updateInput, destinationId: "dest-b" }),
		).rejects.toMatchObject({
			message: "You don't have access to this destination.",
		});
		expect(mocks.updateBackupById).not.toHaveBeenCalled();
	});

	it("cannot turn a service backup into a web-server backup", async () => {
		mocks.findBackupById.mockResolvedValue({
			backupId: "pg-backup",
			databaseType: "postgres",
			backupType: "database",
			destinationId: "dest-a",
			postgresId: "pg-1",
		});

		await expect(
			admin.update({
				...updateInput,
				backupId: "pg-backup",
				databaseType: "web-server",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateBackupById).not.toHaveBeenCalled();
	});

	it("treats a backup of another organization like a missing one on every by-id route", async () => {
		mocks.findDestinationRow.mockResolvedValue(foreignDestination);
		mocks.findBackupById.mockResolvedValue({
			...instanceBackup,
			destinationId: "dest-b",
		});

		await expect(admin.one({ backupId: "ws-1" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			admin.update({ ...updateInput, destinationId: "dest-a" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(admin.remove({ backupId: "ws-1" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			admin.manualBackupWebServer({ backupId: "ws-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			admin.backupContext({ backupId: "ws-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updateBackupById).not.toHaveBeenCalled();
		expect(mocks.removeBackupById).not.toHaveBeenCalled();
		expect(mocks.runWebServerBackup).not.toHaveBeenCalled();
	});

	it("does not run a web-server backup whose creator is not an administrator of the organization", async () => {
		mocks.findMemberRow.mockResolvedValue(undefined);

		await expect(
			admin.manualBackupWebServer({ backupId: "ws-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.runWebServerBackup).not.toHaveBeenCalled();
	});

	it("does not run a web-server backup that has no recorded creator", async () => {
		mocks.findBackupById.mockResolvedValue({ ...instanceBackup, userId: null });

		await expect(
			admin.manualBackupWebServer({ backupId: "ws-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.runWebServerBackup).not.toHaveBeenCalled();
	});

	it("rejects restoring an instance backup from a foreign destination, with an empty database id", async () => {
		mocks.findDestinationRow.mockResolvedValue(foreignDestination);

		const stream = await admin.restoreBackupWithLogs({
			...restoreInput,
			destinationId: "dest-b",
		});

		await expect(drain(stream)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.restoreWebServerBackup).not.toHaveBeenCalled();
	});

	it("requires a service id for a service restore", async () => {
		const stream = await admin.restoreBackupWithLogs({
			...restoreInput,
			databaseType: "postgres",
			databaseId: "",
		});

		await expect(drain(stream)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.restorePostgresBackup).not.toHaveBeenCalled();
		expect(mocks.restoreWebServerBackup).not.toHaveBeenCalled();
	});

	it("cannot point a service backup route at a web-server backup", async () => {
		await expect(
			admin.manualBackupPostgres({ backupId: "ws-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.runPostgresBackup).not.toHaveBeenCalled();
	});

	it("cannot run a service backup through the web-server route", async () => {
		mocks.findBackupById.mockResolvedValue({
			backupId: "pg-backup",
			databaseType: "postgres",
			backupType: "database",
			destinationId: "dest-b",
			postgresId: "pg-1",
		});

		await expect(
			admin.manualBackupWebServer({ backupId: "pg-backup" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.runWebServerBackup).not.toHaveBeenCalled();
	});
});

describe.each(["owner", "admin"] as const)(
	"an %s of the organization manages web-server backups",
	(role) => {
		const caller = callerAs(role);

		it("creates one and records the caller as its creator", async () => {
			await caller.create({ ...createInput, userId: "someone-else" });

			expect(mocks.createBackup).toHaveBeenCalledTimes(1);
			expect(mocks.createBackup).toHaveBeenCalledWith(
				expect.objectContaining({ userId: "user-1", destinationId: "dest-a" }),
			);
			expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		});

		it("updates, runs, reads and removes one", async () => {
			await caller.update(updateInput);
			await caller.manualBackupWebServer({ backupId: "ws-1" });
			await caller.one({ backupId: "ws-1" });
			await caller.remove({ backupId: "ws-1" });

			expect(mocks.updateBackupById).toHaveBeenCalledTimes(1);
			expect(mocks.runWebServerBackup).toHaveBeenCalledTimes(1);
			expect(mocks.removeBackupById).toHaveBeenCalledTimes(1);
		});

		it("restores from a destination of the organization without a database id", async () => {
			const stream = await caller.restoreBackupWithLogs(restoreInput);
			await drain(stream);

			expect(mocks.restoreWebServerBackup).toHaveBeenCalledTimes(1);
			expect(mocks.findPostgresById).not.toHaveBeenCalled();
			expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		});
	},
);
