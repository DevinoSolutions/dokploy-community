import { beforeEach, describe, expect, it, vi } from "vitest";

// The local host's Docker disk usage and build cache are shared by every
// organization of the instance, so only the organization that owns it reads or
// prunes them. A remote server stays with the organization it belongs to.

const mocks = vi.hoisted(() => ({
	isCloud: false,
	isRootOrganization: vi.fn(),
	getAccessibleServerIds: vi.fn(),
	getBuildCache: vi.fn(),
	getDockerDiskUsage: vi.fn(),
	cleanupBuilders: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	get IS_CLOUD() {
		return mocks.isCloud;
	},
	// enterpriseProcedure asks for a licence.
	hasValidLicense: async () => true,
	isRootOrganization: mocks.isRootOrganization,
	getBuildCache: mocks.getBuildCache,
	getDockerDiskUsage: mocks.getDockerDiskUsage,
	cleanupBuilders: mocks.cleanupBuilders,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server/services/server", () => ({
	getAccessibleServerIds: mocks.getAccessibleServerIds,
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

const { dockerDiskUsageRouter } = await import(
	"@/server/api/routers/docker-disk-usage"
);

const ROOT = "org-root";
const OTHER = "org-other";

type Caller = ReturnType<typeof callerIn>;
const callerIn = (organizationId: string) =>
	dockerDiskUsageRouter.createCaller({
		session: { activeOrganizationId: organizationId },
		user: { id: "user-1", email: "admin@example.com", role: "admin" },
	} as Parameters<typeof dockerDiskUsageRouter.createCaller>[0]);

const routes: [
	string,
	(c: Caller, serverId?: string) => Promise<unknown>,
	() => ReturnType<typeof vi.fn>,
][] = [
	[
		"getDiskUsage",
		(c, serverId) => c.getDiskUsage({ serverId }),
		() => mocks.getDockerDiskUsage,
	],
	[
		"getBuildCache",
		(c, serverId) => c.getBuildCache({ serverId }),
		() => mocks.getBuildCache,
	],
	[
		"pruneBuildCache",
		(c, serverId) => c.pruneBuildCache({ serverId }),
		() => mocks.cleanupBuilders,
	],
];

const settle = (run: Promise<unknown>) =>
	run.then(
		() => null,
		(e) => e,
	);

describe("the local host's disk usage and build cache belong to the organization that owns the instance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isCloud = false;
		mocks.isRootOrganization.mockImplementation(
			async (organizationId: string) => organizationId === ROOT,
		);
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-own"]));
		mocks.getBuildCache.mockResolvedValue([]);
		mocks.getDockerDiskUsage.mockResolvedValue([]);
	});

	it.each(routes)(
		"%s refuses an organization that does not own the instance",
		async (_name, run, effect) => {
			const error = await settle(run(callerIn(OTHER)));

			expect(error).toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringContaining("owns this Dokploy instance"),
			});
			expect(effect()).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s treats an empty serverId as the local host",
		async (_name, run, effect) => {
			const error = await settle(run(callerIn(OTHER), ""));

			expect(error).toMatchObject({ code: "FORBIDDEN" });
			expect(effect()).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s lets the organization that owns the instance through",
		async (_name, run, effect) => {
			expect(await settle(run(callerIn(ROOT)))).toBeNull();
			expect(effect()).toHaveBeenCalledWith(undefined);
		},
	);

	it.each(routes)(
		"%s leaves a remote server of the caller's organization alone",
		async (_name, run, effect) => {
			expect(await settle(run(callerIn(OTHER), "server-own"))).toBeNull();
			expect(mocks.isRootOrganization).not.toHaveBeenCalled();
			expect(effect()).toHaveBeenCalledWith("server-own");
		},
	);

	it.each(routes)(
		"%s refuses a remote server of another organization",
		async (_name, run, effect) => {
			const error = await settle(run(callerIn(ROOT), "server-foreign"));

			expect(error).toMatchObject({ code: "UNAUTHORIZED" });
			expect(effect()).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s is unchanged on Dokploy Cloud",
		async (_name, run, effect) => {
			mocks.isCloud = true;

			expect(await settle(run(callerIn(OTHER)))).toBeNull();
			expect(mocks.isRootOrganization).not.toHaveBeenCalled();
			expect(effect()).toHaveBeenCalledWith(undefined);
		},
	);
});
