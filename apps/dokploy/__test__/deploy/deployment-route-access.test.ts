import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * deployment.readLogs, killProcess and removeDeployment take a bare
 * deploymentId. A deployment row points at what it belongs to through
 * different columns depending on its kind, and several kinds carry no service
 * id, so each kind has to be resolved to something that can be authorized:
 * the caller needs access to it, inside their active organization.
 */

const mocks = vi.hoisted(() => ({
	memberRole: "member" as string,
	accessedServices: [] as string[],
	// serviceId -> organizationId
	serviceOrgs: {
		"app-own": "org-1",
		"comp-own": "org-1",
		"pg-own": "org-1",
		"app-foreign": "org-2",
		"comp-foreign": "org-2",
		"pg-foreign": "org-2",
	} as Record<string, string>,
	serverOrgs: { "srv-own": "org-1", "srv-foreign": "org-2" } as Record<
		string,
		string
	>,
	previews: {
		"prev-own": { applicationId: "app-own", composeId: null },
		"prev-foreign": { applicationId: "app-foreign", composeId: null },
	} as Record<string, unknown>,
	backups: {
		"bk-pg-own": { postgresId: "pg-own" },
		"bk-pg-foreign": { postgresId: "pg-foreign" },
		"bk-web-own": { destination: { organizationId: "org-1" } },
		"bk-web-foreign": { destination: { organizationId: "org-2" } },
	} as Record<string, unknown>,
	volumeBackups: {
		"vb-own": { applicationId: "app-own" },
		"vb-foreign": { applicationId: "app-foreign" },
	} as Record<string, unknown>,
	deployment: null as Record<string, unknown> | null,
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	removeDeployment: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: new Proxy(
			{},
			{
				get: (_target, table) =>
					table === "member"
						? {
								findFirst: vi.fn(async () => ({
									id: "member-1",
									userId: "user-1",
									organizationId: "org-1",
									role: mocks.memberRole,
									accessedServices: mocks.accessedServices,
									accessedProjects: [],
									accessedEnvironments: [],
									user: { id: "user-1" },
								})),
							}
						: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
			},
		),
		// Service -> organization resolver used by assertServiceInOrganization.
		// The id being looked up is a bound parameter of the sql template.
		execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
			const id = (query.queryChunks ?? []).find(
				(chunk): chunk is string =>
					typeof chunk === "string" && chunk in mocks.serviceOrgs,
			);
			return id ? [{ organizationId: mocks.serviceOrgs[id] }] : [];
		}),
	},
	dbUrl: "postgres://mock:mock@localhost:5432/mock",
}));

const lookup = (registry: () => Record<string, unknown>) =>
	vi.fn(async (id: string) => {
		const found = registry()[id];
		if (!found) throw new Error("not found");
		return found;
	});

vi.mock("@dokploy/server/services/deployment", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findDeploymentById: vi.fn(async () => mocks.deployment),
	removeDeployment: mocks.removeDeployment,
	updateDeploymentStatus: vi.fn(),
}));

vi.mock(
	"@dokploy/server/services/preview-deployment",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		findPreviewDeploymentById: lookup(() => mocks.previews),
	}),
);

vi.mock("@dokploy/server/services/backup", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findBackupById: lookup(() => mocks.backups),
}));

vi.mock("@dokploy/server/services/volume-backups", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findVolumeBackupById: lookup(() => mocks.volumeBackups),
}));

