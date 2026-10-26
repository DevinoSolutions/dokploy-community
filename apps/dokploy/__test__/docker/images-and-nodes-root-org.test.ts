import { beforeEach, describe, expect, it, vi } from "vitest";

// The local host's images and swarm nodes are shared by every organization of
// the instance, so only the organization that owns it reads or removes them.
// A remote server stays with the organization it belongs to.

const mocks = vi.hoisted(() => ({
	isCloud: false,
	isRootOrganization: vi.fn(),
	getAccessibleServerIds: vi.fn(),
	getImages: vi.fn(),
	getImageConfig: vi.fn(),
	removeImage: vi.fn(),
	getSwarmNodes: vi.fn(),
	getNodeInfo: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	get IS_CLOUD() {
		return mocks.isCloud;
	},
	// enterpriseProcedure asks for a licence.
	hasValidLicense: async () => true,
	isRootOrganization: mocks.isRootOrganization,
	getImages: mocks.getImages,
	getImageConfig: mocks.getImageConfig,
	removeImage: mocks.removeImage,
	getSwarmNodes: mocks.getSwarmNodes,
	getNodeInfo: mocks.getNodeInfo,
	// the other swarm routes
	getAllContainerStats: vi.fn(),
	getApplicationInfo: vi.fn(),
	getNodeApplications: vi.fn(),
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

// swarm.ts takes containerIdRegex from the docker router, which is not under test
vi.mock("@/server/api/routers/docker", () => ({
	containerIdRegex: /^[a-zA-Z0-9.\-_]+$/,
}));

const { dockerImageRouter } = await import("@/server/api/routers/docker-image");
const { swarmRouter } = await import("@/server/api/routers/swarm");

const ROOT = "org-root";
const OTHER = "org-other";

const context = (organizationId: string) =>
	({
		session: { activeOrganizationId: organizationId },
		user: { id: "user-1", email: "admin@example.com", role: "admin" },
	}) as never;

type Callers = {
	images: ReturnType<typeof dockerImageRouter.createCaller>;
	swarm: ReturnType<typeof swarmRouter.createCaller>;
};
const callersIn = (organizationId: string): Callers => ({
	images: dockerImageRouter.createCaller(context(organizationId)),
	swarm: swarmRouter.createCaller(context(organizationId)),
});

const image = { repository: "app", tag: "latest", id: "sha256:abc" };

const routes: [
	string,
	(c: Callers, serverId?: string) => Promise<unknown>,
	() => ReturnType<typeof vi.fn>,
	(serverId?: string) => unknown[],
][] = [
	[
		"dockerImage.getImages",
		(c, serverId) => c.images.getImages({ serverId }),
		() => mocks.getImages,
		(serverId) => [serverId],
	],
	[
		"dockerImage.getImageConfig",
		(c, serverId) => c.images.getImageConfig({ imageRef: "app", serverId }),
		() => mocks.getImageConfig,
		(serverId) => ["app", serverId],
	],
	[
		"dockerImage.removeImage",
		(c, serverId) => c.images.removeImage({ ...image, serverId }),
		() => mocks.removeImage,
		(serverId) => [expect.objectContaining({ id: image.id }), serverId],
	],
	[
		"swarm.getNodes",
		(c, serverId) => c.swarm.getNodes({ serverId }),
		() => mocks.getSwarmNodes,
		(serverId) => [serverId],
	],
	[
		"swarm.getNodeInfo",
		(c, serverId) => c.swarm.getNodeInfo({ nodeId: "n1", serverId }),
		() => mocks.getNodeInfo,
		(serverId) => ["n1", serverId],
	],
];

const settle = (run: Promise<unknown>) =>
	run.then(
		() => null,
		(e) => e,
	);

describe("the local host's images and swarm nodes belong to the organization that owns the instance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isCloud = false;
		mocks.isRootOrganization.mockImplementation(
			async (organizationId: string) => organizationId === ROOT,
		);
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-own"]));
	});

	it.each(routes)(
		"%s refuses an organization that does not own the instance",
		async (_name, run, effect) => {
			const error = await settle(run(callersIn(OTHER)));

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
			const error = await settle(run(callersIn(OTHER), ""));

			expect(error).toMatchObject({ code: "FORBIDDEN" });
			expect(effect()).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s lets the organization that owns the instance through",
		async (_name, run, effect, args) => {
			expect(await settle(run(callersIn(ROOT)))).toBeNull();
			expect(effect()).toHaveBeenCalledWith(...args(undefined));
		},
	);

	it.each(routes)(
		"%s leaves a remote server of the caller's organization alone",
		async (_name, run, effect, args) => {
			expect(await settle(run(callersIn(OTHER), "server-own"))).toBeNull();
			expect(mocks.isRootOrganization).not.toHaveBeenCalled();
			expect(effect()).toHaveBeenCalledWith(...args("server-own"));
		},
	);

	it.each(routes)(
		"%s refuses a remote server of another organization",
		async (_name, run, effect) => {
			const error = await settle(run(callersIn(ROOT), "server-foreign"));

			expect(error).toMatchObject({ code: "UNAUTHORIZED" });
			expect(effect()).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s is unchanged on Dokploy Cloud",
		async (_name, run, effect, args) => {
			mocks.isCloud = true;

			expect(await settle(run(callersIn(OTHER)))).toBeNull();
			expect(mocks.isRootOrganization).not.toHaveBeenCalled();
			expect(effect()).toHaveBeenCalledWith(...args(undefined));
		},
	);
});
