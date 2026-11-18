import { paths } from "@dokploy/server/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A bind mount hands a host path to a container and its uid/gid/mode make
// Dokploy run chown/chmod -R on it (T-8806). Members get no bind
// mounts; owners and admins keep the host. The policy is real here,
// only the service lookups and the permission checks are scripted.
const mocks = vi.hoisted(() => ({
	createMount: vi.fn(),
	updateMount: vi.fn(),
	findMountById: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	findLibsqlById: vi.fn(),
	findMariadbById: vi.fn(),
	findMongoById: vi.fn(),
	findMySqlById: vi.fn(),
	findPostgresById: vi.fn(),
	findRedisById: vi.fn(),
	isRootOrganization: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	assertVolumeNameForService: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	isRootOrganization: mocks.isRootOrganization,
	PINNED_ROOT_ORGANIZATION_MISSING_HOST_MESSAGE: "pinned",
	findServerById: vi.fn(),
	getWebServerSettings: vi.fn(),
	createMount: mocks.createMount,
	updateMount: mocks.updateMount,
	findMountById: mocks.findMountById,
	deleteMount: vi.fn(),
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
	findLibsqlById: mocks.findLibsqlById,
	findMariadbById: mocks.findMariadbById,
	findMongoById: mocks.findMongoById,
	findMountsByApplicationId: vi.fn(),
	findMySqlById: mocks.findMySqlById,
	findPostgresById: mocks.findPostgresById,
	findRedisById: mocks.findRedisById,
	getServiceContainer: vi.fn(),
	readFileMountContent: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServiceAccess: vi.fn(async () => undefined),
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("@/server/api/utils/volume-binding", () => ({
	assertVolumeNameForService: mocks.assertVolumeNameForService,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

const { mountRouter } = await import("@/server/api/routers/mount");

const ctxFor = (role: string) =>
	({
		session: { activeOrganizationId: "org-a" },
		user: { id: "user-1", email: "user@example.com", role },
	}) as never;

const as = (role: string) => mountRouter.createCaller(ctxFor(role));

// The remote server's directories are the same /etc/dokploy on every OS.
const ownDir = `${paths(true).APPLICATIONS_PATH}/app-one-x`;
const otherDir = `${paths(true).APPLICATIONS_PATH}/app-two-y`;

const service = (appName: string, serverId: string | null) => ({
	appName,
	serverId,
	environment: { project: { organizationId: "org-a" } },
});

const SERVICE_FINDERS = {
	application: mocks.findApplicationById,
	compose: mocks.findComposeById,
	libsql: mocks.findLibsqlById,
	mariadb: mocks.findMariadbById,
	mongo: mocks.findMongoById,
	mysql: mocks.findMySqlById,
	postgres: mocks.findPostgresById,
	redis: mocks.findRedisById,
} as const;

const SERVICE_TYPES = Object.keys(SERVICE_FINDERS) as Array<
	keyof typeof SERVICE_FINDERS
>;

const createInput = (extra: Record<string, unknown> = {}) => ({
	serviceId: "svc-1",
	serviceType: "application" as const,
	type: "bind" as const,
	mountPath: "/data",
	hostPath: "/srv/data",
	...extra,
});

const storedBind = (extra: Record<string, unknown> = {}) => ({
	mountId: "mount-1",
	type: "bind",
	serviceType: "application",
	applicationId: "svc-1",
	mountPath: "/data",
	hostPath: "/srv/stored",
	uid: null,
	gid: null,
	mode: null,
	volumeName: null,
	...extra,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.assertVolumeNameForService.mockResolvedValue(null);
	mocks.createMount.mockResolvedValue({ mountId: "mount-1" });
	mocks.updateMount.mockResolvedValue({ mountId: "mount-1" });
	mocks.isRootOrganization.mockResolvedValue(true);
	for (const finder of Object.values(SERVICE_FINDERS)) {
		finder.mockResolvedValue(service("app-one-x", "server-1"));
	}
	mocks.findMountById.mockResolvedValue(storedBind());
});

describe("creating a bind mount as a member", () => {
	it.each([
		"/var/run/docker.sock",
		"//var//run//docker.sock",
		"/var/run/../run/docker.sock",
		"/",
		"/etc",
		"/srv/data",
		otherDir,
		`${ownDir}/../app-two-y`,
	])("refuses %s", async (hostPath) => {
		await expect(
			as("member").create(createInput({ hostPath })),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringMatching(/owner or admin/i),
		});
		expect(mocks.createMount).not.toHaveBeenCalled();
	});

	it("refuses it for every kind of service", async () => {
		for (const serviceType of SERVICE_TYPES) {
			await expect(
				as("member").create(
					createInput({ serviceType, hostPath: "/var/run/docker.sock" }),
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(mocks.createMount).not.toHaveBeenCalled();
		for (const serviceType of SERVICE_TYPES) {
			expect(SERVICE_FINDERS[serviceType]).toHaveBeenCalledWith("svc-1");
		}
	});

	it("refuses a bind inside the service's own directories too, permissions included", async () => {
		await expect(
			as("member").create(createInput({ hostPath: `${ownDir}/files/data` })),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			as("member").create(
				createInput({
					hostPath: `${ownDir}/files/data/`,
					uid: 1000,
					mode: "750",
				}),
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.createMount).not.toHaveBeenCalled();
	});

	it("refuses permissions on a host path of the owners", async () => {
		await expect(
			as("member").create(createInput({ hostPath: "/srv/data", uid: 1000 })),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.createMount).not.toHaveBeenCalled();
	});

	it("still lets a member add volume and file mounts", async () => {
		await as("member").create({
			serviceId: "svc-1",
			serviceType: "application",
			type: "volume",
			volumeName: "app-one-x-data",
			mountPath: "/data",
		});
		await as("member").create({
			serviceId: "svc-1",
			serviceType: "application",
			type: "file",
			filePath: "config.json",
			content: "{}",
			mountPath: "/config.json",
		});
		expect(mocks.createMount).toHaveBeenCalledTimes(2);
		expect(mocks.findApplicationById).not.toHaveBeenCalled();
	});
});

describe("creating a bind mount as an owner or an admin", () => {
	it.each(["owner", "admin"])(
		"lets the %s bind the Docker socket and other host paths",
		async (role) => {
			for (const hostPath of ["/var/run/docker.sock", "/srv/data", "/"]) {
				await as(role).create(createInput({ hostPath }));
			}
			expect(mocks.createMount).toHaveBeenCalledTimes(3);
		},
	);

	it.each(["owner", "admin"])(
		"lets the %s set permissions on an ordinary host path",
		async (role) => {
			await as(role).create(
				createInput({
					hostPath: "/srv/data",
					uid: 1000,
					gid: 1000,
					mode: "750",
				}),
			);
			expect(mocks.createMount).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["owner", "admin"])(
		"refuses permissions on a dangerous host path for the %s",
		async (role) => {
			for (const hostPath of [
				"/",
				"/etc",
				"/var/run/docker.sock",
				"/home",
				"/home/deploy/.ssh",
				"/var/log",
				paths(true).BASE_PATH,
			]) {
				await expect(
					as(role).create(createInput({ hostPath, mode: "777" })),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
			}
			expect(mocks.createMount).not.toHaveBeenCalled();
		},
	);

	it.each(["owner", "admin"])(
		"answers a bad request for permissions on a path that is not canonical for the %s",
		async (role) => {
			for (const hostPath of [
				"//",
				"/srv/../etc",
				"/srv/data/",
				"/srv/a/./b",
			]) {
				await expect(
					as(role).create(createInput({ hostPath, mode: "777" })),
				).rejects.toMatchObject({ code: "BAD_REQUEST" });
			}
			expect(mocks.createMount).not.toHaveBeenCalled();
		},
	);

	it.each(["owner", "admin", "member"])(
		"answers a bad request for a relative host path for the %s",
		async (role) => {
			await expect(
				as(role).create(createInput({ hostPath: "data/relative" })),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.createMount).not.toHaveBeenCalled();
		},
	);

	it("refuses an admin of an organization that does not own the Dokploy host", async () => {
		mocks.isRootOrganization.mockResolvedValue(false);
		for (const finder of Object.values(SERVICE_FINDERS)) {
			finder.mockResolvedValue(service("app-one-x", null));
		}
		await expect(
			as("admin").create(createInput({ hostPath: "/var/run/docker.sock" })),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringMatching(/owns this Dokploy instance/i),
		});
		expect(mocks.createMount).not.toHaveBeenCalled();
	});

	it("keeps that admin off the service's own directories on the Dokploy host", async () => {
		mocks.isRootOrganization.mockResolvedValue(false);
		for (const finder of Object.values(SERVICE_FINDERS)) {
			finder.mockResolvedValue(service("app-one-x", null));
		}
		await expect(
			as("admin").create(createInput({ hostPath: `${ownDir}/files` })),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.createMount).not.toHaveBeenCalled();
	});

	it("lets that admin bind on a remote server of the organization", async () => {
		mocks.isRootOrganization.mockResolvedValue(false);
		await as("admin").create(createInput({ hostPath: "/var/run/docker.sock" }));
		expect(mocks.createMount).toHaveBeenCalledTimes(1);
	});
});

describe("updating a bind mount as a member", () => {
	it("refuses to point a volume mount at the Docker socket", async () => {
		mocks.findMountById.mockResolvedValue({
			...storedBind(),
			type: "volume",
			hostPath: null,
			volumeName: "app-one-x-data",
		});
		await expect(
			as("member").update({
				mountId: "mount-1",
				type: "bind",
				hostPath: "/var/run/docker.sock",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateMount).not.toHaveBeenCalled();
	});

	it("refuses to change the host path outside the service's directories", async () => {
		mocks.findMountById.mockResolvedValue(
			storedBind({ hostPath: `${ownDir}/files` }),
		);
		for (const hostPath of ["/", "/var/run/docker.sock", "/srv/x", otherDir]) {
			await expect(
				as("member").update({ mountId: "mount-1", hostPath }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(mocks.updateMount).not.toHaveBeenCalled();
	});

	it("refuses to change the permissions of a host path it does not own", async () => {
		for (const patch of [{ uid: 0 }, { gid: 0 }, { mode: "777" }]) {
			await expect(
				as("member").update({ mountId: "mount-1", ...patch }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(mocks.updateMount).not.toHaveBeenCalled();
	});

	it("refuses to move a bind inside its own directories or set permissions there", async () => {
		mocks.findMountById.mockResolvedValue(
			storedBind({ hostPath: `${ownDir}/files` }),
		);
		await expect(
			as("member").update({
				mountId: "mount-1",
				hostPath: `${ownDir}/files/more`,
				uid: 1000,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			as("member").update({ mountId: "mount-1", mode: "750" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateMount).not.toHaveBeenCalled();
	});

	it("keeps a bind of its own directories saved earlier editable for other fields", async () => {
		mocks.findMountById.mockResolvedValue(
			storedBind({ hostPath: `${ownDir}/files`, uid: 1000 }),
		);
		await as("member").update({ mountId: "mount-1", mountPath: "/other" });
		expect(mocks.updateMount).toHaveBeenCalledTimes(1);
	});

	it("keeps a bind saved earlier editable when the host path and permissions stay", async () => {
		mocks.findMountById.mockResolvedValue(
			storedBind({ hostPath: "/srv/stored", uid: 1000, mode: "750" }),
		);
		await as("member").update({ mountId: "mount-1", mountPath: "/other" });
		await as("member").update({
			mountId: "mount-1",
			hostPath: "/srv/stored",
			uid: 1000,
			mode: "750",
		});
		expect(mocks.updateMount).toHaveBeenCalledTimes(2);
		expect(mocks.findApplicationById).not.toHaveBeenCalled();
	});

	it("refuses it for every kind of service", async () => {
		for (const serviceType of SERVICE_TYPES) {
			mocks.findMountById.mockResolvedValue(
				storedBind({
					serviceType,
					applicationId: serviceType === "application" ? "svc-1" : null,
					[`${serviceType}Id`]: "svc-1",
				}),
			);
			await expect(
				as("member").update({
					mountId: "mount-1",
					serviceType,
					hostPath: "/var/run/docker.sock",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(mocks.updateMount).not.toHaveBeenCalled();
	});
});

describe("updating a mount without naming its service type", () => {
	it.each(SERVICE_TYPES)(
		"takes the %s service type from the stored row",
		async (serviceType) => {
			mocks.findMountById.mockResolvedValue(
				storedBind({
					serviceType,
					applicationId: serviceType === "application" ? "svc-1" : null,
					[`${serviceType}Id`]: "svc-1",
				}),
			);
			await as("owner").update({ mountId: "mount-1", mountPath: "/other" });
			expect(mocks.updateMount).toHaveBeenCalledTimes(1);
			expect(mocks.updateMount.mock.calls[0]?.[1].serviceType).toBeUndefined();
		},
	);

	it("still refuses to move a mount to another service type", async () => {
		await expect(
			as("owner").update({
				mountId: "mount-1",
				mountPath: "/other",
				serviceType: "postgres",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateMount).not.toHaveBeenCalled();
	});
});

describe("updating a bind mount as an owner or an admin", () => {
	it.each(["owner", "admin"])(
		"lets the %s change the host path to any host path",
		async (role) => {
			await as(role).update({
				mountId: "mount-1",
				hostPath: "/var/run/docker.sock",
			});
			expect(mocks.updateMount).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["owner", "admin"])(
		"refuses permissions on a dangerous host path for the %s",
		async (role) => {
			await expect(
				as(role).update({ mountId: "mount-1", hostPath: "/etc", mode: "777" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				as(role).update({ mountId: "mount-1", hostPath: "/", uid: 0 }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				as(role).update({ mountId: "mount-1", hostPath: "//", uid: 0 }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.updateMount).not.toHaveBeenCalled();
		},
	);

	it("refuses new permissions on a stored dangerous host path", async () => {
		mocks.findMountById.mockResolvedValue(storedBind({ hostPath: "/" }));
		await expect(
			as("owner").update({ mountId: "mount-1", mode: "777" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateMount).not.toHaveBeenCalled();
	});
});
