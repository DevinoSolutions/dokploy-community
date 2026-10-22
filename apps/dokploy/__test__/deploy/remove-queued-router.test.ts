import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * deployment.removeQueued takes ONE waiting job out of the local deploy queue.
 * It needs deployment:cancel on the job's service, never touches a running job,
 * answers a missing job, a foreign one and one that just started alike, and
 * audits the removal in both trails.
 */

const mocks = vi.hoisted(() => ({
	cloud: { value: false },
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	audit: vi.fn(),
	auditCancel: vi.fn(),
	jobs: [] as { id: string; state: string; data: Record<string, unknown> }[],
	getJobs: vi.fn(),
	removeWaitingJob: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("@dokploy/server", () => ({
	get IS_CLOUD() {
		return mocks.cloud.value;
	},
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
	updateDeploymentStatus: mocks.updateDeploymentStatus,
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

vi.mock("@/server/api/utils/cancel-audit", () => ({
	auditCancel: mocks.auditCancel,
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanQueuesByCompose: vi.fn(),
	cleanQueuesByApplication: vi.fn(),
	killDockerBuild: vi.fn(),
	myQueue: {
		getJobs: mocks.getJobs,
		removeWaitingJob: mocks.removeWaitingJob,
	},
}));

const ctx = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "ops@example.com", role: "admin" },
};

// The service each fixture job belongs to, as the queue table sends it.
const svc = (jobId: string) => (jobId === "job-6" ? "c1" : "a1");

const { deploymentRouter } = await import("@/server/api/routers/deployment");
const caller = deploymentRouter.createCaller(
	ctx as Parameters<typeof deploymentRouter.createCaller>[0],
);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.cloud.value = false;
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findApplicationById.mockResolvedValue({
		applicationId: "a1",
		appName: "app-1",
	});
	mocks.findComposeById.mockResolvedValue({
		composeId: "c1",
		appName: "stack-1",
		name: "Stack",
	});
	mocks.jobs = [
		{
			id: "job-5",
			state: "waiting",
			data: {
				applicationId: "a1",
				applicationType: "application",
				type: "deploy",
				titleLog: "Manual deployment",
			},
		},
		{
			id: "job-6",
			state: "waiting",
			data: {
				composeId: "c1",
				applicationType: "compose",
				type: "redeploy",
				titleLog: "Redeploy",
			},
		},
		{
			id: "job-run",
			state: "active",
			data: { applicationId: "a1", applicationType: "application" },
		},
		{ id: "job-nodata", state: "waiting", data: {} },
	];
	mocks.getJobs.mockImplementation(async (states?: string[]) =>
		mocks.jobs.filter((job) => !states || states.includes(job.state)),
	);
	mocks.removeWaitingJob.mockReturnValue(true);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("deployment.removeQueued", () => {
	it("removes a waiting application deploy and audits it in both trails", async () => {
		const result = await caller.removeQueued({
			jobId: "job-5",
			serviceId: svc("job-5"),
		});

		expect(mocks.getJobs).toHaveBeenCalledWith(["waiting"]);
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			ctx,
			"a1",
			{ deployment: ["cancel"] },
		);
		expect(mocks.removeWaitingJob).toHaveBeenCalledWith("job-5");
		const metadata = {
			jobId: "job-5",
			resourceType: "application",
			serviceId: "a1",
			serviceName: "app-1",
			jobType: "deploy",
			applicationType: "application",
			title: "Manual deployment",
		};
		expect(mocks.auditCancel).toHaveBeenCalledWith(ctx, {
			action: "remove_queued_job",
			targetType: "application",
			targetId: "a1",
			targetName: "app-1",
			applicationId: "a1",
			composeId: undefined,
			metadata,
		});
		expect(mocks.audit).toHaveBeenCalledWith(ctx, {
			action: "cancel",
			resourceType: "application",
			resourceId: "a1",
			resourceName: "app-1",
			metadata,
		});
		expect(result).toEqual({
			success: true,
			jobId: "job-5",
			serviceId: "a1",
			resourceType: "application",
		});
	});

	it("removes a waiting compose deploy", async () => {
		await caller.removeQueued({ jobId: "job-6", serviceId: svc("job-6") });

		expect(mocks.removeWaitingJob).toHaveBeenCalledWith("job-6");
		expect(mocks.auditCancel).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "remove_queued_job",
				targetType: "compose",
				targetId: "c1",
				targetName: "stack-1",
				composeId: "c1",
				applicationId: undefined,
			}),
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				resourceType: "compose",
				resourceId: "c1",
				resourceName: "stack-1",
			}),
		);
	});

	it("refuses a running job: it is never removed or audited", async () => {
		await expect(
			caller.removeQueued({ jobId: "job-run", serviceId: svc("job-run") }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.removeWaitingJob).not.toHaveBeenCalled();
		expect(mocks.auditCancel).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("answers a missing job, a foreign or forbidden job, a deleted service and a payload without a service identically", async () => {
		const attempt = (jobId: string) =>
			caller
				.removeQueued({ jobId, serviceId: svc(jobId) })
				.catch((error) => error);

		const missing = await attempt("job-404");
		mocks.checkServicePermissionAndAccess.mockRejectedValueOnce(
			new Error("Service not found in your organization"),
		);
		const foreign = await attempt("job-5");
		mocks.findComposeById.mockRejectedValueOnce(new Error("gone"));
		const deleted = await attempt("job-6");
		const noService = await attempt("job-nodata");
		const running = await attempt("job-run");

		expect(missing).toMatchObject({ code: "NOT_FOUND" });
		for (const error of [foreign, deleted, noService, running]) {
			expect(error.code).toBe(missing.code);
			expect(error.message).toBe(missing.message);
		}
		expect(mocks.removeWaitingJob).not.toHaveBeenCalled();
		expect(mocks.auditCancel).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("gives the same answer when the job started between the lookup and the removal", async () => {
		const missing = await caller
			.removeQueued({ jobId: "job-404", serviceId: svc("job-404") })
			.catch((error) => error);
		mocks.removeWaitingJob.mockReturnValue(false);

		const raced = await caller
			.removeQueued({ jobId: "job-5", serviceId: svc("job-5") })
			.catch((error) => error);

		expect(raced).toMatchObject({ code: "NOT_FOUND" });
		expect(raced.message).toBe(missing.message);
		expect(mocks.auditCancel).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("answers a job whose service is not the one the caller named like a missing job", async () => {
		const missing = await caller
			.removeQueued({ jobId: "job-404", serviceId: "a1" })
			.catch((error) => error);

		// job-5 belongs to a1: after a restart the id may name a different job.
		const stale = await caller
			.removeQueued({ jobId: "job-5", serviceId: "c1" })
			.catch((error) => error);

		expect(stale).toMatchObject({ code: "NOT_FOUND" });
		expect(stale.message).toBe(missing.message);
		expect(mocks.removeWaitingJob).not.toHaveBeenCalled();
		expect(mocks.auditCancel).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("truncates a long job title in the audit metadata", async () => {
		const [job] = mocks.jobs;
		if (!job) throw new Error("expected a waiting job fixture");
		job.data.titleLog = "x".repeat(500);

		await caller.removeQueued({ jobId: "job-5", serviceId: "a1" });

		expect(mocks.auditCancel).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				metadata: expect.objectContaining({ title: "x".repeat(200) }),
			}),
		);
	});

	it("maps a removal that throws to the same answer, without auditing", async () => {
		mocks.removeWaitingJob.mockImplementation(() => {
			throw new Error("Missing lock for job job-5");
		});

		await expect(
			caller.removeQueued({ jobId: "job-5", serviceId: svc("job-5") }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.auditCancel).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("is refused on Cloud before the queue is looked at", async () => {
		mocks.cloud.value = true;

		await expect(
			caller.removeQueued({ jobId: "job-5", serviceId: svc("job-5") }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.getJobs).not.toHaveBeenCalled();
		expect(mocks.removeWaitingJob).not.toHaveBeenCalled();
		expect(mocks.auditCancel).not.toHaveBeenCalled();
	});

	it("changes no deployment row: a waiting job has none until it starts", async () => {
		await caller.removeQueued({ jobId: "job-5", serviceId: svc("job-5") });

		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
	});

	it("still reports the removal when the enterprise audit entry fails", async () => {
		mocks.audit.mockRejectedValue(new Error("audit down"));

		await expect(
			caller.removeQueued({ jobId: "job-5", serviceId: svc("job-5") }),
		).resolves.toMatchObject({ success: true, jobId: "job-5" });
		expect(mocks.auditCancel).toHaveBeenCalledTimes(1);
	});

	it("rejects an empty job id", async () => {
		await expect(
			caller.removeQueued({ jobId: "", serviceId: svc("") }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});
});
