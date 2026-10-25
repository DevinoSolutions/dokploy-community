import { beforeEach, describe, expect, it, vi } from "vitest";

// The Dokploy host's own Traefik (its env, its config files) belongs to the
// organization that owns the instance (the first one created). A remote server
// stays with the organization it belongs to.

const mocks = vi.hoisted(() => ({
	isRootOrganization: vi.fn(),
	findServerById: vi.fn(),
	assertRunningTraefikImageKept: vi.fn(),
	prepareEnvironmentVariables: vi.fn((env: string) =>
		env ? env.split("\n") : [],
	),
	readConfig: vi.fn(),
	readConfigInPath: vi.fn(),
	readDirectory: vi.fn(),
	readEnvironmentVariables: vi.fn(),
	readMainConfig: vi.fn(),
	readPorts: vi.fn(),
	writeConfig: vi.fn(),
	writeMainConfig: vi.fn(),
	writeTraefikConfigInPath: vi.fn(),
	writeTraefikSetup: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	paths: () => ({
		MONITORING_PATH: "/monitoring",
		MAIN_TRAEFIK_PATH: "/etc/dokploy/traefik",
	}),
	...mocks,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
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

const ROOT = "org-root";
const OTHER = "org-other";

type Caller = ReturnType<typeof callerIn>;
const callerIn = (organizationId: string) =>
	settingsRouter.createCaller({
		session: { activeOrganizationId: organizationId },
		user: { id: "user-1", email: "admin@example.com", role: "admin" },
	} as Parameters<typeof settingsRouter.createCaller>[0]);

// [route, how it is called, what it does once let through, takes a serverId]
const routes: [
	string,
	(c: Caller, serverId?: string) => Promise<unknown>,
	() => ReturnType<typeof vi.fn>,
	boolean,
][] = [
	[
		"readTraefikEnv",
		(c, serverId) => c.readTraefikEnv({ serverId }),
		() => mocks.readEnvironmentVariables,
		true,
	],
	[
		"writeTraefikEnv",
		(c, serverId) => c.writeTraefikEnv({ env: "A=1", serverId }),
		() => mocks.writeTraefikSetup,
		true,
	],
	[
		"readDirectories",
		(c, serverId) => c.readDirectories({ serverId }),
		() => mocks.readDirectory,
		true,
	],
	[
		"readTraefikFile",
		(c, serverId) => c.readTraefikFile({ path: "traefik.yml", serverId }),
		() => mocks.readConfigInPath,
		true,
	],
	[
		"updateTraefikFile",
		(c, serverId) =>
			c.updateTraefikFile({
				path: "traefik.yml",
				traefikConfig: "a: 1",
				serverId,
			}),
		() => mocks.writeTraefikConfigInPath,
		true,
	],
	[
		"readTraefikConfig",
		(c) => c.readTraefikConfig(),
		() => mocks.readMainConfig,
		false,
	],
	[
		"updateTraefikConfig",
		(c) => c.updateTraefikConfig({ traefikConfig: "a: 1" }),
		() => mocks.writeMainConfig,
		false,
	],
	[
		"readWebServerTraefikConfig",
		(c) => c.readWebServerTraefikConfig(),
		() => mocks.readConfig,
		false,
	],
	[
		"updateWebServerTraefikConfig",
		(c) => c.updateWebServerTraefikConfig({ traefikConfig: "a: 1" }),
		() => mocks.writeConfig,
		false,
	],
	[
		"readMiddlewareTraefikConfig",
		(c) => c.readMiddlewareTraefikConfig(),
		() => mocks.readConfig,
		false,
	],
	[
		"updateMiddlewareTraefikConfig",
		(c) => c.updateMiddlewareTraefikConfig({ traefikConfig: "a: 1" }),
		() => mocks.writeConfig,
		false,
	],
];

const settle = (run: Promise<unknown>) =>
	run.then(
		() => null,
		(e) => e,
	);

describe("the local host's Traefik belongs to the organization that owns the instance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isRootOrganization.mockImplementation(
			async (organizationId: string) => organizationId === ROOT,
		);
		mocks.findServerById.mockResolvedValue({
			serverId: "server-a",
			organizationId: OTHER,
		});
		mocks.assertRunningTraefikImageKept.mockResolvedValue(undefined);
		mocks.readMainConfig.mockReturnValue("a: 1");
		mocks.readConfig.mockReturnValue("a: 1");
		mocks.readEnvironmentVariables.mockResolvedValue("A=0");
		mocks.readPorts.mockResolvedValue([]);
		mocks.writeTraefikSetup.mockResolvedValue(undefined);
		vi.spyOn(console, "error").mockImplementation(() => {});
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
		"%s lets the organization that owns the instance through",
		async (_name, run, effect) => {
			const error = await settle(run(callerIn(ROOT)));

			expect(error?.code).not.toBe("FORBIDDEN");
			expect(effect()).toHaveBeenCalled();
		},
	);

	it.each(routes.filter(([, , , takesServerId]) => takesServerId))(
		"%s leaves a remote server of the caller's organization alone",
		async (_name, run, effect) => {
			const error = await settle(run(callerIn(OTHER), "server-a"));

			expect(error?.code).not.toBe("FORBIDDEN");
			expect(mocks.isRootOrganization).not.toHaveBeenCalled();
			expect(effect()).toHaveBeenCalled();
		},
	);

	it.each(routes.filter(([, , , takesServerId]) => takesServerId))(
		"%s treats an empty serverId as the local host",
		async (_name, run, effect) => {
			const error = await settle(run(callerIn(OTHER), ""));

			expect(error).toMatchObject({ code: "FORBIDDEN" });
			expect(effect()).not.toHaveBeenCalled();
		},
	);
});
