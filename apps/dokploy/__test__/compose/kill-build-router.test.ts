import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which host a "cancel build" reaches. A service that builds on a build server
 * is cancelled there, by deployment; the host-wide `pkill` only ever runs on
 * the serving host, and only for services that build there.
 */

const mocks = vi.hoisted(() => ({
	findComposeById: vi.fn(),
	findApplicationById: vi.fn(),
	findDeploymentById: vi.fn(),
	cancelBuildServerDeploymentsForService: vi.fn(),
	cancelBuildServerDeploymentById: vi.fn(),
	killDockerBuild: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	claimScheduleRunCancel: vi.fn(),
	revertScheduleRunCancel: vi.fn(),
	removeDeployment: vi.fn(),
	audit: vi.fn(),
	auditCancel: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findComposeById: mocks.findComposeById,
	findApplicationById: mocks.findApplicationById,
	findDeploymentById: mocks.findDeploymentById,
	cancelBuildServerDeploymentsForService:
		mocks.cancelBuildServerDeploymentsForService,
	cancelBuildServerDeploymentById: mocks.cancelBuildServerDeploymentById,
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	updateDeploymentStatus: mocks.updateDeploymentStatus,
	claimScheduleRunCancel: mocks.claimScheduleRunCancel,
	revertScheduleRunCancel: mocks.revertScheduleRunCancel,
	removeDeployment: mocks.removeDeployment,
	isMissingProcessError: () => false,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/cancel-audit", () => ({
	auditCancel: mocks.auditCancel,
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanQueuesByCompose: vi.fn(),
	cleanQueuesByApplication: vi.fn(),
	killDockerBuild: mocks.killDockerBuild,
	myQueue: { add: vi.fn() },
}));

const ctx = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
};

const { composeRouter } = await import("@/server/api/routers/compose");
const { applicationRouter } = await import("@/server/api/routers/application");
const { deploymentRouter } = await import("@/server/api/routers/deployment");

const composeCaller = composeRouter.createCaller(
	ctx as Parameters<typeof composeRouter.createCaller>[0],
);
const applicationCaller = applicationRouter.createCaller(
	ctx as Parameters<typeof applicationRouter.createCaller>[0],
);
const deploymentCaller = deploymentRouter.createCaller(
	ctx as Parameters<typeof deploymentRouter.createCaller>[0],
);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.cancelBuildServerDeploymentsForService.mockResolvedValue({
		deploymentIds: [],
		usesBuildServer: false,
		cancelled: 0,
		stopped: 0,
		warnings: [],
	});
	mocks.cancelBuildServerDeploymentById.mockResolvedValue(null);
	mocks.claimScheduleRunCancel.mockResolvedValue(true);
});

describe("compose.killBuild", () => {
	it("cancels on the build server and never pkills the serving host", async () => {
		mocks.findComposeById.mockResolvedValue({
			composeId: "c1",
			name: "stack",
			serverId: "serving-1",
			buildServerId: "build-1",
		});

		await composeCaller.killBuild({ composeId: "c1" });

		expect(mocks.cancelBuildServerDeploymentsForService).toHaveBeenCalledWith({
			type: "compose",
			composeId: "c1",
		});
		expect(mocks.killDockerBuild).not.toHaveBeenCalled();
	});

	it("without a build server and no rolling replace running is exactly the old behaviour", async () => {
		mocks.findComposeById.mockResolvedValue({
			composeId: "c1",
			name: "stack",
			serverId: "serving-1",
			buildServerId: null,
		});

		await composeCaller.killBuild({ composeId: "c1" });

		expect(mocks.cancelBuildServerDeploymentsForService).toHaveBeenCalledWith({
			type: "compose",
			composeId: "c1",
		});
		expect(mocks.killDockerBuild).toHaveBeenCalledWith("compose", "serving-1");
	});

	it("without a build server, a running rolling replace is cancelled by its launcher and never pkilled", async () => {
		mocks.findComposeById.mockResolvedValue({
			composeId: "c1",
			name: "stack",
			serverId: "serving-1",
			buildServerId: null,
		});
		mocks.cancelBuildServerDeploymentsForService.mockResolvedValue({
			deploymentIds: [],
			usesBuildServer: false,
			cancelled: 1,
			stopped: 1,
			warnings: [],
		});

		await composeCaller.killBuild({ composeId: "c1" });

		expect(mocks.killDockerBuild).not.toHaveBeenCalled();
	});

	it("without a build server, a cancel that stopped nothing (no pid file, host unreachable) still falls back to the generic stop", async () => {
		mocks.findComposeById.mockResolvedValue({
			composeId: "c1",
			name: "stack",
			serverId: "serving-1",
			buildServerId: null,
		});
		mocks.cancelBuildServerDeploymentsForService.mockResolvedValue({
			deploymentIds: [],
			usesBuildServer: false,
			cancelled: 1,
			stopped: 0,
			warnings: ["The release step ... pid file was not found"],
		});

		await composeCaller.killBuild({ composeId: "c1" });

		expect(mocks.killDockerBuild).toHaveBeenCalledWith("compose", "serving-1");
	});
});

