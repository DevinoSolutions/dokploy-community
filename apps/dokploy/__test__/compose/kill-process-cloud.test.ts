import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * On Dokploy Cloud there is no local host to kill a pid on: a deployment that
 * resolves to no remote server must be refused, not run on the cloud host.
 */

const mocks = vi.hoisted(() => ({
	findDeploymentById: vi.fn(),
	cancelBuildServerDeploymentById: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: true,
	findDeploymentById: mocks.findDeploymentById,
	cancelBuildServerDeploymentById: mocks.cancelBuildServerDeploymentById,
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	updateDeploymentStatus: mocks.updateDeploymentStatus,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/cancel-audit", () => ({ auditCancel: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: vi.fn() },
}));

const ctx = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
};

const { deploymentRouter } = await import("@/server/api/routers/deployment");
const deploymentCaller = deploymentRouter.createCaller(
	ctx as Parameters<typeof deploymentRouter.createCaller>[0],
);

const deployment = (extra = {}) => ({
	deploymentId: "dep-1",
	applicationId: "a1",
	composeId: null,
	pid: "4242",
	status: "running",
	schedule: null,
	...extra,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.cancelBuildServerDeploymentById.mockResolvedValue(null);
});

describe("deployment.killProcess on cloud", () => {
	it("refuses a deployment with no server instead of killing on the cloud host", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment());

		await expect(
			deploymentCaller.killProcess({ deploymentId: "dep-1" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
	});

	it("still kills on the remote server when one resolves", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({ application: { serverId: "srv-1" } }),
		);

		await deploymentCaller.killProcess({ deploymentId: "dep-1" });

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith("srv-1", "kill -9 4242");
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});
