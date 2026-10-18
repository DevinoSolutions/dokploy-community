import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deployments of a dokploy-server schedule have no service or server either.
 * Reading their log, killing the process and removing them has to be limited to
 * the owners and admins of the schedule's organization.
 */

const mocks = vi.hoisted(() => ({
	memberRole: "admin" as string,
	deployment: null as Record<string, unknown> | null,
	execAsync: vi.fn(),
	removeDeployment: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: new Proxy(
			{},
			{
				get: (_target, table) =>
					table === "member"
						? {
								findFirst: vi.fn(async () => ({
									id: "member-1",
									userId: "user-1",
									organizationId: "org-1",
									role: mocks.memberRole,
									accessedServices: [],
									accessedProjects: [],
									accessedEnvironments: [],
									user: { id: "user-1" },
								})),
							}
						: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
			},
		),
		execute: vi.fn(async () => []),
	},
	dbUrl: "postgres://mock:mock@localhost:5432/mock",
}));

vi.mock("@dokploy/server/services/deployment", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findDeploymentById: vi.fn(async () => mocks.deployment),
	removeDeployment: mocks.removeDeployment,
	updateDeploymentStatus: vi.fn(),
}));

// Claiming a run as cancelled is a database update (see run-status.ts).
vi.mock("@dokploy/server/utils/schedules/run-status", async (importOriginal) => ({
	...(await importOriginal<object>()),
	claimScheduleRunCancel: vi.fn(async () => true),
	revertScheduleRunCancel: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<object>()),
	execAsync: mocks.execAsync,
}));

// The native binding is not needed to exercise the router.
vi.mock("bcrypt", () => ({ default: {}, hash: vi.fn(), compare: vi.fn() }));

vi.mock("@/server/api/utils/cancel-audit", () => ({ auditCancel: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { deploymentRouter } = await import("@/server/api/routers/deployment");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = () =>
	createCallerFactory(deploymentRouter)({
		user: { id: "user-1", email: "admin@test.com", role: "admin" },
		session: { activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

const deploymentOf = (organizationId: string | null) => ({
	deploymentId: "dep-1",
	applicationId: null,
	composeId: null,
	serverId: null,
	pid: "4242",
	status: "running",
	logPath: "",
	scheduleId: "sch-1",
	schedule: {
		scheduleType: "dokploy-server",
		serverId: null,
		organizationId,
	},
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.memberRole = "admin";
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.removeDeployment.mockResolvedValue(true);
});

describe("deployments of a dokploy-server schedule", () => {
	it.each([
		["another organization", "org-2"],
		["no organization", null],
	])("are off limits when the schedule belongs to %s", async (_label, organizationId) => {
		mocks.deployment = deploymentOf(organizationId);

		await expect(
			caller().killProcess({ deploymentId: "dep-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			caller().removeDeployment({ deploymentId: "dep-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			caller().readLogs({ deploymentId: "dep-1", tail: 10 }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.removeDeployment).not.toHaveBeenCalled();
	});

	it("are available to an admin of the owning organization", async () => {
		mocks.deployment = deploymentOf("org-1");

		await caller().removeDeployment({ deploymentId: "dep-1" });
		expect(mocks.removeDeployment).toHaveBeenCalledTimes(1);

		await caller().killProcess({ deploymentId: "dep-1" });
		expect(mocks.execAsync).toHaveBeenCalledWith("kill -9 4242");
	});

	it("are not available to a plain member", async () => {
		mocks.memberRole = "member";
		mocks.deployment = deploymentOf("org-1");

		await expect(
			caller().killProcess({ deploymentId: "dep-1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});
