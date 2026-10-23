import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server deployment history is limited to the servers the caller can reach
 * (`getAccessibleServerIds`), not just the servers of the active organization:
 * a member restricted to some servers must not read the others' history.
 * Ported from upstream Dokploy/dokploy#5752.
 */

const mocks = vi.hoisted(() => ({
	accessibleServerIds: new Set<string>(),
	findAllDeploymentsByServerId: vi.fn(),
	findScheduleById: vi.fn(),
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
									role: "admin",
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

vi.mock("@dokploy/server/services/server", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getAccessibleServerIds: vi.fn(async () => mocks.accessibleServerIds),
}));

vi.mock("@dokploy/server/services/deployment", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findAllDeploymentsByServerId: mocks.findAllDeploymentsByServerId,
}));

vi.mock("@dokploy/server/services/schedule", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findScheduleById: mocks.findScheduleById,
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
		session: { userId: "user-1", activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.accessibleServerIds = new Set(["server-a"]);
	mocks.findAllDeploymentsByServerId.mockResolvedValue([]);
});

describe("server deployment history is limited to accessible servers", () => {
	it("allByServer rejects a server outside the accessible set", async () => {
		await expect(
			caller().allByServer({ serverId: "server-b" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.findAllDeploymentsByServerId).not.toHaveBeenCalled();
	});

	it("allByServer serves an accessible server", async () => {
		await caller().allByServer({ serverId: "server-a" });
		expect(mocks.findAllDeploymentsByServerId).toHaveBeenCalledWith("server-a");
	});

	it("allByType with type=server rejects a server outside the accessible set", async () => {
		await expect(
			caller().allByType({ id: "server-b", type: "server" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("allByType with type=server serves an accessible server", async () => {
		await expect(
			caller().allByType({ id: "server-a", type: "server" }),
		).resolves.toEqual([]);
	});

	it("allByType for a server schedule rejects a server outside the accessible set", async () => {
		mocks.findScheduleById.mockResolvedValue({
			scheduleId: "sch-1",
			applicationId: null,
			composeId: null,
			serverId: "server-b",
			scheduleType: "server",
			organizationId: "org-1",
		});
		await expect(
			caller().allByType({ id: "sch-1", type: "schedule" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
