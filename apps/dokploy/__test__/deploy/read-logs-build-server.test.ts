import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An application built on a build server writes its deployment log on the
 * build server, not on the host that runs it. deployment.readLogs has to tail
 * the file there, like the log drawer does.
 */

const mocks = vi.hoisted(() => ({
	deployment: null as Record<string, unknown> | null,
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: new Proxy({}, { get: () => ({ findFirst: vi.fn() }) }) },
	dbUrl: "postgres://mock:mock@localhost:5432/mock",
}));

vi.mock("@dokploy/server/services/deployment", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findDeploymentById: vi.fn(async () => mocks.deployment),
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<object>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/services/preview-deployment", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findPreviewDeploymentById: vi.fn(async () => ({
		previewDeploymentId: "preview-1",
		applicationId: "app-1",
		composeId: null,
	})),
}));

vi.mock("@dokploy/server/services/server", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findServerById: vi.fn(async (serverId: string) => ({
		serverId,
		organizationId: "org-1",
	})),
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => ({
	...(await importOriginal<object>()),
	checkServicePermissionAndAccess: vi.fn(async () => {}),
}));

// The native binding is not needed to exercise the router.
vi.mock("bcrypt", () => ({ default: {}, hash: vi.fn(), compare: vi.fn() }));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { deploymentRouter } = await import("@/server/api/routers/deployment");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = () =>
	createCallerFactory(deploymentRouter)({
		user: { id: "user-1", email: "owner@test.com", role: "owner" },
		session: { activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

const logPath = "/etc/dokploy/logs/web/web-2026-10-12:12:00:00.log";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "built\n", stderr: "" });
	mocks.execAsync.mockResolvedValue({ stdout: "local\n", stderr: "" });
});

describe("deployment.readLogs on a build server", () => {
	it("reads a local application's log from its build server", async () => {
		mocks.deployment = {
			deploymentId: "dep-1",
			applicationId: "app-1",
			logPath,
			serverId: null,
			buildServerId: "build-1",
			application: { applicationId: "app-1", serverId: null },
		};

		const out = await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(out).toBe("built\n");
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("build-1");
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("prefers the build server over the remote server that runs the app", async () => {
		mocks.deployment = {
			deploymentId: "dep-1",
			applicationId: "app-1",
			logPath,
			serverId: "server-1",
			buildServerId: "build-1",
			application: { applicationId: "app-1", serverId: "server-1" },
		};

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("build-1");
	});

	it("reads a preview deployment's log from the build server it was built on", async () => {
		mocks.deployment = {
			deploymentId: "dep-1",
			previewDeploymentId: "preview-1",
			logPath,
			serverId: "server-1",
			buildServerId: "build-1",
			application: null,
		};

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("build-1");
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("still reads from the running host when there is no build server", async () => {
		mocks.deployment = {
			deploymentId: "dep-1",
			applicationId: "app-1",
			logPath,
			serverId: "server-1",
			buildServerId: null,
			application: { applicationId: "app-1", serverId: "server-1" },
		};

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("server-1");
	});

	it("still reads a local application's log locally", async () => {
		mocks.deployment = {
			deploymentId: "dep-1",
			applicationId: "app-1",
			logPath,
			serverId: null,
			buildServerId: null,
			application: { applicationId: "app-1", serverId: null },
		};

		const out = await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(out).toBe("local\n");
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});
