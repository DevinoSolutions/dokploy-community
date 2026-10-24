import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InMemoryJob } from "../../server/queues/in-memory-queue";
import {
	type CancelActiveDeps,
	cancelActiveServiceDeployment,
} from "../../server/utils/cancel-active-deployment";

/**
 * Cancelling a RUNNING deployment on a self-hosted instance: the same stop as
 * Cloud's cancel in effect (the work is stopped, the job ends and frees its
 * slot), through the existing kill machinery.
 */

const runningRow = (overrides = {}) => ({
	deploymentId: "dep-1",
	title: "Deploy",
	logPath: "/logs/app/dep-1.log",
	pid: null,
	serverId: null,
	buildServerId: null,
	applicationId: "app-1",
	composeId: null,
	previewDeploymentId: null,
	startedAt: null,
	createdAt: new Date().toISOString(),
	...overrides,
});

const job = (id: string, data: Record<string, unknown>) =>
	({ id, journalId: `j-${id}`, name: "deployments", data }) as InMemoryJob;

const appJob = (id = "job-1", applicationId = "app-1") =>
	job(id, { applicationType: "application", applicationId });

let jobs: InMemoryJob[] = [];

const deps = {
	listRunning: vi.fn(),
	activeJobs: vi.fn(async () => jobs),
	stop: vi.fn(),
	logHost: vi.fn(),
	appendLog: vi.fn(async () => {}),
	sleep: vi.fn(async () => {
		// The job ends by itself shortly after the stop.
		jobs = [];
	}),
	waitMs: 5_000,
} satisfies CancelActiveDeps;

beforeEach(() => {
	vi.clearAllMocks();
	jobs = [appJob()];
	deps.listRunning.mockResolvedValue([runningRow()]);
	deps.logHost.mockResolvedValue(null);
	deps.stop.mockResolvedValue({
		method: "launcher",
		notRunning: false,
		claimedCancelled: true,
	});
	deps.sleep.mockImplementation(async () => {
		jobs = [];
	});
});

describe("cancelActiveServiceDeployment", () => {
	it("stops the running deployment of the application and reports the slot free", async () => {
		const result = await cancelActiveServiceDeployment(
			{ type: "application", applicationId: "app-1" },
			deps,
		);

		expect(deps.stop).toHaveBeenCalledTimes(1);
		expect(deps.stop.mock.calls[0]?.[0]).toMatchObject({
			deploymentId: "dep-1",
		});
		expect(result).toEqual({
			status: "cancelled",
			deploymentIds: ["dep-1"],
			slotFree: true,
			warnings: [],
		});
	});

	it("stops a compose by its composeId", async () => {
		deps.listRunning.mockResolvedValue([
			runningRow({
				deploymentId: "dep-c",
				applicationId: null,
				composeId: "comp-1",
			}),
		]);
		jobs = [job("job-c", { applicationType: "compose", composeId: "comp-1" })];

		const result = await cancelActiveServiceDeployment(
			{ type: "compose", composeId: "comp-1" },
			deps,
		);

		expect(result).toMatchObject({
			status: "cancelled",
			deploymentIds: ["dep-c"],
		});
	});

	it("does not touch another service's deployment", async () => {
		deps.listRunning.mockResolvedValue([
			runningRow({ deploymentId: "dep-other", applicationId: "app-2" }),
		]);
		jobs = [appJob("job-2", "app-2")];

		const result = await cancelActiveServiceDeployment(
			{ type: "application", applicationId: "app-1" },
			deps,
		);

		expect(deps.stop).not.toHaveBeenCalled();
		expect(result.status).toBe("nothing-running");
	});

	it("says the slot is not free yet when the job is still ending", async () => {
		deps.sleep.mockImplementation(async () => {});

		const result = await cancelActiveServiceDeployment(
			{ type: "application", applicationId: "app-1" },
			{ ...deps, waitMs: 1_000 },
		);

		expect(result).toMatchObject({ status: "cancelled", slotFree: false });
		// It never frees the slot by force: a restore may still be running.
		expect(deps.sleep).toHaveBeenCalled();
	});

	it("a job that is active before its deployment exists is 'starting'", async () => {
		deps.listRunning.mockResolvedValue([]);

		const result = await cancelActiveServiceDeployment(
			{ type: "application", applicationId: "app-1" },
			deps,
		);

		expect(result.status).toBe("starting");
		expect(deps.stop).not.toHaveBeenCalled();
	});

	it("nothing running and no job", async () => {
		deps.listRunning.mockResolvedValue([]);
		jobs = [];

		const result = await cancelActiveServiceDeployment(
			{ type: "application", applicationId: "app-1" },
			deps,
		);

		expect(result.status).toBe("nothing-running");
	});

	it("reports when nothing could be signalled", async () => {
		deps.stop.mockResolvedValue({
			method: "none",
			notRunning: false,
			claimedCancelled: false,
			warning: "no process handle",
		});

		const result = await cancelActiveServiceDeployment(
			{ type: "application", applicationId: "app-1" },
			deps,
		);

		expect(result).toEqual({
			status: "not-stopped",
			warnings: ["no process handle"],
		});
	});

	it("a deployment that ended before the stop reached it is not a cancel", async () => {
		deps.stop.mockResolvedValue({
			method: "none",
			notRunning: true,
			claimedCancelled: false,
		});

		const result = await cancelActiveServiceDeployment(
			{ type: "application", applicationId: "app-1" },
			deps,
		);

		expect(result.status).toBe("nothing-running");
	});

	it("notes a plain signal in the deployment log, on the host that holds it", async () => {
		deps.listRunning.mockResolvedValue([
			runningRow({ buildServerId: "srv-build" }),
		]);
		deps.logHost.mockResolvedValue("srv-build");
		deps.stop.mockResolvedValue({
			method: "pid",
			notRunning: false,
			claimedCancelled: false,
		});

		await cancelActiveServiceDeployment(
			{ type: "application", applicationId: "app-1" },
			deps,
		);

		expect(deps.appendLog).toHaveBeenCalledWith(
			"srv-build",
			"/logs/app/dep-1.log",
			expect.stringContaining("cancelled by user"),
		);
	});

	it("leaves the log note to the launcher, which writes its own", async () => {
		await cancelActiveServiceDeployment(
			{ type: "application", applicationId: "app-1" },
			deps,
		);

		expect(deps.appendLog).not.toHaveBeenCalled();
	});
});