describe("application.killBuild", () => {
	const application = (extra = {}) => ({
		applicationId: "a1",
		name: "app",
		serverId: "serving-1",
		buildServerId: null,
		...extra,
	});

	it("without a build server keeps the pkill on the serving host", async () => {
		mocks.findApplicationById.mockResolvedValue(application());

		await applicationCaller.killBuild({ applicationId: "a1" });

		expect(mocks.killDockerBuild).toHaveBeenCalledWith(
			"application",
			"serving-1",
		);
	});

	it("cancels the running build-server deployment and does not pkill the serving host", async () => {
		mocks.findApplicationById.mockResolvedValue(
			application({ buildServerId: "build-1" }),
		);
		mocks.cancelBuildServerDeploymentsForService.mockResolvedValue({
			deploymentIds: [],
			usesBuildServer: true,
			cancelled: 1,
			warnings: [],
		});

		await applicationCaller.killBuild({ applicationId: "a1" });

		expect(mocks.cancelBuildServerDeploymentsForService).toHaveBeenCalledWith({
			type: "application",
			applicationId: "a1",
		});
		expect(mocks.killDockerBuild).not.toHaveBeenCalled();
	});

	it("an application configured for a build server never pkills the serving host, even with nothing running", async () => {
		mocks.findApplicationById.mockResolvedValue(
			application({ buildServerId: "build-1" }),
		);

		await applicationCaller.killBuild({ applicationId: "a1" });

		expect(mocks.killDockerBuild).not.toHaveBeenCalled();
	});

	it("a policy-forced remote build (no buildServerId on the app) is still cancelled remotely", async () => {
		mocks.findApplicationById.mockResolvedValue(application());
		mocks.cancelBuildServerDeploymentsForService.mockResolvedValue({
			deploymentIds: [],
			usesBuildServer: true,
			cancelled: 1,
			warnings: [],
		});

		await applicationCaller.killBuild({ applicationId: "a1" });

		expect(mocks.killDockerBuild).not.toHaveBeenCalled();
	});
});

