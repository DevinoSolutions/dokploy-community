import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * deployment.registerExternalBuild / finishExternalBuild: the deployment:create permission on the service is
 * checked before anything is registered or ended, the same run registers once, and the audit trail only records
 * what changed.
 */

const mocks = vi.hoisted(() => ({
	checkServicePermissionAndAccess: vi.fn(),
	registerExternalBuild: vi.fn(),
	finishExternalBuild: vi.fn(),
	findDeploymentById: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	checkPermission: vi.fn(),
	findMemberByUserId: vi.fn(),
	findDeployableServiceOrganizations: vi.fn(),
}));
vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	registerExternalBuild: mocks.registerExternalBuild,
	finishExternalBuild: mocks.finishExternalBuild,
	findDeploymentById: mocks.findDeploymentById,
}));
vi.mock("@dokploy/server/db", () => ({ db: {} }));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@dokploy/server/services/deployment-access", () => ({
	assertDeploymentAccess: vi.fn(),
}));
vi.mock("@dokploy/server/services/deployment-log-host", () => ({
	LOG_UNAVAILABLE_MESSAGE: "",
	locateDeploymentLog: vi.fn(),
}));
vi.mock("@dokploy/server/services/server", () => ({ findServerById: vi.fn() }));
vi.mock("@/server/utils/deploy", () => ({
	fetchDeployApiJobs: vi.fn(),
	deploy: vi.fn(),
	cancelDeployment: vi.fn(),
}));
vi.mock("@/server/api/utils/cancel-audit", () => ({ auditCancel: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));
vi.mock("@/server/api/utils/deploy-priority", () => ({
	assertCanPrioritize: vi.fn(),
	recordPriorityUse: vi.fn(),
}));
vi.mock("@/server/api/utils/local-host-access", () => ({
	assertLocalHostAccess: vi.fn(),
}));
vi.mock("@/server/utils/deployment-all-by-type-target", () => ({
	resolveDeploymentAllByTypeAuthTarget: vi.fn(),
}));
vi.mock("@/server/queues/queueSetup", () => ({ myQueue: { add: vi.fn() } }));

const ctx = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "member@example.com", role: "member" },
};

const { deploymentRouter } = await import("@/server/api/routers/deployment");
const caller = deploymentRouter.createCaller(
	ctx as Parameters<typeof deploymentRouter.createCaller>[0],
);

const RUN = "https://github.com/acme/web/actions/runs/42";
const registration = (overrides: Record<string, unknown> = {}) => ({
	applicationId: "app-1",
	buildOrigin: "github-actions" as const,
	buildRunUrl: RUN,
	buildRunId: "42",
	buildRepository: "acme/web",
	buildCommitSha: "abcdef0123456789",
	title: "GHA production abcdef01: ship it",
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.registerExternalBuild.mockResolvedValue({
		deploymentId: "dep-1",
		created: true,
	});
});

describe("deployment.registerExternalBuild", () => {
	it("needs deployment:create on the service, and registers nothing without it", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("UNAUTHORIZED"),
		);

		await expect(caller.registerExternalBuild(registration())).rejects.toThrow(
			"UNAUTHORIZED",
		);

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"app-1",
			{ deployment: ["create"] },
		);
		expect(mocks.registerExternalBuild).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("checks a compose against the compose id", async () => {
		await caller.registerExternalBuild(
			registration({ applicationId: undefined, composeId: "c1" }),
		);
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"c1",
			{ deployment: ["create"] },
		);
	});

	it("registers once and audits it; the same run again returns the same row without an audit entry", async () => {
		const first = await caller.registerExternalBuild(registration());
		expect(first).toEqual({ deploymentId: "dep-1", created: true });
		expect(mocks.audit).toHaveBeenCalledTimes(1);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "deploy",
				resourceType: "application",
				resourceId: "app-1",
				metadata: expect.objectContaining({
					type: "registerExternalBuild",
					deploymentId: "dep-1",
				}),
			}),
		);

		mocks.registerExternalBuild.mockResolvedValue({
			deploymentId: "dep-1",
			created: false,
		});
		const again = await caller.registerExternalBuild(registration());
		expect(again).toEqual({ deploymentId: "dep-1", created: false });
		expect(mocks.audit).toHaveBeenCalledTimes(1);
	});

	it("refuses an input with both ids or neither before any permission check", async () => {
		await expect(
			caller.registerExternalBuild(registration({ composeId: "c1" })),
		).rejects.toThrow(/either applicationId or composeId/);
		await expect(
			caller.registerExternalBuild(registration({ applicationId: undefined })),
		).rejects.toThrow(/either applicationId or composeId/);
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		expect(mocks.registerExternalBuild).not.toHaveBeenCalled();
	});

	it("only takes github-actions as the origin", async () => {
		await expect(
			caller.registerExternalBuild(
				registration({ buildOrigin: "external" as never }),
			),
		).rejects.toThrow();
		expect(mocks.registerExternalBuild).not.toHaveBeenCalled();
	});
});

describe("deployment.finishExternalBuild", () => {
	const row = {
		deploymentId: "dep-1",
		applicationId: "app-1",
		composeId: null,
		title: "GHA production abcdef01",
		application: { appName: "web-abc123" },
		compose: null,
	};

	beforeEach(() => {
		mocks.findDeploymentById.mockResolvedValue(row);
		mocks.finishExternalBuild.mockResolvedValue({
			updated: true,
			status: "error",
		});
	});

	it("needs deployment:create on the deployment's service, and ends nothing without it", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("UNAUTHORIZED"),
		);

		await expect(
			caller.finishExternalBuild({
				deploymentId: "dep-1",
				conclusion: "failure",
			}),
		).rejects.toThrow("UNAUTHORIZED");

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"app-1",
			{ deployment: ["create"] },
		);
		expect(mocks.finishExternalBuild).not.toHaveBeenCalled();
	});

	it("ends the row, says what happened and audits it", async () => {
		const result = await caller.finishExternalBuild({
			deploymentId: "dep-1",
			conclusion: "failure",
			message: "tests are red",
		});

		expect(mocks.finishExternalBuild).toHaveBeenCalledWith(row, {
			conclusion: "failure",
			message: "tests are red",
		});
		expect(result).toEqual({
			deploymentId: "dep-1",
			updated: true,
			status: "error",
		});
		expect(mocks.audit).toHaveBeenCalledTimes(1);
	});

	it("does not audit a row that was left as it was", async () => {
		mocks.finishExternalBuild.mockResolvedValue({
			updated: false,
			status: null,
		});
		const result = await caller.finishExternalBuild({
			deploymentId: "dep-1",
			conclusion: "cancelled",
		});
		expect(result).toMatchObject({ updated: false, status: null });
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("refuses a deployment that belongs to no application or compose", async () => {
		mocks.findDeploymentById.mockResolvedValue({
			...row,
			applicationId: null,
			composeId: null,
		});
		await expect(
			caller.finishExternalBuild({
				deploymentId: "dep-1",
				conclusion: "failure",
			}),
		).rejects.toThrow(/application or compose/);
		expect(mocks.finishExternalBuild).not.toHaveBeenCalled();
	});

	it("takes only failure, cancelled and skipped as a conclusion", async () => {
		await expect(
			caller.finishExternalBuild({
				deploymentId: "dep-1",
				conclusion: "success" as never,
			}),
		).rejects.toThrow();
		expect(mocks.findDeploymentById).not.toHaveBeenCalled();
	});
});
