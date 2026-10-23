import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * application.cancelDeployment / compose.cancelDeployment on a self-hosted
 * instance (they were Cloud-only): the deployment:cancel permission is still
 * checked first, the running deployment is stopped, and the cancel trail and
 * the audit log are written.
 */

const mocks = vi.hoisted(() => ({
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	auditCancel: vi.fn(),
	audit: vi.fn(),
	listRunning: vi.fn(),
	activeJobs: vi.fn(),
	stop: vi.fn(),
	logHost: vi.fn(),
	appendLog: vi.fn(),
	cloudCancel: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

vi.mock("@/server/utils/deploy", () => ({
	cancelDeployment: mocks.cloudCancel,
	deploy: vi.fn(),
}));

vi.mock("@/server/api/utils/cancel-audit", () => ({
	auditCancel: mocks.auditCancel,
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: vi.fn() },
}));

vi.mock("@/server/queues/deployment-control", () => ({
	createDefaultCancelDeps: () => ({
		listRunning: mocks.listRunning,
		activeJobs: mocks.activeJobs,
		stop: mocks.stop,
		logHost: mocks.logHost,
		appendLog: mocks.appendLog,
		sleep: async () => {},
		waitMs: 0,
	}),
}));

const ctx = {
	session: { activeOrganizationId: "org-1", apiKeyId: "key-1" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
};

const { applicationRouter } = await import("@/server/api/routers/application");
const { composeRouter } = await import("@/server/api/routers/compose");

const applicationCaller = applicationRouter.createCaller(
	ctx as Parameters<typeof applicationRouter.createCaller>[0],
);
const composeCaller = composeRouter.createCaller(
	ctx as Parameters<typeof composeRouter.createCaller>[0],
);

const caller = expect.objectContaining({
	user: expect.objectContaining({ id: "user-1" }),
	session: expect.objectContaining({ activeOrganizationId: "org-1" }),
});

const runningRow = (overrides = {}) => ({
	deploymentId: "dep-1",
	title: "Deploy",
	logPath: "/logs/dep-1.log",
	pid: null,
	serverId: null,
	buildServerId: null,
	applicationId: "a1",
	composeId: null,
	previewDeploymentId: null,
	startedAt: null,
	createdAt: new Date().toISOString(),
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findApplicationById.mockResolvedValue({
		applicationId: "a1",
		appName: "app-abc123",
		name: "App",
		serverId: null,
		deployments: [],
	});
	mocks.findComposeById.mockResolvedValue({
		composeId: "c1",
		appName: "stack-xyz789",
		name: "Stack",
		serverId: null,
		deployments: [],
	});
	mocks.listRunning.mockResolvedValue([runningRow()]);
	mocks.activeJobs.mockResolvedValue([]);
	mocks.logHost.mockResolvedValue(null);
	mocks.stop.mockResolvedValue({
		method: "launcher",
		notRunning: false,
		claimedCancelled: true,
	});
});

describe("application.cancelDeployment (self-hosted)", () => {
	it("checks deployment:cancel, stops the running deployment and records the caller", async () => {
		const result = await applicationCaller.cancelDeployment({
			applicationId: "a1",
		});

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"a1",
			{ deployment: ["cancel"] },
		);
		expect(mocks.stop).toHaveBeenCalledTimes(1);
		expect(mocks.cloudCancel).not.toHaveBeenCalled();
		expect(result).toMatchObject({ success: true, slotFree: true });
		expect(mocks.auditCancel).toHaveBeenCalledWith(caller, {
			action: "cancel_deployment",
			targetType: "application",
			targetId: "a1",
			targetName: "app-abc123",
			applicationId: "a1",
			composeId: undefined,
			deploymentId: "dep-1",
		});
		expect(mocks.audit).toHaveBeenCalledWith(caller, {
			action: "cancel",
			resourceType: "application",
			resourceId: "a1",
			resourceName: "app-abc123",
		});
	});

	it("stops nothing when the permission check refuses", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("UNAUTHORIZED"),
		);

		await expect(
			applicationCaller.cancelDeployment({ applicationId: "a1" }),
		).rejects.toThrow("UNAUTHORIZED");

		expect(mocks.stop).not.toHaveBeenCalled();
		expect(mocks.auditCancel).not.toHaveBeenCalled();
	});

	it("refuses when no deployment is running", async () => {
		mocks.listRunning.mockResolvedValue([]);

		await expect(
			applicationCaller.cancelDeployment({ applicationId: "a1" }),
		).rejects.toThrow("No deployment is running for this service");

		expect(mocks.auditCancel).not.toHaveBeenCalled();
	});

	it("asks for a retry while the job has no deployment yet", async () => {
		mocks.listRunning.mockResolvedValue([]);
		mocks.activeJobs.mockResolvedValue([
			{
				id: "job-1",
				data: { applicationType: "application", applicationId: "a1" },
			},
		]);

		await expect(
			applicationCaller.cancelDeployment({ applicationId: "a1" }),
		).rejects.toThrow("still starting");
	});

	it("an audit failure does not hide that the deployment was stopped", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.audit.mockRejectedValue(new Error("audit down"));

		await expect(
			applicationCaller.cancelDeployment({ applicationId: "a1" }),
		).resolves.toMatchObject({ success: true });
	});

	it("fails with the reason when nothing could be signalled", async () => {
		mocks.stop.mockResolvedValue({
			method: "none",
			notRunning: false,
			claimedCancelled: false,
			warning: "no process handle",
		});

		await expect(
			applicationCaller.cancelDeployment({ applicationId: "a1" }),
		).rejects.toThrow("no process handle");
		expect(mocks.auditCancel).not.toHaveBeenCalled();
	});
});

describe("compose.cancelDeployment (self-hosted)", () => {
	it("stops the running compose deployment and records the caller", async () => {
		mocks.listRunning.mockResolvedValue([
			runningRow({
				deploymentId: "dep-c",
				applicationId: null,
				composeId: "c1",
			}),
		]);

		const result = await composeCaller.cancelDeployment({ composeId: "c1" });

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"c1",
			{ deployment: ["cancel"] },
		);
		expect(mocks.stop).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ success: true });
		expect(mocks.auditCancel).toHaveBeenCalledWith(caller, {
			action: "cancel_deployment",
			targetType: "compose",
			targetId: "c1",
			targetName: "stack-xyz789",
			applicationId: undefined,
			composeId: "c1",
			deploymentId: "dep-c",
		});
		expect(mocks.audit).toHaveBeenCalledWith(caller, {
			action: "cancel",
			resourceType: "compose",
			resourceId: "c1",
			resourceName: "Stack",
		});
	});

	it("stops nothing when the permission check refuses", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("UNAUTHORIZED"),
		);

		await expect(
			composeCaller.cancelDeployment({ composeId: "c1" }),
		).rejects.toThrow("UNAUTHORIZED");
		expect(mocks.stop).not.toHaveBeenCalled();
	});
});