describe("deployment.killProcess", () => {
	const deployment = (extra = {}) => ({
		deploymentId: "dep-1",
		applicationId: "a1",
		composeId: null,
		pid: null,
		status: "running",
		schedule: null,
		...extra,
	});

	it("stops a build-server deployment remotely and does not need a local pid", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment());
		mocks.cancelBuildServerDeploymentById.mockResolvedValue({
			status: "cancelled",
			result: "KILLED",
		});

		await deploymentCaller.killProcess({ deploymentId: "dep-1" });

		expect(mocks.cancelBuildServerDeploymentById).toHaveBeenCalledWith("dep-1");
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: "cancel", resourceId: "dep-1" }),
		);
	});

	it("a compose without a build server whose release step could not be signalled keeps the pid kill", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment({ pid: "4242" }));
		mocks.cancelBuildServerDeploymentById.mockResolvedValue({
			status: "cancelled",
			result: "NONE",
			warning: "pid file was not found",
			genericStopNeeded: true,
		});

		await deploymentCaller.killProcess({ deploymentId: "dep-1" });

		expect(mocks.execAsync).toHaveBeenCalledWith("kill -9 4242");
	});

	it("keeps the old pid kill for a deployment that does not build on a build server", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment({ pid: "4242" }));

		await deploymentCaller.killProcess({ deploymentId: "dep-1" });

		expect(mocks.execAsync).toHaveBeenCalledWith("kill -9 4242");
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
	});

	it.each([
		["deployment.serverId", { serverId: "srv-1" }],
		["application.serverId", { application: { serverId: "srv-1" } }],
		["compose.serverId", { compose: { serverId: "srv-1" } }],
	])("kills the pid on the remote host given by %s", async (_name, extra) => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({ pid: "4242", ...extra }),
		);

		await deploymentCaller.killProcess({ deploymentId: "dep-1" });

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith("srv-1", "kill -9 4242");
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: "cancel", resourceId: "dep-1" }),
		);
	});

	it("kills the pid of a schedule run on the remote host given by schedule.serverId, and marks it cancelled", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({
				pid: "4242",
				schedule: { scheduleType: "server", serverId: "srv-1" },
			}),
		);

		await deploymentCaller.killProcess({ deploymentId: "dep-1" });

		expect(mocks.claimScheduleRunCancel).toHaveBeenCalledWith("dep-1");
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith("srv-1", "kill -9 4242");
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: "cancel", resourceId: "dep-1" }),
		);
	});

	it.each(["1; rm -rf /", "42 43", "$(id)", "-9", "4242\n", "0", "1", "007"])(
		"refuses the non-numeric pid %j without running anything",
		async (pid) => {
			mocks.findDeploymentById.mockResolvedValue(
				deployment({ pid, serverId: "srv-1" }),
			);

			await expect(
				deploymentCaller.killProcess({ deploymentId: "dep-1" }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.execAsync).not.toHaveBeenCalled();
			expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
			expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
			expect(mocks.audit).not.toHaveBeenCalled();
		},
	);

	it("still says 'not running' when there is neither a remote build nor a pid", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment());

		await expect(
			deploymentCaller.killProcess({ deploymentId: "dep-1" }),
		).rejects.toMatchObject({ message: "Deployment is not running" });
	});

	it.each(["done", "error", "cancelled"])(
		"refuses a %s deployment that still has a pid, which may belong to another process by now",
		async (status) => {
			mocks.findDeploymentById.mockResolvedValue(
				deployment({ pid: "4242", status, serverId: "srv-1" }),
			);

			await expect(
				deploymentCaller.killProcess({ deploymentId: "dep-1" }),
			).rejects.toMatchObject({ message: "Deployment is not running" });
			expect(mocks.execAsync).not.toHaveBeenCalled();
			expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
			expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
			expect(mocks.audit).not.toHaveBeenCalled();
		},
	);

	it("a build-server deployment that already finished is not reported as cancelled", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment());
		mocks.cancelBuildServerDeploymentById.mockResolvedValue({
			status: "not-running",
		});

		await expect(
			deploymentCaller.killProcess({ deploymentId: "dep-1" }),
		).rejects.toMatchObject({ message: "Deployment is not running" });
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});

