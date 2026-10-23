import { beforeEach, describe, expect, it, vi } from "vitest";

// A volume name is global to the Docker host, so volume backups, restores and
// named mounts may only use names that belong to the service (T-6808). The
// decision itself is real here; only the database facts are scripted.
const mocks = vi.hoisted(() => ({
	createVolumeBackup: vi.fn(),
	findVolumeBackupById: vi.fn(),
	updateVolumeBackup: vi.fn(),
	runVolumeBackup: vi.fn(),
	createMount: vi.fn(),
	updateMount: vi.fn(),
	findMountById: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findDestinationRow: vi.fn(),
	findVolumeBackupRows: vi.fn(),
	findMountRows: vi.fn(),
	restoreVolume: vi.fn(),
	execAsyncRemote: vi.fn(),
	execAsyncStream: vi.fn(),
	findServerById: vi.fn(),
}));

const known = vi.hoisted(() => ({
	services: {
		"app-1": { type: "application", appName: "app-one-x", serverId: null },
		"app-remote": {
			type: "application",
			appName: "app-remote-x",
			serverId: "server-b",
		},
		"compose-1": { type: "compose", appName: "stack-x", serverId: null },
		"pg-1": {
			type: "postgres",
			appName: "postgres-db-AbC123",
			serverId: null,
		},
	} as Record<
		string,
		{ type: string; appName: string; serverId: string | null }
	>,
	ownMounts: new Set<string>(),
	otherSameOrgMounts: new Set<string>(),
	composeDeclared: new Set<string>(),
	claimedByOtherOrganization: new Set<string>(),
}));

vi.mock("@dokploy/server/services/volume-binding", () => ({
	loadVolumeBindingFacts: async ({
		serviceType,
		serviceId,
		volumeName,
	}: {
		serviceType: string;
		serviceId: string;
		volumeName: string;
	}) => {
		const service = known.services[serviceId];
		if (!service || service.type !== serviceType) {
			throw Object.assign(new Error("Service not found"), {
				code: "NOT_FOUND",
			});
		}
		return {
			volumeName,
			serviceType,
			serviceId,
			appName: service.appName,
			serverId: service.serverId,
			recordedOnOwnMount: known.ownMounts.has(volumeName),
			recordedOnOtherSameOrgMount: known.otherSameOrgMounts.has(volumeName),
			declaredByComposeFile: known.composeDeclared.has(volumeName),
			claimedByOtherOrganization:
				known.claimedByOtherOrganization.has(volumeName),
		};
	},
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			destinations: { findFirst: mocks.findDestinationRow },
			volumeBackups: { findMany: mocks.findVolumeBackupRows },
			mounts: { findMany: mocks.findMountRows },
		},
	},
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	checkServiceAccess: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	createVolumeBackup: mocks.createVolumeBackup,
	findVolumeBackupById: mocks.findVolumeBackupById,
	updateVolumeBackup: mocks.updateVolumeBackup,
	scheduleVolumeBackup: vi.fn(),
	removeVolumeBackupJob: vi.fn(),
	removeVolumeBackup: vi.fn(),
	restoreVolume: mocks.restoreVolume,
	runVolumeBackup: mocks.runVolumeBackup,
	createMount: mocks.createMount,
	updateMount: mocks.updateMount,
	findMountById: mocks.findMountById,
	deleteMount: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	findLibsqlById: vi.fn(),
	findMariadbById: vi.fn(),
	findMongoById: vi.fn(),
	findMountsByApplicationId: vi.fn(),
	findMySqlById: vi.fn(),
	findPostgresById: vi.fn(),
	findRedisById: vi.fn(),
	getServiceContainer: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: mocks.execAsyncRemote,
	execAsyncStream: mocks.execAsyncStream,
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/api/utils/plan-limits", () => ({
	assertVolumeBackupLimit: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
	updateJob: vi.fn(),
}));

const { volumeBackupsRouter } = await import(
	"@/server/api/routers/volume-backups"
);
const { mountRouter } = await import("@/server/api/routers/mount");

const ctxFor = (role: string) =>
	({
		session: { activeOrganizationId: "org-a" },
		user: { id: "user-1", email: "user@example.com", role },
	}) as never;

const volumeBackupsAs = (role: string) =>
	volumeBackupsRouter.createCaller(ctxFor(role));
const mountsAs = (role: string) => mountRouter.createCaller(ctxFor(role));

