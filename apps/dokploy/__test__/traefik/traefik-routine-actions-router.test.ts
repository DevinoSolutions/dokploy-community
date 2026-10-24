import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findServerById: vi.fn(),
	assertRunningTraefikImageKept: vi.fn(),
	checkPortInUse: vi.fn(),
	prepareEnvironmentVariables: vi.fn((env: string) =>
		env ? env.split("\n") : [],
	),
	readEnvironmentVariables: vi.fn(),
	readPorts: vi.fn(),
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

const caller = settingsRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "admin@example.com", role: "admin" },
} as Parameters<typeof settingsRouter.createCaller>[0]);

const routineActions = [
	[
		"save Traefik env",
		() => caller.writeTraefikEnv({ env: "A=1", serverId: "server-a" }),
	],
	[
		"save port mappings",
		() =>
			caller.updateTraefikPorts({
				serverId: "server-a",
				additionalPorts: [
					{ targetPort: 9000, publishedPort: 9000, protocol: "tcp" },
				],
			}),
	],
	[
		"dashboard toggle",
		() =>
			caller.toggleDashboard({ enableDashboard: true, serverId: "server-a" }),
	],
] as const;

describe("routine Traefik actions never pick the Traefik image", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findServerById.mockImplementation(async (serverId: string) => ({
			serverId,
			organizationId: "org-a",
		}));
		mocks.assertRunningTraefikImageKept.mockResolvedValue(undefined);
		mocks.checkPortInUse.mockResolvedValue({ isInUse: false });
		mocks.readEnvironmentVariables.mockResolvedValue("A=0");
		mocks.readPorts.mockResolvedValue([]);
		mocks.writeTraefikSetup.mockResolvedValue(undefined);
	});

	it.each(routineActions)(
		"%s recreates without an image, so the running one is kept",
		async (_name, run) => {
			await expect(run()).resolves.toBe(true);

			expect(mocks.assertRunningTraefikImageKept).toHaveBeenCalledWith(
				"server-a",
			);
			expect(mocks.writeTraefikSetup).toHaveBeenCalledOnce();
			const [options] = mocks.writeTraefikSetup.mock.calls[0]!;
			expect(options).toMatchObject({ serverId: "server-a" });
			expect(options).not.toHaveProperty("image");
		},
	);

	it.each(routineActions)(
		"%s is refused up front when the running image has no readable tag",
		async (_name, run) => {
			mocks.assertRunningTraefikImageKept.mockRejectedValue(
				new Error(
					'Can\'t read the version tag of the running Traefik image "traefik"',
				),
			);

			await expect(run()).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("Can't read the version tag"),
			});
			expect(mocks.writeTraefikSetup).not.toHaveBeenCalled();
		},
	);
});