describe("who cancelled", () => {
	// The caller is the first argument of audit(), which reads the actor and the
	// organization from it.
	const actor = expect.objectContaining({
		user: expect.objectContaining({ id: "user-1", email: "user@example.com" }),
		session: expect.objectContaining({ activeOrganizationId: "org-1" }),
	});

	const compose = (extra = {}) => ({
		composeId: "c1",
		name: "stack",
		serverId: "serving-1",
		buildServerId: null,
		...extra,
	});

	it("compose.killBuild on a build server records the caller and the stack", async () => {
		mocks.findComposeById.mockResolvedValue(
			compose({ buildServerId: "build-1" }),
		);

		await composeCaller.killBuild({ composeId: "c1" });

		expect(mocks.audit).toHaveBeenCalledTimes(1);
		expect(mocks.audit).toHaveBeenCalledWith(actor, {
			action: "cancel",
			resourceType: "compose",
			resourceId: "c1",
			resourceName: "stack",
		});
	});

	it("compose.killBuild on the serving host records the caller, whether the launcher or the pkill stopped it", async () => {
		mocks.findComposeById.mockResolvedValue(compose());
		await composeCaller.killBuild({ composeId: "c1" });
		expect(mocks.killDockerBuild).toHaveBeenCalledTimes(1);

		mocks.cancelBuildServerDeploymentsForService.mockResolvedValue({
			deploymentIds: [],
			usesBuildServer: false,
			cancelled: 1,
			stopped: 1,
			warnings: [],
		});
		await composeCaller.killBuild({ composeId: "c1" });
		expect(mocks.killDockerBuild).toHaveBeenCalledTimes(1);

		expect(mocks.audit).toHaveBeenCalledTimes(2);
		for (const call of mocks.audit.mock.calls) {
			expect(call[0]).toEqual(actor);
			expect(call[1]).toMatchObject({
				action: "cancel",
				resourceType: "compose",
				resourceId: "c1",
				resourceName: "stack",
			});
		}
	});

	it("application.killBuild records the caller and the application as a cancel", async () => {
		mocks.findApplicationById.mockResolvedValue({
			applicationId: "a1",
			appName: "app-abc123",
			serverId: "serving-1",
			buildServerId: null,
		});

		await applicationCaller.killBuild({ applicationId: "a1" });

		expect(mocks.audit).toHaveBeenCalledTimes(1);
		expect(mocks.audit).toHaveBeenCalledWith(actor, {
			action: "cancel",
			resourceType: "application",
			resourceId: "a1",
			resourceName: "app-abc123",
		});
	});

	it("deployment.killProcess names the service and the deployment on every path", async () => {
		const running = (extra = {}) => ({
			deploymentId: "dep-1",
			title: "Rebuild",
			applicationId: "a1",
			composeId: null,
			application: { appName: "app-abc123", serverId: "srv-1" },
			pid: "4242",
			status: "running",
			schedule: null,
			...extra,
		});
		const expected = {
			action: "cancel",
			resourceType: "deployment",
			resourceId: "dep-1",
			resourceName: "app-abc123",
			metadata: { title: "Rebuild", applicationId: "a1", composeId: null },
		};

		// a pid kill
		mocks.findDeploymentById.mockResolvedValue(running());
		await deploymentCaller.killProcess({ deploymentId: "dep-1" });

		// a build-server cancel
		mocks.cancelBuildServerDeploymentById.mockResolvedValue({
			status: "cancelled",
			result: "KILLED",
		});
		await deploymentCaller.killProcess({ deploymentId: "dep-1" });

		// a schedule run: the entry carries the run's title, there is no service
		mocks.cancelBuildServerDeploymentById.mockResolvedValue(null);
		mocks.findDeploymentById.mockResolvedValue(
			running({
				title: "nightly cleanup",
				application: undefined,
				schedule: { scheduleType: "server", serverId: "srv-1" },
			}),
		);
		await deploymentCaller.killProcess({ deploymentId: "dep-1" });

		expect(mocks.audit).toHaveBeenCalledTimes(3);
		expect(mocks.audit.mock.calls[0]).toEqual([actor, expected]);
		expect(mocks.audit.mock.calls[1]).toEqual([actor, expected]);
		expect(mocks.audit.mock.calls[2]).toEqual([
			actor,
			{
				...expected,
				resourceName: "nightly cleanup",
				metadata: {
					title: "nightly cleanup",
					applicationId: "a1",
					composeId: null,
				},
			},
		]);
	});

	it("deployment.removeDeployment records the caller and the service", async () => {
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "dep-1",
			title: "Deploy",
			applicationId: null,
			composeId: "c1",
			compose: { appName: "stack-xyz789", serverId: null },
		});
		mocks.removeDeployment.mockResolvedValue(true);

		await deploymentCaller.removeDeployment({ deploymentId: "dep-1" });

		expect(mocks.audit).toHaveBeenCalledWith(actor, {
			action: "delete",
			resourceType: "deployment",
			resourceId: "dep-1",
			resourceName: "stack-xyz789",
			metadata: { title: "Deploy", applicationId: null, composeId: "c1" },
		});
	});
});

