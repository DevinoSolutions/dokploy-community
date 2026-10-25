import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findServerById: vi.fn(),
	assertRunningTraefikImageKept: vi.fn(),
	assertTraefikInstalled: vi.fn(),
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

type SetupOptions = {
	env: string[] | ((current: string[]) => string[]);
	additionalPorts:
		| { targetPort: number; publishedPort: number; protocol?: string }[]
		| ((
				current: { targetPort: number; publishedPort: number }[],
		  ) => { targetPort: number; publishedPort: number }[]);
};

describe("routine Traefik actions never pick the Traefik image", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findServerById.mockImplementation(async (serverId: string) => ({
			serverId,
			organizationId: "org-a",
		}));
		mocks.assertRunningTraefikImageKept.mockResolvedValue(undefined);
		mocks.assertTraefikInstalled.mockResolvedValue(undefined);
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
		"%s reads the host's Traefik when its job runs, not when it is requested",
		async (_name, run) => {
			await run();

			expect(mocks.readEnvironmentVariables).not.toHaveBeenCalled();
			expect(mocks.readPorts).not.toHaveBeenCalled();
		},
	);

	it.each(routineActions)(
		"%s is refused up front when the host has no Traefik",
		async (_name, run) => {
			mocks.assertTraefikInstalled.mockRejectedValue(
				new Error("Resource type not found"),
			);

			await expect(run()).rejects.toMatchObject({
				message: "Resource type not found",
			});
			expect(mocks.writeTraefikSetup).not.toHaveBeenCalled();
		},
	);

	it("save Traefik env keeps the ports the host runs when the job starts", async () => {
		await caller.writeTraefikEnv({ env: "A=1", serverId: "server-a" });

		const [options] = mocks.writeTraefikSetup.mock.calls[0]! as [SetupOptions];
		const live = [{ targetPort: 9000, publishedPort: 9000 }];
		expect(options.env).toEqual(["A=1"]);
		expect(
			typeof options.additionalPorts === "function" &&
				options.additionalPorts(live),
		).toBe(live);
	});

	it("save port mappings keeps the env the host runs when the job starts", async () => {
		await caller.updateTraefikPorts({
			serverId: "server-a",
			additionalPorts: [
				{ targetPort: 9000, publishedPort: 9000, protocol: "tcp" },
			],
		});

		const [options] = mocks.writeTraefikSetup.mock.calls[0]! as [SetupOptions];
		const live = ["A=2", "B=#kept"];
		expect(options.additionalPorts).toEqual([
			{ targetPort: 9000, publishedPort: 9000, protocol: "tcp" },
		]);
		expect(typeof options.env === "function" && options.env(live)).toBe(live);
	});

	it("dashboard toggle adds or drops 8080 on the ports the host runs when the job starts", async () => {
		const live = [
			{ targetPort: 9000, publishedPort: 9000 },
			{ targetPort: 8080, publishedPort: 8080 },
		];
		await caller.toggleDashboard({
			enableDashboard: false,
			serverId: "server-a",
		});
		await caller.toggleDashboard({
			enableDashboard: true,
			serverId: "server-a",
		});

		const [off, on] = mocks.writeTraefikSetup.mock.calls.map(
			([options]) => options as SetupOptions,
		);
		const ports = (options: SetupOptions, current: typeof live) =>
			typeof options.additionalPorts === "function"
				? options.additionalPorts(current)
				: options.additionalPorts;
		expect(ports(off!, live)).toEqual([live[0]]);
		expect(ports(on!, [live[0]!])).toEqual([
			live[0],
			{ targetPort: 8080, publishedPort: 8080, protocol: "tcp" },
		]);
	});

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
