import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findServerById: vi.fn(),
	isRootOrganization: vi.fn(),
	assertRunningTraefikImageKept: vi.fn(),
	assertTraefikInstalled: vi.fn(),
	checkPortInUse: vi.fn(),
	getTraefikOverview: vi.fn(),
	prepareEnvironmentVariables: vi.fn((env: string) =>
		env ? env.split("\n") : [],
	),
	pullTraefikImage: vi.fn(),
	readEnvironmentVariables: vi.fn(),
	reloadDockerResource: vi.fn(),
	writeTraefikSetup: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	...mocks,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
}));

const { settingsRouter } = await import("@/server/api/routers/settings");

const callerIn = (organizationId: string) =>
	settingsRouter.createCaller({
		session: { activeOrganizationId: organizationId },
		user: { id: "user-1", email: "admin@example.com", role: "admin" },
	} as Parameters<typeof settingsRouter.createCaller>[0]);

const ROOT = "org-root";
const OTHER = "org-other";

const port = {
	targetPort: 9000,
	publishedPort: 9000,
	protocol: "tcp",
} as const;

// Each route with and without a serverId, as the dashboard calls it.
const routes = [
	[
		"reloadTraefik",
		(c: ReturnType<typeof callerIn>, serverId?: string) =>
			c.reloadTraefik({ serverId }),
	],
	[
		"toggleDashboard",
		(c: ReturnType<typeof callerIn>, serverId?: string) =>
			c.toggleDashboard({ enableDashboard: true, serverId }),
	],
	[
		"updateTraefikPorts",
		(c: ReturnType<typeof callerIn>, serverId?: string) =>
			c.updateTraefikPorts({ additionalPorts: [port], serverId }),
	],
	[
		"writeTraefikEnv",
		(c: ReturnType<typeof callerIn>, serverId?: string) =>
			c.writeTraefikEnv({ env: "A=1", serverId }),
	],
	[
		"readTraefikEnv",
		(c: ReturnType<typeof callerIn>, serverId?: string) =>
			c.readTraefikEnv({ serverId }),
	],
	[
		"updateTraefik",
		(c: ReturnType<typeof callerIn>, serverId?: string) =>
			c.updateTraefik({ serverId }),
	],
] as const;

describe("the local host's Traefik belongs to the instance's organization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isRootOrganization.mockImplementation(
			async (organizationId: string) => organizationId === ROOT,
		);
		mocks.findServerById.mockImplementation(async (serverId: string) => ({
			serverId,
			organizationId: OTHER,
		}));
		mocks.assertRunningTraefikImageKept.mockResolvedValue(undefined);
		mocks.assertTraefikInstalled.mockResolvedValue(undefined);
		mocks.checkPortInUse.mockResolvedValue({ isInUse: false });
		mocks.getTraefikOverview.mockResolvedValue({
			state: "running",
			startedAt: "2026-10-25T03:00:00Z",
			image: "traefik:v3.6.25",
			currentVersion: "3.6.25",
			recommendedVersion: "3.7.16",
			versionStatus: "outdated",
		});
		mocks.pullTraefikImage.mockResolvedValue(undefined);
		mocks.readEnvironmentVariables.mockResolvedValue("A=0");
		mocks.reloadDockerResource.mockResolvedValue(undefined);
		mocks.writeTraefikSetup.mockResolvedValue(undefined);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it.each(routes)(
		"%s refuses an organization that does not own the instance",
		async (_name, run) => {
			await expect(run(callerIn(OTHER))).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringContaining("owns this Dokploy instance"),
			});

			expect(mocks.writeTraefikSetup).not.toHaveBeenCalled();
			expect(mocks.reloadDockerResource).not.toHaveBeenCalled();
			expect(mocks.readEnvironmentVariables).not.toHaveBeenCalled();
			expect(mocks.pullTraefikImage).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s treats an empty serverId as the local host",
		async (_name, run) => {
			await expect(run(callerIn(OTHER), "")).rejects.toMatchObject({
				code: "FORBIDDEN",
			});

			expect(mocks.findServerById).not.toHaveBeenCalled();
			expect(mocks.writeTraefikSetup).not.toHaveBeenCalled();
			expect(mocks.reloadDockerResource).not.toHaveBeenCalled();
			expect(mocks.readEnvironmentVariables).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s lets the organization that owns the instance through",
		async (_name, run) => {
			await expect(run(callerIn(ROOT))).resolves.toBeDefined();

			expect(mocks.isRootOrganization).toHaveBeenCalledWith(ROOT);
		},
	);

	it.each(routes)(
		"%s leaves a remote server of the caller's organization to the server check",
		async (_name, run) => {
			mocks.findServerById.mockResolvedValue({
				serverId: "server-a",
				organizationId: OTHER,
			});

			await expect(run(callerIn(OTHER), "server-a")).resolves.toBeDefined();

			expect(mocks.isRootOrganization).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s still refuses a remote server of another organization",
		async (_name, run) => {
			await expect(run(callerIn(ROOT), "server-a")).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});

			expect(mocks.writeTraefikSetup).not.toHaveBeenCalled();
		},
	);
});
