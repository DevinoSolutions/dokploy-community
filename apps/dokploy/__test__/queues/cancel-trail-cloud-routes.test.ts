import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cancel routes the other trail tests do not reach: clearing a service's
 * deployments and the Cloud-only cancelDeployment, for applications and
 * compose stacks. Each writes to the fork's own cancel trail with the caller.
 */

const mocks = vi.hoisted(() => ({
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	clearOldDeployments: vi.fn(),
	updateApplicationStatus: vi.fn(),
	updateCompose: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	cancelDeployment: vi.fn(),
	audit: vi.fn(),
	auditCancel: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: true,
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
	clearOldDeployments: mocks.clearOldDeployments,
	updateApplicationStatus: mocks.updateApplicationStatus,
	updateCompose: mocks.updateCompose,
	updateDeploymentStatus: mocks.updateDeploymentStatus,
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

vi.mock("@/server/utils/deploy", () => ({
	cancelDeployment: mocks.cancelDeployment,
	deploy: vi.fn(),
}));

vi.mock("@/server/api/utils/cancel-audit", () => ({
	auditCancel: mocks.auditCancel,
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: vi.fn() },
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
	session: expect.objectContaining({
		activeOrganizationId: "org-1",
		apiKeyId: "key-1",
	}),
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findApplicationById.mockResolvedValue({
		applicationId: "a1",
		appName: "app-abc123",
		serverId: "srv-1",
		deployments: [{ deploymentId: "dep-1" }],
	});
	mocks.findComposeById.mockResolvedValue({
		composeId: "c1",
		name: "stack",
		appName: "stack-xyz789",
		serverId: "srv-1",
		deployments: [{ deploymentId: "dep-2" }],
	});
});

describe("clearDeployments", () => {
	it("records the caller for an application", async () => {
		await applicationCaller.clearDeployments({ applicationId: "a1" });

		expect(mocks.clearOldDeployments).toHaveBeenCalledWith("a1", "application");
		expect(mocks.auditCancel).toHaveBeenCalledTimes(1);
		expect(mocks.auditCancel).toHaveBeenCalledWith(caller, {
			action: "clear_deployments",
			targetType: "application",
			targetId: "a1",
			targetName: "app-abc123",
			applicationId: "a1",
		});
		expect(mocks.audit).toHaveBeenCalledTimes(1);
	});

	it("records the caller for a compose stack", async () => {
		await composeCaller.clearDeployments({ composeId: "c1" });

		expect(mocks.clearOldDeployments).toHaveBeenCalledWith("c1", "compose");
		expect(mocks.auditCancel).toHaveBeenCalledWith(caller, {
			action: "clear_deployments",
			targetType: "compose",
			targetId: "c1",
			targetName: "stack-xyz789",
			composeId: "c1",
		});
		expect(mocks.audit).toHaveBeenCalledTimes(1);
	});
});

describe("cancelDeployment on Cloud", () => {
	it("records the caller for an application", async () => {
		await applicationCaller.cancelDeployment({ applicationId: "a1" });

		expect(mocks.cancelDeployment).toHaveBeenCalledTimes(1);
		expect(mocks.auditCancel).toHaveBeenCalledTimes(1);
		expect(mocks.auditCancel).toHaveBeenCalledWith(caller, {
			action: "cancel_deployment",
			targetType: "application",
			targetId: "a1",
			targetName: "app-abc123",
			applicationId: "a1",
		});
		expect(mocks.audit).toHaveBeenCalledTimes(1);
	});

	it("records the caller for a compose stack", async () => {
		await composeCaller.cancelDeployment({ composeId: "c1" });

		expect(mocks.cancelDeployment).toHaveBeenCalledTimes(1);
		expect(mocks.auditCancel).toHaveBeenCalledWith(caller, {
			action: "cancel_deployment",
			targetType: "compose",
			targetId: "c1",
			targetName: "stack-xyz789",
			composeId: "c1",
		});
		expect(mocks.audit).toHaveBeenCalledTimes(1);
	});

	it("records nothing when the cancel itself failed", async () => {
		mocks.cancelDeployment.mockRejectedValue(new Error("queue down"));

		await expect(
			applicationCaller.cancelDeployment({ applicationId: "a1" }),
		).rejects.toThrow();
		await expect(
			composeCaller.cancelDeployment({ composeId: "c1" }),
		).rejects.toThrow();

		expect(mocks.auditCancel).not.toHaveBeenCalled();
	});
});