const backupInput = {
	name: "data",
	volumeName: "app-one-x_data",
	prefix: "/",
	cronExpression: "0 0 * * *",
	serviceType: "application" as const,
	applicationId: "app-1",
	destinationId: "dest-a",
	enabled: false,
};

const composeInput = {
	...backupInput,
	serviceType: "compose" as const,
	applicationId: undefined,
	composeId: "compose-1",
	serviceName: "db",
	volumeName: "stack-x_pgdata",
};

const databaseInput = {
	...backupInput,
	serviceType: "postgres" as const,
	applicationId: undefined,
	postgresId: "pg-1",
	volumeName: "postgres-db-AbC123-data",
};

beforeEach(() => {
	vi.clearAllMocks();
	known.ownMounts.clear();
	known.otherSameOrgMounts.clear();
	known.composeDeclared.clear();
	known.claimedByOtherOrganization.clear();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findDestinationRow.mockResolvedValue({
		destinationId: "dest-a",
		organizationId: "org-a",
	});
	mocks.createVolumeBackup.mockResolvedValue({
		volumeBackupId: "vb-1",
		enabled: false,
	});
	mocks.updateVolumeBackup.mockResolvedValue({
		volumeBackupId: "vb-1",
		enabled: false,
	});
	mocks.findVolumeBackupById.mockResolvedValue({
		volumeBackupId: "vb-1",
		applicationId: "app-1",
		volumeName: "app-one-x_data",
		destinationId: "dest-a",
	});
	mocks.createMount.mockResolvedValue({ mountId: "mount-1" });
	mocks.updateMount.mockResolvedValue({ mountId: "mount-1" });
	mocks.findMountById.mockResolvedValue({
		mountId: "mount-1",
		type: "volume",
		serviceType: "application",
		volumeName: "app-one-x-data",
		applicationId: "app-1",
	});
	mocks.findVolumeBackupRows.mockResolvedValue([]);
	mocks.findMountRows.mockResolvedValue([]);
});

