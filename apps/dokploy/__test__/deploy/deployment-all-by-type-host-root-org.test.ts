import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The runs of a dokploy-server schedule are listed through
 * deployment.allByType with the schedule's organization as the target. The
 * schedule belongs to the organization that owns the instance, so an admin of
 * another organization is refused even for their own organization's rows.
 */

const mocks = vi.hoisted(() => ({
	rootOrganization: "org-1",
	findMany: vi.fn(),
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
									organizationId: "org-2",
									role: "admin",
									accessedServices: [],
									accessedProjects: [],
									accessedEnvironments: [],
									user: { id: "user-1" },
								})),
							}
						: { findFirst: vi.fn(), findMany: mocks.findMany },
			},
		),
	},
	dbUrl: "postgres://mock:mock@localhost:5432/mock",
}));

vi.mock("@/server/utils/deployment-all-by-type-target", () => ({
	resolveDeploymentAllByTypeAuthTarget: vi.fn(async () => ({
		kind: "organization",
		organizationId: "org-2",
	})),
}));

vi.mock("@dokploy/server/services/admin", async (importOriginal) => ({
	...(await importOriginal<object>()),
	isRootOrganization: async (organizationId: string) =>
		organizationId === mocks.rootOrganization,
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
		user: { id: "user-1", email: "admin@test.com", role: "admin" },
		session: { activeOrganizationId: "org-2" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.rootOrganization = "org-1";
	mocks.findMany.mockResolvedValue([]);
});

describe("deployment.allByType for a dokploy-server schedule", () => {
	it("refuses an admin of an organization that does not own the instance", async () => {
		await expect(
			caller().allByType({ id: "sch-1", type: "schedule" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.findMany).not.toHaveBeenCalled();
	});

	it("lists the runs for the organization that owns the instance", async () => {
		mocks.rootOrganization = "org-2";
		await expect(
			caller().allByType({ id: "sch-1", type: "schedule" }),
		).resolves.toEqual([]);
		expect(mocks.findMany).toHaveBeenCalledTimes(1);
	});
});
