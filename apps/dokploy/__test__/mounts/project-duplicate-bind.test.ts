import { beforeEach, describe, expect, it, vi } from "vitest";

// `project.duplicate` copies the mounts of a service through createMount. A
// bind mount is an owner and admin capability, so a member's copy gets none
// and an owner's copy only gets what the bind mount policy allows. The policy
// is decided before anything is created (T-8806). The policy is the real one,
// only the rows it reads are scripted.
const mocks = vi.hoisted(() => ({
	execute: vi.fn(),
	createProject: vi.fn(),
	findEnvironmentById: vi.fn(),
	findMountsByApplicationId: vi.fn(),
	createMount: vi.fn(),
	isRootOrganization: vi.fn(),
	finders: {} as Record<string, ReturnType<typeof vi.fn>>,
	creators: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

const TYPES = [
	["application", "Application", "findApplicationById"],
	["compose", "Compose", "findComposeById"],
	["libsql", "Libsql", "findLibsqlById"],
	["mariadb", "Mariadb", "findMariadbById"],
	["mongo", "Mongo", "findMongoById"],
	["mysql", "Mysql", "findMySqlById"],
	["postgres", "Postgres", "findPostgresById"],
	["redis", "Redis", "findRedisById"],
] as const;

vi.mock("@dokploy/server", () => {
	const stubs: Record<string | symbol, unknown> = {};
	const named: Record<string, unknown> = {
		IS_CLOUD: false,
		createProject: mocks.createProject,
		findEnvironmentById: mocks.findEnvironmentById,
		findMountsByApplicationId: mocks.findMountsByApplicationId,
		createMount: mocks.createMount,
		isRootOrganization: mocks.isRootOrganization,
	};
	for (const [type, pascal, finder] of TYPES) {
		mocks.finders[type] = vi.fn();
		mocks.creators[type] = vi.fn();
		named[finder] = mocks.finders[type];
		named[`create${pascal}`] = mocks.creators[type];
	}
	return new Proxy(stubs, {
		get: (target, key) => {
			if (key === "then") {
				return undefined;
			}
			if (typeof key === "string" && key in named) {
				return named[key];
			}
			target[key] ??= vi.fn();
			return target[key];
		},
		has: () => true,
	});
});

vi.mock("@dokploy/server/services/permission", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/permission")
	>()),
	checkProjectAccess: vi.fn(async () => undefined),
	checkServicePermissionAndAccess: vi.fn(async () => undefined),
	findMemberByUserId: vi.fn(async () => ({ accessedProjects: [] })),
}));

vi.mock("@dokploy/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/db")>()),
	db: { execute: mocks.execute },
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

const { projectRouter } = await import("@/server/api/routers/project");

const as = (role: string) =>
	projectRouter.createCaller({
		session: { activeOrganizationId: "org-b" },
		user: { id: "user-1", email: "user@example.com", role },
	} as never);

const dockerSocket = {
	mountId: "bind-1",
	type: "bind",
	hostPath: "/var/run/docker.sock",
	mountPath: "/var/run/docker.sock",
	uid: null,
	gid: null,
	mode: null,
};
const dataVolume = {
	mountId: "vol-1",
	type: "volume",
	volumeName: "web-AbC123-data",
	mountPath: "/data",
};

type ServiceKind = (typeof TYPES)[number][0];

const input = (type: ServiceKind, overrides: Record<string, unknown> = {}) => ({
	sourceEnvironmentId: "env-b",
	name: "copy",
	includeServices: true,
	selectedServices: [{ id: "svc-1", type }],
	duplicateInSameProject: false,
	...overrides,
});

const scriptService = (type: ServiceKind, mounts: unknown[]) => {
	mocks.findMountsByApplicationId.mockResolvedValue(mounts);
	mocks.finders[type]?.mockResolvedValue({
		[`${type}Id`]: "svc-1",
		appName: "web-AbC123",
		name: "web",
		serverId: null,
		environment: { project: { organizationId: "org-b" } },
		domains: [],
		security: [],
		ports: [],
		redirects: [],
		previewDeployments: [],
		backups: [],
		mounts,
		registry: null,
		refreshToken: "t",
	});
	mocks.creators[type]?.mockResolvedValue({ [`${type}Id`]: "svc-new" });
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execute.mockResolvedValue([{ organizationId: "org-b" }]);
	mocks.createProject.mockResolvedValue({
		environment: { environmentId: "env-new" },
	});
	mocks.findEnvironmentById.mockResolvedValue({
		environmentId: "env-b",
		project: { organizationId: "org-b", projectId: "p-b", env: "" },
	});
	mocks.isRootOrganization.mockResolvedValue(true);
	mocks.createMount.mockResolvedValue({ mountId: "new" });
});

describe.each(TYPES)("project.duplicate of a %s", (type) => {
	it("leaves the bind mounts out of a member's copy and says how many", async () => {
		scriptService(type, [dockerSocket, dataVolume]);

		const result = await as("member").duplicate(input(type));

		expect(mocks.creators[type]).toHaveBeenCalledTimes(1);
		expect(mocks.createMount).toHaveBeenCalledTimes(1);
		expect(mocks.createMount.mock.calls[0]?.[0]).toMatchObject({
			type: "volume",
			serviceId: "svc-new",
			serviceType: type,
		});
		expect(result).toMatchObject({ skippedBindMounts: 1 });
	});

	it("keeps an owner's bind mount when the policy allows it", async () => {
		scriptService(type, [dockerSocket, dataVolume]);

		const result = await as("owner").duplicate(input(type));

		expect(mocks.createMount).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({ skippedBindMounts: 0 });
	});

	it("refuses the copy before creating anything when a bind may not be copied", async () => {
		scriptService(type, [
			{ ...dataVolume },
			{ ...dockerSocket, hostPath: "/", mode: "777" },
		]);

		await expect(as("owner").duplicate(input(type))).rejects.toMatchObject({
			code: "BAD_REQUEST",
			cause: { code: "FORBIDDEN" },
		});

		expect(mocks.createProject).not.toHaveBeenCalled();
		expect(mocks.creators[type]).not.toHaveBeenCalled();
		expect(mocks.createMount).not.toHaveBeenCalled();
	});
});

describe("project.duplicate and the Dokploy host", () => {
	it("keeps an admin of another organization from copying a bind of the host", async () => {
		mocks.isRootOrganization.mockResolvedValue(false);
		scriptService("application", [dockerSocket]);

		await expect(
			as("admin").duplicate(input("application")),
		).rejects.toMatchObject({ cause: { code: "FORBIDDEN" } });
		expect(mocks.createProject).not.toHaveBeenCalled();
		expect(mocks.creators.application).not.toHaveBeenCalled();
	});

	it("copies a service without bind mounts for a member as before", async () => {
		scriptService("application", [dataVolume]);

		const result = await as("member").duplicate(input("application"));

		expect(mocks.createMount).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ skippedBindMounts: 0 });
	});
});