vi.mock("@dokploy/server/services/server", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findServerById: vi.fn(async (serverId: string) => {
		const organizationId = mocks.serverOrgs[serverId];
		if (!organizationId) throw new Error("Server not found");
		return { serverId, organizationId };
	}),
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<object>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

// The native binding is not needed to exercise the router.
vi.mock("bcrypt", () => ({ default: {}, hash: vi.fn(), compare: vi.fn() }));

vi.mock("@/server/api/utils/cancel-audit", () => ({ auditCancel: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { deploymentRouter } = await import("@/server/api/routers/deployment");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = () =>
	createCallerFactory(deploymentRouter)({
		user: { id: "user-1", email: "user@test.com", role: "member" },
		session: { activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

const row = (extra: Record<string, unknown>) => ({
	deploymentId: "dep-1",
	applicationId: null,
	composeId: null,
	previewDeploymentId: null,
	scheduleId: null,
	backupId: null,
	volumeBackupId: null,
	serverId: null,
	schedule: null,
	pid: "4242",
	logPath: "",
	...extra,
});

type Side = "own" | "foreign";

type Kind = {
	name: string;
	build: (side: Side) => Record<string, unknown>;
	// service ids the caller would need on their access list
	services: (side: Side) => string[];
	// "member" kinds are open to a member with access to the service; host
	// level kinds are owner/admin only
	hostLevel: boolean;
};

const schedule = (side: Side, extra: Record<string, unknown>) =>
	row({
		scheduleId: "sch-1",
		schedule: {
			scheduleId: "sch-1",
			applicationId: null,
			composeId: null,
			serverId: null,
			organizationId: null,
			...extra,
		},
	});

const kinds: Kind[] = [
	{
		name: "application",
		build: (side) => row({ applicationId: `app-${side}` }),
		services: (side) => [`app-${side}`],
		hostLevel: false,
	},
	{
		name: "compose",
		build: (side) => row({ composeId: `comp-${side}` }),
		services: (side) => [`comp-${side}`],
		hostLevel: false,
	},
	{
		name: "preview",
		build: (side) => row({ previewDeploymentId: `prev-${side}` }),
		services: (side) => [`app-${side}`],
		hostLevel: false,
	},
	{
		name: "application schedule",
		build: (side) =>
			schedule(side, {
				scheduleType: "application",
				applicationId: `app-${side}`,
			}),
		services: (side) => [`app-${side}`],
		hostLevel: false,
	},
	{
		name: "compose schedule",
		build: (side) =>
			schedule(side, { scheduleType: "compose", composeId: `comp-${side}` }),
		services: (side) => [`comp-${side}`],
		hostLevel: false,
	},
	{
		name: "server schedule",
		build: (side) =>
			schedule(side, { scheduleType: "server", serverId: `srv-${side}` }),
		services: () => [],
		hostLevel: true,
	},
	{
		name: "dokploy-server schedule",
		build: (side) =>
			schedule(side, {
				scheduleType: "dokploy-server",
				organizationId: side === "own" ? "org-1" : "org-2",
			}),
		services: () => [],
		hostLevel: true,
	},
	{
		name: "database backup",
		build: (side) => row({ backupId: `bk-pg-${side}` }),
		services: (side) => [`pg-${side}`],
		hostLevel: false,
	},
	{
		name: "web server backup",
		build: (side) => row({ backupId: `bk-web-${side}` }),
		services: () => [],
		hostLevel: true,
	},
	{
		name: "volume backup",
		build: (side) => row({ volumeBackupId: `vb-${side}` }),
		services: (side) => [`app-${side}`],
		hostLevel: false,
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.memberRole = "member";
	mocks.accessedServices = [];
	mocks.removeDeployment.mockResolvedValue(true);
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
});

const expectNothingRan = () => {
	expect(mocks.execAsync).not.toHaveBeenCalled();
	expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	expect(mocks.removeDeployment).not.toHaveBeenCalled();
};

const everyRoute = async (code: string) => {
	const c = caller();
	await expect(
		c.readLogs({ deploymentId: "dep-1", tail: 10 }),
	).rejects.toMatchObject({ code });
	await expect(
		c.killProcess({ deploymentId: "dep-1" }),
	).rejects.toMatchObject({ code });
	await expect(
		c.removeDeployment({ deploymentId: "dep-1" }),
	).rejects.toMatchObject({ code });
	expectNothingRan();
};

describe.each(kinds)("$name deployments", (kind) => {
	it(`are available to ${kind.hostLevel ? "an admin" : "a member with access"}`, async () => {
		mocks.memberRole = kind.hostLevel ? "admin" : "member";
		mocks.accessedServices = kind.services("own");
		mocks.deployment = kind.build("own");

		await expect(
			caller().readLogs({ deploymentId: "dep-1", tail: 10 }),
		).resolves.toBe("");
		await caller().removeDeployment({ deploymentId: "dep-1" });
		expect(mocks.removeDeployment).toHaveBeenCalledTimes(1);
	});

	it("are refused when they belong to another organization", async () => {
		// Even an admin, and even with the foreign id on the access list
		mocks.memberRole = kind.hostLevel ? "admin" : "member";
		mocks.accessedServices = kind.services("foreign");
		mocks.deployment = kind.build("foreign");

		await everyRoute("UNAUTHORIZED");
	});

	it(
		kind.hostLevel
			? "are refused to a plain member"
			: "are refused to a member without access to the service",
		async () => {
			mocks.memberRole = "member";
			mocks.accessedServices = [];
			mocks.deployment = kind.build("own");

			await everyRoute(kind.hostLevel ? "FORBIDDEN" : "UNAUTHORIZED");
		},
	);
});

describe("server setup deployments", () => {
	it("are available inside the organization", async () => {
		mocks.deployment = row({ serverId: "srv-own" });
		await expect(
			caller().readLogs({ deploymentId: "dep-1", tail: 10 }),
		).resolves.toBe("");
	});

	it("are refused for another organization's server", async () => {
		mocks.deployment = row({ serverId: "srv-foreign" });
		await everyRoute("UNAUTHORIZED");
	});
});

describe("deployments that belong to nothing", () => {
	it("are refused", async () => {
		mocks.memberRole = "admin";
		mocks.deployment = row({});
		await everyRoute("UNAUTHORIZED");
	});
});