describe("who cancelled, in the fork cancel trail", () => {
	const caller = expect.objectContaining({
		user: expect.objectContaining({ id: "user-1", email: "user@example.com" }),
		session: expect.objectContaining({ activeOrganizationId: "org-1" }),
	});

	it("compose.killBuild records the stack on every exit", async () => {
		const stack = {
			composeId: "c1",
			name: "stack",
			appName: "stack-xyz789",
			serverId: "serving-1",
			buildServerId: null,
		};
		const expected = {
			action: "kill_build",
			targetType: "compose",
			targetId: "c1",
			targetName: "stack-xyz789",
			composeId: "c1",
		};

		// on a build server
		mocks.findComposeById.mockResolvedValue({
			...stack,
			buildServerId: "build-1",
		});
		await composeCaller.killBuild({ composeId: "c1" });
		// launcher stopped it
		mocks.findComposeById.mockResolvedValue(stack);
		mocks.cancelBuildServerDeploymentsForService.mockResolvedValue({
			deploymentIds: [],
			usesBuildServer: false,
			cancelled: 1,
			stopped: 1,
			warnings: [],
		});
		await composeCaller.killBuild({ composeId: "c1" });
		// pkill fallback
		mocks.cancelBuildServerDeploymentsForService.mockResolvedValue({
			deploymentIds: [],
			usesBuildServer: false,
			cancelled: 0,
			stopped: 0,
			warnings: [],
		});
		await composeCaller.killBuild({ composeId: "c1" });

		expect(mocks.auditCancel).toHaveBeenCalledTimes(3);
		for (const call of mocks.auditCancel.mock.calls) {
			expect(call).toEqual([caller, expected]);
		}
	});

	it("application.killBuild records the application", async () => {
		mocks.findApplicationById.mockResolvedValue({
			applicationId: "a1",
			appName: "app-abc123",
			serverId: "serving-1",
			buildServerId: null,
		});

		await applicationCaller.killBuild({ applicationId: "a1" });

		expect(mocks.auditCancel).toHaveBeenCalledTimes(1);
		expect(mocks.auditCancel).toHaveBeenCalledWith(caller, {
			action: "kill_build",
			targetType: "application",
			targetId: "a1",
			targetName: "app-abc123",
			applicationId: "a1",
		});
	});

	it("killBuild records each deployment it stopped, so the deployment can show who did", async () => {
		mocks.findApplicationById.mockResolvedValue({
			applicationId: "a1",
			appName: "app-abc123",
			serverId: "serving-1",
			buildServerId: "build-1",
		});
		mocks.cancelBuildServerDeploymentsForService.mockResolvedValue({
			deploymentIds: ["dep-1", "dep-2"],
			usesBuildServer: true,
			cancelled: 2,
			stopped: 2,
			warnings: [],
		});

		await applicationCaller.killBuild({ applicationId: "a1" });

		expect(mocks.auditCancel).toHaveBeenCalledTimes(2);
		for (const [i, deploymentId] of ["dep-1", "dep-2"].entries()) {
			expect(mocks.auditCancel.mock.calls[i]).toEqual([
				caller,
				{
					action: "kill_build",
					targetType: "application",
					targetId: "a1",
					targetName: "app-abc123",
					applicationId: "a1",
					deploymentId,
				},
			]);
		}

		vi.clearAllMocks();
		mocks.findComposeById.mockResolvedValue({
			composeId: "c1",
			appName: "stack-xyz789",
			name: "stack",
			serverId: "serving-1",
			buildServerId: null,
		});
		mocks.cancelBuildServerDeploymentsForService.mockResolvedValue({
			deploymentIds: ["dep-3"],
			usesBuildServer: false,
			cancelled: 1,
			stopped: 1,
			warnings: [],
		});

		await composeCaller.killBuild({ composeId: "c1" });

		expect(mocks.auditCancel).toHaveBeenCalledTimes(1);
		expect(mocks.auditCancel).toHaveBeenCalledWith(caller, {
			action: "kill_build",
			targetType: "compose",
			targetId: "c1",
			targetName: "stack-xyz789",
			composeId: "c1",
			deploymentId: "dep-3",
		});
	});

	it("deployment.killProcess records the deployment and its service on every path", async () => {
		const running = (extra = {}) => ({
			deploymentId: "dep-1",
			title: "Rebuild",
			applicationId: "a1",
			composeId: null,
			application: { appName: "app-abc123", serverId: "srv-1" },
			pid: "4242",
			status: "running",
			schedule: null,
			...extra,
		});
		const expected = {
			action: "kill_process",
			targetType: "deployment",
			targetId: "dep-1",
			targetName: "app-abc123",
			applicationId: "a1",
			composeId: null,
			deploymentId: "dep-1",
			metadata: { title: "Rebuild" },
		};

		// a pid kill
		mocks.findDeploymentById.mockResolvedValue(running());
		await deploymentCaller.killProcess({ deploymentId: "dep-1" });
		// a build-server cancel
		mocks.cancelBuildServerDeploymentById.mockResolvedValue({
			status: "cancelled",
			result: "KILLED",
		});
		await deploymentCaller.killProcess({ deploymentId: "dep-1" });
		// a schedule run, named by its title
		mocks.cancelBuildServerDeploymentById.mockResolvedValue(null);
		mocks.findDeploymentById.mockResolvedValue(
			running({
				title: "nightly cleanup",
				application: undefined,
				schedule: { scheduleType: "server", serverId: "srv-1" },
			}),
		);
		await deploymentCaller.killProcess({ deploymentId: "dep-1" });

		expect(mocks.auditCancel).toHaveBeenCalledTimes(3);
		expect(mocks.auditCancel.mock.calls[0]).toEqual([caller, expected]);
		expect(mocks.auditCancel.mock.calls[1]).toEqual([caller, expected]);
		expect(mocks.auditCancel.mock.calls[2]).toEqual([
			caller,
			{
				...expected,
				targetName: "nightly cleanup",
				metadata: { title: "nightly cleanup" },
			},
		]);
	});

	it("deployment.killProcess records nothing when it refuses", async () => {
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "dep-1",
			applicationId: "a1",
			composeId: null,
			pid: "4242",
			status: "done",
			schedule: null,
		});

		await expect(
			deploymentCaller.killProcess({ deploymentId: "dep-1" }),
		).rejects.toMatchObject({ message: "Deployment is not running" });
		expect(mocks.auditCancel).not.toHaveBeenCalled();
	});

	it("deployment.removeDeployment records the deployment", async () => {
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "dep-1",
			title: "Deploy",
			applicationId: null,
			composeId: "c1",
			compose: { appName: "stack-xyz789", serverId: null },
		});
		mocks.removeDeployment.mockResolvedValue(true);

		await deploymentCaller.removeDeployment({ deploymentId: "dep-1" });

		expect(mocks.auditCancel).toHaveBeenCalledWith(caller, {
			action: "remove_deployment",
			targetType: "deployment",
			targetId: "dep-1",
			targetName: "stack-xyz789",
			applicationId: null,
			composeId: "c1",
			deploymentId: "dep-1",
			metadata: { title: "Deploy" },
		});
	});
});
