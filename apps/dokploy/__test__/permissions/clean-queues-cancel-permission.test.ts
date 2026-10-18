import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Dropping queued deploys is a cancel action: `application.cleanQueues` and
 * `compose.cleanQueues` both need `deployment:cancel`, in both modes. A custom
 * role that can create deployments but not cancel them must not be able to
 * empty a queue, and one that can cancel but not create must be able to. The
 * real permission service runs here, only the database behind it is faked.
 */

const mocks = vi.hoisted(() => ({
	role: "owner" as string,
	accessedServices: [] as string[],
	customRolePermission: "{}",
	licensed: true,
	serviceOrganizationId: "org-1",
	cleanQueuesByApplication: vi.fn(async () => 2),
	cleanQueuesByCompose: vi.fn(async () => 2),
	keepOldestQueuesByApplication: vi.fn(),
	keepOldestQueuesByCompose: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		execute: vi.fn(async () => [
			{ organizationId: mocks.serviceOrganizationId },
		]),
		query: {
			member: {
				findFirst: vi.fn(async () => ({
					id: "member-1",
					role: mocks.role,
					userId: "user-1",
					organizationId: "org-1",
					accessedProjects: [] as string[],
					accessedServices: mocks.accessedServices,
					accessedEnvironments: [] as string[],
					canCreateProjects: false,
					canDeleteProjects: false,
					canCreateServices: false,
					canDeleteServices: false,
					canCreateEnvironments: false,
					canDeleteEnvironments: false,
					canAccessToTraefikFiles: false,
					canAccessToDocker: false,
					canAccessToAPI: false,
					canAccessToSSHKeys: false,
					canAccessToGitProviders: false,
					user: { id: "user-1", email: "user@example.com" },
				})),
				findMany: vi.fn(async () => []),
			},
			organizationRole: {
				findFirst: vi.fn(),
				findMany: vi.fn(async () => [
					{ permission: mocks.customRolePermission },
				]),
			},
		},
	},
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(async () => mocks.licensed),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: vi.fn(async () => ({
		applicationId: "a1",
		appName: "app-abc123",
	})),
	findComposeById: vi.fn(async () => ({
		composeId: "c1",
		appName: "stack-abc123",
		name: "stack",
	})),
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

vi.mock("@/server/api/utils/cancel-audit", () => ({ auditCancel: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanQueuesByApplication: mocks.cleanQueuesByApplication,
	cleanQueuesByCompose: mocks.cleanQueuesByCompose,
	keepOldestQueuesByApplication: mocks.keepOldestQueuesByApplication,
	keepOldestQueuesByCompose: mocks.keepOldestQueuesByCompose,
	killDockerBuild: vi.fn(),
	myQueue: { add: vi.fn() },
}));

const ctx = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
};

const { composeRouter } = await import("@/server/api/routers/compose");
const { applicationRouter } = await import("@/server/api/routers/application");

const composeCaller = composeRouter.createCaller(
	ctx as Parameters<typeof composeRouter.createCaller>[0],
);
const applicationCaller = applicationRouter.createCaller(
	ctx as Parameters<typeof applicationRouter.createCaller>[0],
);

const emptyKeepOldest = { kept: [], removed: [] };

const asCustomRole = (deployment: string[]) => {
	mocks.role = "release-manager";
	mocks.accessedServices = ["a1", "c1"];
	mocks.customRolePermission = JSON.stringify({ deployment });
};

const targets = [
	{
		name: "compose.cleanQueues",
		clean: (mode?: "all" | "keepOldest") =>
			composeCaller.cleanQueues({ composeId: "c1", mode }),
		queueCalls: () =>
			mocks.cleanQueuesByCompose.mock.calls.length +
			mocks.keepOldestQueuesByCompose.mock.calls.length,
	},
	{
		name: "application.cleanQueues",
		clean: (mode?: "all" | "keepOldest") =>
			applicationCaller.cleanQueues({ applicationId: "a1", mode }),
		queueCalls: () =>
			mocks.cleanQueuesByApplication.mock.calls.length +
			mocks.keepOldestQueuesByApplication.mock.calls.length,
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.role = "owner";
	mocks.accessedServices = [];
	mocks.customRolePermission = "{}";
	mocks.licensed = true;
	mocks.serviceOrganizationId = "org-1";
	mocks.cleanQueuesByApplication.mockResolvedValue(2);
	mocks.cleanQueuesByCompose.mockResolvedValue(2);
	mocks.keepOldestQueuesByApplication.mockResolvedValue(emptyKeepOldest);
	mocks.keepOldestQueuesByCompose.mockResolvedValue(emptyKeepOldest);
});

describe.each(targets)("$name permission", ({ clean, queueCalls }) => {
	for (const mode of [undefined, "all", "keepOldest"] as const) {
		const label = mode ?? "default";

		it(`lets a role with deployment:cancel and no create clean the queue (${label} mode)`, async () => {
			asCustomRole(["read", "cancel"]);

			await expect(clean(mode)).resolves.not.toThrow();
			expect(queueCalls()).toBe(1);
		});

		it(`refuses a role with deployment:create and no cancel (${label} mode)`, async () => {
			asCustomRole(["read", "create"]);

			await expect(clean(mode)).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
			expect(queueCalls()).toBe(0);
		});
	}

	it.each(["owner", "admin", "member"])(
		"still lets the %s role clean the queue",
		async (role) => {
			mocks.role = role;
			mocks.accessedServices = ["a1", "c1"];

			await expect(clean()).resolves.not.toThrow();
			expect(queueCalls()).toBe(1);
		},
	);

	it("keeps the service access check: a cancel-only role is refused on a service it was not given", async () => {
		asCustomRole(["read", "cancel"]);
		mocks.accessedServices = ["another-service"];

		await expect(clean()).rejects.toThrow(
			"You don't have access to this service",
		);
		expect(queueCalls()).toBe(0);
	});

	it("keeps the organization check for an owner", async () => {
		mocks.role = "owner";
		mocks.serviceOrganizationId = "org-2";

		await expect(clean()).rejects.toThrow(
			"You are not authorized to access this service or it does not exist",
		);
		expect(queueCalls()).toBe(0);
	});
});