describe("creating a volume backup", () => {
	it("lets a member back up the volumes of their own application, compose and database", async () => {
		const member = volumeBackupsAs("member");

		await member.create(backupInput);
		await member.create(composeInput);
		await member.create(databaseInput);

		expect(mocks.createVolumeBackup).toHaveBeenCalledTimes(3);
	});

	it("rejects a member naming a volume outside the service, such as another organization's database", async () => {
		const member = volumeBackupsAs("member");

		for (const volumeName of [
			"postgres-victim-Zz9999-data",
			"dokploy-postgres",
			"random",
			// another service's name that only shares a prefix with this one
			"app-one-xyz_data",
		]) {
			await expect(
				member.create({ ...backupInput, volumeName }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		await expect(
			member.create({ ...composeInput, volumeName: "app-one-x_data" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.createVolumeBackup).not.toHaveBeenCalled();
	});

	it("rejects a member even when the name looks recorded elsewhere or declared by a compose file", async () => {
		known.otherSameOrgMounts.add("shared-data");
		known.composeDeclared.add("shared-data");

		await expect(
			volumeBackupsAs("member").create({
				...composeInput,
				volumeName: "shared-data",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.createVolumeBackup).not.toHaveBeenCalled();
	});

	it("rejects a volume another organization claims, for an owner too", async () => {
		known.claimedByOtherOrganization.add("orgb-data");
		known.otherSameOrgMounts.add("orgb-data");

		for (const role of ["member", "admin", "owner"]) {
			await expect(
				volumeBackupsAs(role).create({
					...backupInput,
					volumeName: "orgb-data",
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(mocks.createVolumeBackup).not.toHaveBeenCalled();
	});

	it("lets an owner or admin use an external volume the organization already mounts", async () => {
		known.otherSameOrgMounts.add("shared-data");

		for (const role of ["owner", "admin"]) {
			await volumeBackupsAs(role).create({
				...backupInput,
				volumeName: "shared-data",
			});
		}

		expect(mocks.createVolumeBackup).toHaveBeenCalledTimes(2);
	});

	it("lets an owner or admin back up an external volume declared by the compose file", async () => {
		known.composeDeclared.add("shared-pg");

		await volumeBackupsAs("admin").create({
			...composeInput,
			volumeName: "shared-pg",
		});

		expect(mocks.createVolumeBackup).toHaveBeenCalledTimes(1);
	});

	it("rejects an owner or admin naming a volume nothing in the organization knows", async () => {
		for (const role of ["owner", "admin"]) {
			await expect(
				volumeBackupsAs(role).create({
					...backupInput,
					volumeName: "unknown-host-volume",
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(mocks.createVolumeBackup).not.toHaveBeenCalled();
	});

	it("checks the volume against the service it is saved on, not another one", async () => {
		// a name that belongs to the compose is not the application's volume
		await expect(
			volumeBackupsAs("member").create({
				...backupInput,
				volumeName: "stack-x_pgdata",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("updating a volume backup", () => {
	const updateInput = { ...backupInput, volumeBackupId: "vb-1" };

	it("rejects a member re-pointing the backup at a foreign volume", async () => {
		await expect(
			volumeBackupsAs("member").update({
				...updateInput,
				volumeName: "postgres-victim-Zz9999-data",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateVolumeBackup).not.toHaveBeenCalled();
	});

	it("still updates the schedule of a row that keeps its volume", async () => {
		known.ownMounts.add("app-one-x_data");

		await volumeBackupsAs("member").update(updateInput);

		expect(mocks.updateVolumeBackup).toHaveBeenCalledTimes(1);
	});

	it("keeps an older row with an outside name editable unless another organization claims it", async () => {
		mocks.findVolumeBackupById.mockResolvedValue({
			volumeBackupId: "vb-1",
			applicationId: "app-1",
			volumeName: "legacy-data",
			destinationId: "dest-a",
		});
		known.ownMounts.add("legacy-data");
		const input = { ...updateInput, volumeName: "legacy-data" };

		await volumeBackupsAs("member").update(input);
		expect(mocks.updateVolumeBackup).toHaveBeenCalledTimes(1);

		known.claimedByOtherOrganization.add("legacy-data");
		await expect(volumeBackupsAs("member").update(input)).rejects.toMatchObject(
			{ code: "BAD_REQUEST" },
		);
		expect(mocks.updateVolumeBackup).toHaveBeenCalledTimes(1);
	});

	it("applies the owner/admin rule when the name changes", async () => {
		known.otherSameOrgMounts.add("shared-data");

		await expect(
			volumeBackupsAs("member").update({
				...updateInput,
				volumeName: "shared-data",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await volumeBackupsAs("admin").update({
			...updateInput,
			volumeName: "shared-data",
		});
		expect(mocks.updateVolumeBackup).toHaveBeenCalledTimes(1);
	});
});

describe("restoring a volume", () => {
	const restoreInput = {
		id: "app-1",
		serviceType: "application" as const,
		destinationId: "dest-a",
		backupFileName: "app-one-x_data-2024.tar",
		volumeName: "app-one-x_data",
	};

	beforeEach(() => {
		mocks.findVolumeBackupRows.mockResolvedValue([
			{ volumeName: "app-one-x_data" },
		]);
	});

	it("restores into a volume of the service", async () => {
		await expect(
			volumeBackupsAs("member").restoreVolumeBackupWithLogs(restoreInput),
		).resolves.toBeDefined();
	});

	it("rejects a volume that is not recorded on the service", async () => {
		await expect(
			volumeBackupsAs("member").restoreVolumeBackupWithLogs({
				...restoreInput,
				volumeName: "postgres-victim-Zz9999-data",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("only runs on the server of the service, never on one the caller picks", async () => {
		// local service, remote server named
		await expect(
			volumeBackupsAs("member").restoreVolumeBackupWithLogs({
				...restoreInput,
				serverId: "server-b",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		// remote service, local host asked for (empty or missing serverId)
		mocks.findVolumeBackupRows.mockResolvedValue([
			{ volumeName: "app-remote-x_data" },
		]);
		const remoteInput = {
			...restoreInput,
			id: "app-remote",
			volumeName: "app-remote-x_data",
		};
		for (const serverId of [undefined, "", "server-other"]) {
			await expect(
				volumeBackupsAs("member").restoreVolumeBackupWithLogs({
					...remoteInput,
					serverId,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(mocks.restoreVolume).not.toHaveBeenCalled();
	});

	it("runs the restore of a remote service on that server", async () => {
		mocks.findVolumeBackupRows.mockResolvedValue([
			{ volumeName: "app-remote-x_data" },
		]);
		mocks.findServerById.mockResolvedValue({ organizationId: "org-a" });
		mocks.restoreVolume.mockResolvedValue("echo restore");
		mocks.execAsyncRemote.mockResolvedValue(undefined);

		const observable = await volumeBackupsAs(
			"member",
		).restoreVolumeBackupWithLogs({
			...restoreInput,
			id: "app-remote",
			volumeName: "app-remote-x_data",
			serverId: "server-b",
		});
		await new Promise<void>((resolve) => {
			(
				observable as unknown as {
					subscribe: (observer: { complete: () => void }) => void;
				}
			).subscribe({ complete: resolve });
		});

		expect(mocks.restoreVolume).toHaveBeenCalledWith(
			"app-remote",
			"dest-a",
			"app-remote-x_data",
			"app-one-x_data-2024.tar",
			"server-b",
			"application",
		);
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"server-b",
			"echo restore",
			expect.any(Function),
		);
		expect(mocks.execAsyncStream).not.toHaveBeenCalled();
	});

	it("rejects a recorded name that another organization claims", async () => {
		mocks.findVolumeBackupRows.mockResolvedValue([{ volumeName: "orgb-data" }]);
		known.claimedByOtherOrganization.add("orgb-data");

		await expect(
			volumeBackupsAs("member").restoreVolumeBackupWithLogs({
				...restoreInput,
				volumeName: "orgb-data",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("named mounts", () => {
	const mountInput = {
		type: "volume" as const,
		serviceId: "app-1",
		serviceType: "application" as const,
		mountPath: "/data",
		volumeName: "app-one-x-data",
	};

	it("lets a member mount a named volume of their own service", async () => {
		await mountsAs("member").create(mountInput);
		await mountsAs("member").create({
			...mountInput,
			serviceId: "compose-1",
			serviceType: "compose",
			volumeName: "stack-x_cache",
		});
		await mountsAs("member").create({
			...mountInput,
			serviceId: "pg-1",
			serviceType: "postgres",
			volumeName: "postgres-db-AbC123-data",
		});

		expect(mocks.createMount).toHaveBeenCalledTimes(3);
	});

	it("rejects a member mounting another tenant's volume", async () => {
		known.claimedByOtherOrganization.add("orgb-data");

		for (const volumeName of [
			"orgb-data",
			"dokploy-postgres",
			"postgres-victim-Zz9999-data",
		]) {
			await expect(
				mountsAs("member").create({ ...mountInput, volumeName }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(mocks.createMount).not.toHaveBeenCalled();
	});

	it("does not look at bind and file mounts", async () => {
		await mountsAs("member").create({
			...mountInput,
			type: "bind",
			volumeName: undefined,
			hostPath: "/srv/data",
		});

		expect(mocks.createMount).toHaveBeenCalledTimes(1);
	});

	it("lets an owner or admin attach an outside volume only when the organization already mounts it", async () => {
		known.otherSameOrgMounts.add("shared-data");
		const input = { ...mountInput, volumeName: "shared-data" };

		await expect(mountsAs("member").create(input)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await mountsAs("admin").create(input);
		await mountsAs("owner").create(input);
		await expect(
			mountsAs("admin").create({ ...input, volumeName: "never-seen" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.createMount).toHaveBeenCalledTimes(2);
	});

	it("rejects a member updating a mount to a foreign volume", async () => {
		await expect(
			mountsAs("member").update({
				mountId: "mount-1",
				volumeName: "postgres-victim-Zz9999-data",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateMount).not.toHaveBeenCalled();
	});

	it("rejects turning a bind mount into a foreign named volume", async () => {
		mocks.findMountById.mockResolvedValue({
			mountId: "mount-1",
			type: "bind",
			serviceType: "application",
			volumeName: null,
			applicationId: "app-1",
		});

		await expect(
			mountsAs("member").update({
				mountId: "mount-1",
				type: "volume",
				volumeName: "orgb-data",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateMount).not.toHaveBeenCalled();
	});

	it("still updates the path of a mount that keeps its volume", async () => {
		await mountsAs("member").update({
			mountId: "mount-1",
			mountPath: "/other",
		});

		expect(mocks.updateMount).toHaveBeenCalledTimes(1);
	});

	it("refuses to update a mount whose volume another organization claims", async () => {
		mocks.findMountById.mockResolvedValue({
			mountId: "mount-1",
			type: "volume",
			serviceType: "application",
			volumeName: "orgb-data",
			applicationId: "app-1",
		});
		known.claimedByOtherOrganization.add("orgb-data");

		await expect(
			mountsAs("member").update({ mountId: "mount-1", mountPath: "/other" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("rejects re-pointing a mount at another service", async () => {
		await expect(
			mountsAs("member").update({
				mountId: "mount-1",
				applicationId: "foreign-app",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			mountsAs("member").update({ mountId: "mount-1", serviceType: "compose" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateMount).not.toHaveBeenCalled();
	});
});
