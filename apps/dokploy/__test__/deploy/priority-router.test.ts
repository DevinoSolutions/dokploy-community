import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The API side of the deploy queue priority lane: who may ask for it, what is
 * handed to the queue, what is audited and what the caller is told.
 */

const mocks = vi.hoisted(() => ({
	cloud: { value: false },
	cloudDeploy: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	audit: vi.fn(),
	add: vi.fn(),
	getJobs: vi.fn(),
	prioritize: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("@/server/utils/deploy", () => ({ deploy: mocks.cloudDeploy }));

vi.mock("@dokploy/server", () => ({
	get IS_CLOUD() {
		return mocks.cloud.value;
	},
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

vi.mock("@/server/api/utils/cancel-audit", () => ({ auditCancel: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanQueuesByCompose: vi.fn(),
	cleanQueuesByApplication: vi.fn(),
	killDockerBuild: vi.fn(),
	myQueue: {
		add: mocks.add,
		getJobs: mocks.getJobs,
		prioritize: mocks.prioritize,
	},
}));

const ctx = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "ops@example.com", role: "admin" },
};

const { applicationRouter } = await import("@/server/api/routers/application");
const { composeRouter } = await import("@/server/api/routers/compose");
const { deploymentRouter } = await import("@/server/api/routers/deployment");

const applicationCaller = applicationRouter.createCaller(
	ctx as Parameters<typeof applicationRouter.createCaller>[0],
);
const composeCaller = composeRouter.createCaller(
	ctx as Parameters<typeof composeRouter.createCaller>[0],
);
const deploymentCaller = deploymentRouter.createCaller(
	ctx as Parameters<typeof deploymentRouter.createCaller>[0],
);

const applied = { requested: true, applied: true, wentAheadOf: 3 };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.cloud.value = false;
	mocks.cloudDeploy.mockResolvedValue({});
	vi.spyOn(console, "log").mockImplementation(() => {});
	mocks.checkPermission.mockResolvedValue(undefined);
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findApplicationById.mockResolvedValue({
		applicationId: "a1",
		appName: "app-1",
		serverId: null,
		sourceType: "github",
	});
	mocks.findComposeById.mockResolvedValue({
		composeId: "c1",
		name: "stack",
		serverId: null,
	});
	mocks.add.mockResolvedValue({ id: "job-7", priority: applied });
});

const denyPriority = () =>
	mocks.checkPermission.mockImplementation(
		async (_ctx: unknown, permissions: Record<string, string[]>) => {
			if (permissions.deployment?.includes("priority")) {
				throw new Error("Unauthorized");
			}
		},
	);

describe("application.deploy and redeploy with priority", () => {
	it.each(["deploy", "redeploy"] as const)(
		"%s hands the flag to the queue, audits it and reports the outcome",
		async (method) => {
			const result = await applicationCaller[method]({
				applicationId: "a1",
				priority: true,
			});

			expect(mocks.checkPermission).toHaveBeenCalledWith(ctx, {
				deployment: ["priority"],
			});
			expect(mocks.add).toHaveBeenCalledWith(
				"deployments",
				expect.objectContaining({
					applicationId: "a1",
					priority: true,
					priorityBy: "user-1",
				}),
				expect.anything(),
			);
			expect(mocks.audit).toHaveBeenCalledWith(
				ctx,
				expect.objectContaining({
					action: "prioritize",
					resourceType: "application",
					resourceId: "a1",
					resourceName: "app-1",
					metadata: expect.objectContaining({
						via: method,
						jobId: "job-7",
						applied: true,
						wentAheadOf: 3,
					}),
				}),
			);
			expect(result).toMatchObject({
				success: true,
				applicationId: "a1",
				priority: { requested: true, applied: true, wentAheadOf: 3 },
			});
		},
	);

	it("is refused for a caller without the priority permission, and nothing is queued", async () => {
		denyPriority();

		await expect(
			applicationCaller.deploy({ applicationId: "a1", priority: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			applicationCaller.redeploy({ applicationId: "a1", priority: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.add).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("a plain deploy needs no priority permission and carries no flag", async () => {
		denyPriority();
		mocks.add.mockResolvedValue({ id: "job-8" });

		const result = await applicationCaller.deploy({ applicationId: "a1" });

		expect(mocks.checkPermission).not.toHaveBeenCalled();
		const queued = mocks.add.mock.calls[0]?.[1];
		expect(queued).not.toHaveProperty("priority");
		expect(queued).not.toHaveProperty("priorityBy");
		expect(mocks.audit).toHaveBeenCalledTimes(1);
		expect(mocks.audit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({ action: "deploy" }),
		);
		expect(result).toBeUndefined();
	});

	it("stores the requester's user id in the job, never the email (queueList returns the payload)", async () => {
		await applicationCaller.deploy({ applicationId: "a1", priority: true });

		const queued = mocks.add.mock.calls[0]?.[1];
		expect(queued.priorityBy).toBe("user-1");
		expect(JSON.stringify(queued)).not.toContain("ops@example.com");
	});

	it.each(["deploy", "redeploy"] as const)(
		"%s on Cloud with a server answers that nothing was queued, audits it and sends no flag to the deploy server",
		async (method) => {
			mocks.cloud.value = true;
			mocks.findApplicationById.mockResolvedValue({
				applicationId: "a1",
				appName: "app-1",
				serverId: "s1",
				sourceType: "github",
			});

			const result = await applicationCaller[method]({
				applicationId: "a1",
				priority: true,
			});

			expect(mocks.add).not.toHaveBeenCalled();
			const sent = mocks.cloudDeploy.mock.calls[0]?.[0];
			expect(sent).not.toHaveProperty("priority");
			expect(sent).not.toHaveProperty("priorityBy");
			expect(result).toMatchObject({
				success: true,
				applicationId: "a1",
				priority: {
					requested: true,
					applied: false,
					wentAheadOf: 0,
					reason: "not-queued",
				},
			});
			expect(mocks.audit).toHaveBeenCalledWith(
				ctx,
				expect.objectContaining({
					action: "prioritize",
					resourceId: "a1",
					metadata: expect.objectContaining({
						via: method,
						applied: false,
						reason: "not-queued",
					}),
				}),
			);
		},
	);

	it("a plain deploy on Cloud with a server still answers true", async () => {
		mocks.cloud.value = true;
		mocks.findApplicationById.mockResolvedValue({
			applicationId: "a1",
			appName: "app-1",
			serverId: "s1",
			sourceType: "github",
		});

		expect(await applicationCaller.deploy({ applicationId: "a1" })).toBe(true);
		expect(mocks.audit).toHaveBeenCalledTimes(1);
	});

	it("tells the caller when nothing was waiting", async () => {
		mocks.add.mockResolvedValue({
			id: "job-9",
			priority: {
				requested: true,
				applied: false,
				wentAheadOf: 0,
				reason: "nothing-waiting",
			},
		});

		const result = await applicationCaller.deploy({
			applicationId: "a1",
			priority: true,
		});

		expect(result).toMatchObject({
			priority: { applied: false, wentAheadOf: 0, reason: "nothing-waiting" },
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "prioritize",
				metadata: expect.objectContaining({
					applied: false,
					reason: "nothing-waiting",
				}),
			}),
		);
	});
});

describe("compose.deploy and redeploy with priority", () => {
	it.each(["deploy", "redeploy"] as const)(
		"%s hands the flag to the queue and keeps the existing result shape",
		async (method) => {
			const result = await composeCaller[method]({
				composeId: "c1",
				priority: true,
			});

			expect(mocks.add).toHaveBeenCalledWith(
				"deployments",
				expect.objectContaining({
					composeId: "c1",
					priority: true,
					priorityBy: "user-1",
				}),
				expect.anything(),
			);
			expect(mocks.audit).toHaveBeenCalledWith(
				ctx,
				expect.objectContaining({
					action: "prioritize",
					resourceType: "compose",
					resourceId: "c1",
					resourceName: "stack",
				}),
			);
			expect(result).toMatchObject({
				success: true,
				composeId: "c1",
				priority: { applied: true, wentAheadOf: 3 },
			});
		},
	);

	it.each(["deploy", "redeploy"] as const)(
		"%s on Cloud with a server answers that nothing was queued and audits it",
		async (method) => {
			mocks.cloud.value = true;
			mocks.findComposeById.mockResolvedValue({
				composeId: "c1",
				name: "stack",
				serverId: "s1",
			});

			const result = await composeCaller[method]({
				composeId: "c1",
				priority: true,
			});

			expect(mocks.add).not.toHaveBeenCalled();
			const sent = mocks.cloudDeploy.mock.calls[0]?.[0];
			expect(sent).not.toHaveProperty("priority");
			expect(sent).not.toHaveProperty("priorityBy");
			expect(result).toMatchObject({
				success: true,
				composeId: "c1",
				priority: { applied: false, reason: "not-queued" },
			});
			expect(mocks.audit).toHaveBeenCalledWith(
				ctx,
				expect.objectContaining({
					action: "prioritize",
					resourceType: "compose",
					metadata: expect.objectContaining({
						via: method,
						reason: "not-queued",
					}),
				}),
			);
		},
	);

	it("is refused without the priority permission", async () => {
		denyPriority();

		await expect(
			composeCaller.deploy({ composeId: "c1", priority: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			composeCaller.redeploy({ composeId: "c1", priority: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.add).not.toHaveBeenCalled();
	});

	it("a plain deploy has no priority in its result", async () => {
		mocks.add.mockResolvedValue({ id: "job-8" });

		const result = await composeCaller.deploy({ composeId: "c1" });

		expect(result).toEqual({
			success: true,
			message: "Deployment queued",
			composeId: "c1",
		});
		expect(mocks.audit).toHaveBeenCalledTimes(1);
	});
});

describe("deployment.prioritizeQueued", () => {
	const waitingJob = (id: string, data: Record<string, unknown>) => ({
		id,
		data,
	});

	beforeEach(() => {
		mocks.getJobs.mockResolvedValue([
			waitingJob("job-5", {
				applicationId: "a1",
				applicationType: "application",
			}),
			waitingJob("job-6", { composeId: "c1", applicationType: "compose" }),
		]);
		mocks.prioritize.mockReturnValue(applied);
	});

	it("flags a waiting application deploy, audits it and reports the outcome", async () => {
		const result = await deploymentCaller.prioritizeQueued({ jobId: "job-5" });

		expect(mocks.prioritize).toHaveBeenCalledWith("job-5", "user-1");
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			ctx,
			"a1",
			{ deployment: ["create"] },
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "prioritize",
				resourceType: "application",
				resourceId: "a1",
				resourceName: "app-1",
				metadata: expect.objectContaining({
					via: "prioritizeQueued",
					jobId: "job-5",
				}),
			}),
		);
		expect(result).toMatchObject({
			success: true,
			jobId: "job-5",
			priority: { applied: true, wentAheadOf: 3 },
		});
	});

	it("flags a waiting compose deploy", async () => {
		await deploymentCaller.prioritizeQueued({ jobId: "job-6" });

		expect(mocks.audit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				resourceType: "compose",
				resourceId: "c1",
				resourceName: "stack",
			}),
		);
	});

	it("is refused without the priority permission, before the queue is looked at", async () => {
		denyPriority();

		await expect(
			deploymentCaller.prioritizeQueued({ jobId: "job-5" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getJobs).not.toHaveBeenCalled();
		expect(mocks.prioritize).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("answers a missing job, a job of a service the caller cannot reach and a job that just started alike", async () => {
		await expect(
			deploymentCaller.prioritizeQueued({ jobId: "job-404" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const missing = await deploymentCaller
			.prioritizeQueued({ jobId: "job-404" })
			.catch((error) => error.message);

		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("not yours"),
		);
		const forbidden = await deploymentCaller
			.prioritizeQueued({ jobId: "job-5" })
			.catch((error) => error.message);

		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		mocks.prioritize.mockReturnValue(null);
		const started = await deploymentCaller
			.prioritizeQueued({ jobId: "job-5" })
			.catch((error) => error.message);

		expect(forbidden).toBe(missing);
		expect(started).toBe(missing);
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});
