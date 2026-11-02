import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * application.deploy / redeploy and compose.deploy / redeploy with a deploymentId: the id is checked when the call is
 * made. A wrong id is a 400 and nothing is queued; a right id travels in the queued job, so the deploy continues the
 * registered row.
 */

const mocks = vi.hoisted(() => ({
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	assertLiveBuildReference: vi.fn(),
	audit: vi.fn(),
	add: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));
vi.mock("@/server/utils/deploy", () => ({ deploy: vi.fn() }));
vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
	assertLiveBuildReference: mocks.assertLiveBuildReference,
	buildPolicyDeployGate: async () => ({ deploy: true, coalesced: 0 }),
}));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@/server/api/utils/cancel-audit", () => ({ auditCancel: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));
vi.mock("@/server/queues/queueSetup", () => ({
	cleanQueuesByCompose: vi.fn(),
	cleanQueuesByApplication: vi.fn(),
	killDockerBuild: vi.fn(),
	myQueue: { add: mocks.add, getJobs: vi.fn(), prioritize: vi.fn() },
}));

const ctx = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "ops@example.com", role: "admin" },
};

const { applicationRouter } = await import("@/server/api/routers/application");
const { composeRouter } = await import("@/server/api/routers/compose");

const applicationCaller = applicationRouter.createCaller(
	ctx as Parameters<typeof applicationRouter.createCaller>[0],
);
const composeCaller = composeRouter.createCaller(
	ctx as Parameters<typeof composeRouter.createCaller>[0],
);

const refused = new TRPCError({
	code: "BAD_REQUEST",
	message: "deploymentId dep-9 does not exist.",
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	mocks.checkPermission.mockResolvedValue(undefined);
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.assertLiveBuildReference.mockResolvedValue(undefined);
	mocks.findApplicationById.mockResolvedValue({
		applicationId: "a1",
		appName: "app-1",
		serverId: null,
		sourceType: "docker",
	});
	mocks.findComposeById.mockResolvedValue({
		composeId: "c1",
		name: "stack",
		appName: "stack-1",
		serverId: null,
		sourceType: "raw",
	});
	mocks.add.mockResolvedValue({ id: "job-1" });
});

describe("application deploys that name a registered deployment", () => {
	it.each(["deploy", "redeploy"] as const)(
		"%s checks the id against this application and queues it in the job",
		async (method) => {
			await applicationCaller[method]({
				applicationId: "a1",
				deploymentId: "dep-1",
				buildOrigin: "github-actions",
				buildRunUrl: "https://github.com/acme/web/actions/runs/42",
			});
			expect(mocks.assertLiveBuildReference).toHaveBeenCalledWith({
				deploymentId: "dep-1",
				kind: "application",
				serviceId: "a1",
			});
			const queued = mocks.add.mock.calls.at(-1)?.[1];
			expect(queued).toMatchObject({ applicationId: "a1", deploymentId: "dep-1" });
		},
	);

	it.each(["deploy", "redeploy"] as const)(
		"%s refuses a wrong id with the 400 and queues nothing",
		async (method) => {
			mocks.assertLiveBuildReference.mockRejectedValue(refused);
			await expect(
				applicationCaller[method]({
					applicationId: "a1",
					deploymentId: "dep-9",
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.add).not.toHaveBeenCalled();
		},
	);

	it.each(["deploy", "redeploy"] as const)(
		"%s without an id does not look anything up",
		async (method) => {
			await applicationCaller[method]({ applicationId: "a1" });
			expect(mocks.assertLiveBuildReference).not.toHaveBeenCalled();
			expect(mocks.add.mock.calls.at(-1)?.[1]).not.toHaveProperty(
				"deploymentId",
				expect.anything(),
			);
		},
	);
});

describe("compose deploys that name a registered deployment", () => {
	it.each(["deploy", "redeploy"] as const)(
		"%s checks the id against this compose and queues it in the job",
		async (method) => {
			await composeCaller[method]({
				composeId: "c1",
				deploymentId: "dep-1",
			});
			expect(mocks.assertLiveBuildReference).toHaveBeenCalledWith({
				deploymentId: "dep-1",
				kind: "compose",
				serviceId: "c1",
			});
			const queued = mocks.add.mock.calls.at(-1)?.[1];
			expect(queued).toMatchObject({ composeId: "c1", deploymentId: "dep-1" });
		},
	);

	it.each(["deploy", "redeploy"] as const)(
		"%s refuses a wrong id with the 400 and queues nothing",
		async (method) => {
			mocks.assertLiveBuildReference.mockRejectedValue(refused);
			await expect(
				composeCaller[method]({ composeId: "c1", deploymentId: "dep-9" }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.add).not.toHaveBeenCalled();
		},
	);
});
