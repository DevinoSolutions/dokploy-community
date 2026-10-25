import { beforeEach, describe, expect, it, vi } from "vitest";

// The Dokploy host's own settings and actions belong to the organization that
// owns the instance (the first one created). A remote server stays with the
// organization it belongs to.

const mocks = vi.hoisted(() => ({
	isRootOrganization: vi.fn(),
	findServerById: vi.fn(),
	cancelDockerCleanup: vi.fn(),
	checkGPUStatus: vi.fn(),
	cleanAllDeploymentQueue: vi.fn(),
	cleanupBuilders: vi.fn(),
	cleanupContainers: vi.fn(),
	cleanupImages: vi.fn(),
	cleanupSystem: vi.fn(),
	cleanupVolumes: vi.fn(),
	getDockerResourceType: vi.fn(),
	readConfig: vi.fn(),
	readMainConfig: vi.fn(),
	recreateDirectory: vi.fn(),
	reloadDockerResource: vi.fn(),
	runBackgroundJob: vi.fn(),
	setupGPUSupport: vi.fn(),
	stopLogCleanup: vi.fn(),
	updateLetsEncryptEmail: vi.fn(),
	updateResponseCompression: vi.fn(),
	updateServerTraefik: vi.fn(),
	updateWebServerSettings: vi.fn(),
	writeConfig: vi.fn(),
	writeMainConfig: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	paths: () => ({ MONITORING_PATH: "/monitoring" }),
	scheduleDockerCleanup: vi.fn(),
	WEB_SERVER_CLEANUP_JOB: "web-server-cleanup",
	...mocks,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/api/utils/cancel-audit", () => ({
	auditCancel: vi.fn(async () => undefined),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: mocks.cleanAllDeploymentQueue,
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
		"reloadServer",
		(c) => c.reloadServer(),
		() => mocks.reloadDockerResource,
		false,
	],
	[
		"updateServer",
		(c) => c.updateServer(),
		() => mocks.getDockerResourceType,
		false,
	],
	[
		"cleanAllDeploymentQueue",
		(c) => c.cleanAllDeploymentQueue(),
		() => mocks.cleanAllDeploymentQueue,
		false,
	],
	[
		"cleanUnusedImages",
		(c, serverId) => c.cleanUnusedImages({ serverId }),
		() => mocks.cleanupImages,
		true,
	],
	[
		"cleanUnusedVolumes",
		(c, serverId) => c.cleanUnusedVolumes({ serverId }),
		() => mocks.cleanupVolumes,
		true,
	],
	[
		"cleanStoppedContainers",
		(c, serverId) => c.cleanStoppedContainers({ serverId }),
		() => mocks.cleanupContainers,
		true,
	],
	[
		"cleanDockerBuilder",
		(c, serverId) => c.cleanDockerBuilder({ serverId }),
		() => mocks.cleanupBuilders,
		true,
	],
	[
		"cleanDockerPrune",
		(c, serverId) => c.cleanDockerPrune({ serverId }),
		() => mocks.cleanupSystem,
		true,
	],
	[
		"cleanAll",
		(c, serverId) => c.cleanAll({ serverId }),
		() => mocks.runBackgroundJob,
		true,
	],
	[
		"cleanMonitoring",
		(c) => c.cleanMonitoring(),
		() => mocks.recreateDirectory,
		false,
	],
	[
		"assignDomainServer",
		(c) =>
			c.assignDomainServer({
				host: "dokploy.example.com",
				certificateType: "none",
				https: false,
			}),
		() => mocks.updateWebServerSettings,
		false,
	],
	[
		"updateDockerCleanup",
		(c) => c.updateDockerCleanup({ enableDockerCleanup: false }),
		() => mocks.updateWebServerSettings,
		false,
	],
	[
		"updateServerIp",
		(c) => c.updateServerIp({ serverIp: "203.0.113.7" }),
		() => mocks.updateWebServerSettings,
		false,
	],
	[
		"toggleRequests",
		(c) => c.toggleRequests({ enable: true }),
		() => mocks.writeMainConfig,
		false,
	],
	[
		"toggleResponseCompression",
		(c) => c.toggleResponseCompression({ enable: true }),
		() => mocks.updateResponseCompression,
		false,
	],
	[
		"updateLogCleanup",
		(c) => c.updateLogCleanup({ cronExpression: null }),
		() => mocks.stopLogCleanup,
		false,
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
	[
		"setupGPU",
		(c, serverId) => c.setupGPU({ serverId }),
		() => mocks.setupGPUSupport,
		true,
	],
	[
		"checkGPUStatus",
		(c, serverId) => c.checkGPUStatus({ serverId }),
		() => mocks.checkGPUStatus,
		true,
	],
];

// updateServer stops at "not a service" once the guard has let it through.
const settle = (run: Promise<unknown>) =>
	run.then(
		() => null,
		(e) => e,
	);

describe("the local host belongs to the organization that owns the instance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isRootOrganization.mockImplementation(
			async (organizationId: string) => organizationId === ROOT,
		);
		mocks.findServerById.mockResolvedValue({
			serverId: "server-a",
			organizationId: OTHER,
		});
		mocks.getDockerResourceType.mockResolvedValue("unknown");
		mocks.readMainConfig.mockReturnValue("a: 1");
		mocks.readConfig.mockReturnValue("a: 1");
		mocks.updateWebServerSettings.mockResolvedValue({
			enableDockerCleanup: false,
		});
		mocks.runBackgroundJob.mockReturnValue(undefined);
		mocks.stopLogCleanup.mockResolvedValue(true);
		mocks.checkGPUStatus.mockResolvedValue({});
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
