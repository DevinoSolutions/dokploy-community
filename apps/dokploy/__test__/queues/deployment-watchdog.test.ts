import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	createDeploymentWatchdog,
	findJobOf,
	type WatchdogDeps,
} from "../../server/queues/deployment-watchdog";
import type { InMemoryJob } from "../../server/queues/in-memory-queue";

/**
 * The stuck-deployment watchdog's decisions and side effects, with the queue,
 * the database, the hosts and the notifier replaced by fakes: when it fires,
 * what it stops and where, and what it leaves behind (row, log, slot, trail,
 * notification).
 */

const MIN = 60_000;
const START = Date.parse("2026-10-23T12:00:00.000Z");

type Row = Awaited<ReturnType<WatchdogDeps["listRunning"]>>[number];

const row = (overrides: Partial<Row> = {}): Row => ({
	deploymentId: "dep-1",
	title: "Deploy",
	logPath: "/logs/app/dep-1.log",
	pid: null,
	serverId: null,
	buildServerId: null,
	applicationId: "app-1",
	composeId: null,
	previewDeploymentId: null,
	startedAt: new Date(START).toISOString(),
	createdAt: new Date(START).toISOString(),
	...overrides,
});

const appJob = (
	id = "job-1",
	applicationId = "app-1",
	processedOn = START,
): InMemoryJob =>
	({
		id,
		journalId: `journal-${id}`,
		name: "deployments",
		timestamp: START,
		processedOn,
		data: {
			applicationId,
			titleLog: "t",
			descriptionLog: "",
			type: "deploy",
			applicationType: "application",
		},
	}) as unknown as InMemoryJob;

const composeJob = (id = "job-c", composeId = "comp-1"): InMemoryJob =>
	({
		id,
		journalId: `journal-${id}`,
		name: "deployments",
		timestamp: START,
		processedOn: START,
		data: {
			composeId,
			titleLog: "t",
			descriptionLog: "",
			type: "deploy",
			applicationType: "compose",
		},
	}) as unknown as InMemoryJob;

const context = {
	organizationId: "org-1",
	serviceName: "My App",
	appName: "app-abc123",
	projectName: "Proj",
	serviceType: "application" as const,
	serviceId: "app-1",
	buildLink: "https://dokploy.test/x",
};

let clock = START;
let config = {
	enabled: true,
	idleMinutes: 20,
	maxMinutes: 90,
	exclusions: [] as Array<{ type: "application" | "compose"; id: string }>,
};
let running: Row[] = [];
let jobs: InMemoryJob[] = [];
let idleMs: number | null = 0;
let logHost: string | null | undefined = null;

// Loosely typed on purpose: the cases below return many shapes from one fake.
type AnyMock = Mock<(...args: any[]) => any>;
const deps: Record<
	Exclude<keyof WatchdogDeps, "releaseGraceMs" | "wedgedAfterMs">,
	AnyMock
> = {
	now: vi.fn(() => clock),
	loadConfig: vi.fn(async () => config),
	activeJobs: vi.fn(async () => jobs),
	releaseJob: vi.fn((id: string) => {
		const had = jobs.some((job) => job.id === id);
		jobs = jobs.filter((job) => job.id !== id);
		return had;
	}),
	listRunning: vi.fn(async () => running),
	latestDeploys: vi.fn(async () => [] as never[]),
	resolveService: vi.fn(async (r: Row) => ({
		applicationId: r.applicationId,
		composeId: r.composeId,
	})),
	readLogIdleMs: vi.fn(async () => idleMs),
	logHost: vi.fn(async () => logHost),
	appendLog: vi.fn(async () => {}),
	stop: vi.fn(async () => ({
		method: "launcher" as const,
		notRunning: false,
		claimedCancelled: true,
	})),
	// Like the real one, it takes the row out of the running set.
	markFailed: vi.fn(async (deploymentId: string) => {
		running = running.filter((r) => r.deploymentId !== deploymentId);
		return true;
	}),
	failServiceIfRunning: vi.fn(async () => {}),
	loadContext: vi.fn(async () => context),
	notify: vi.fn(async () => {}),
	recordAudit: vi.fn(async () => {}),
};
const asDeps = deps as unknown as WatchdogDeps;

const logLines = () =>
	deps.appendLog.mock.calls.map((call) => (call as unknown[])[2] as string);

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	clock = START;
	config = { enabled: true, idleMinutes: 20, maxMinutes: 90, exclusions: [] };
	running = [row()];
	jobs = [appJob()];
	idleMs = 0;
	logHost = null;
	deps.stop.mockResolvedValue({
		method: "launcher",
		notRunning: false,
		claimedCancelled: true,
	});
	deps.markFailed.mockImplementation(async (deploymentId: string) => {
		running = running.filter((r) => r.deploymentId !== deploymentId);
		return true;
	});
	deps.latestDeploys.mockResolvedValue([] as never[]);
	deps.releaseJob.mockImplementation((id: string) => {
		const had = jobs.some((job) => job.id === id);
		jobs = jobs.filter((job) => job.id !== id);
		return had;
	});
});

describe("when it fires", () => {
	it("fails a deployment whose log was silent for longer than the idle limit", async () => {
		clock = START + 30 * MIN;
		idleMs = 21 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).toHaveBeenCalledTimes(1);
		expect(logLines()[0]).toBe("Watchdog: no log output for 20 min");
	});

	it("fails a deployment that ran longer than the wall limit, even with a fresh log", async () => {
		clock = START + 91 * MIN;
		idleMs = 1_000;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).toHaveBeenCalledTimes(1);
		expect(logLines()[0]).toBe("Watchdog: exceeded 90 min");
		// The wall limit needs no look at the log.
		expect(deps.readLogIdleMs).not.toHaveBeenCalled();
	});

	it("leaves a deployment alone while its log keeps growing", async () => {
		clock = START + 60 * MIN;
		idleMs = 2 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).not.toHaveBeenCalled();
		expect(deps.markFailed).not.toHaveBeenCalled();
		expect(deps.appendLog).not.toHaveBeenCalled();
	});

	it("does not fail a deployment on a guess when the log cannot be read", async () => {
		clock = START + 60 * MIN;
		idleMs = null;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).not.toHaveBeenCalled();
	});

	it("honours changed limits", async () => {
		config = { ...config, idleMinutes: 5, maxMinutes: 15 };
		clock = START + 6 * MIN;
		idleMs = 6 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(logLines()[0]).toBe("Watchdog: no log output for 5 min");
	});

	it("does nothing when disabled", async () => {
		config = { ...config, enabled: false };
		clock = START + 200 * MIN;
		idleMs = 200 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.listRunning).not.toHaveBeenCalled();
		expect(deps.stop).not.toHaveBeenCalled();
	});
});

describe("exclusions", () => {
	it("never fails an excluded application", async () => {
		config = {
			...config,
			exclusions: [{ type: "application", id: "app-1" }],
		};
		clock = START + 500 * MIN;
		idleMs = 500 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).not.toHaveBeenCalled();
		expect(deps.markFailed).not.toHaveBeenCalled();
		expect(deps.releaseJob).not.toHaveBeenCalled();
	});

	it("never fails an excluded compose, but still fails other services", async () => {
		config = { ...config, exclusions: [{ type: "compose", id: "comp-1" }] };
		running = [
			row({ deploymentId: "dep-c", applicationId: null, composeId: "comp-1" }),
			row({ deploymentId: "dep-a", applicationId: "app-2" }),
		];
		jobs = [composeJob(), appJob("job-2", "app-2")];
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).toHaveBeenCalledTimes(1);
		expect(deps.stop.mock.calls[0]?.[0]).toMatchObject({
			deploymentId: "dep-a",
		});
	});

	it("an application id on the list does not exclude a compose with the same id", async () => {
		config = { ...config, exclusions: [{ type: "application", id: "same" }] };
		running = [
			row({ applicationId: null, composeId: "same", deploymentId: "dep-c" }),
		];
		jobs = [composeJob("job-c", "same")];
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).toHaveBeenCalledTimes(1);
	});

	it("excludes a preview deployment through its service", async () => {
		config = {
			...config,
			exclusions: [{ type: "application", id: "app-1" }],
		};
		running = [row({ applicationId: null, previewDeploymentId: "prev-1" })];
		deps.resolveService.mockResolvedValueOnce({
			applicationId: "app-1",
			composeId: null,
		});
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).not.toHaveBeenCalled();
	});
});

describe("what it records once the job has ended", () => {
	const fireIdle = async () => {
		clock = START + 30 * MIN;
		idleMs = 25 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		return watchdog;
	};

	it("waits for the job to end before it marks the row, then does it once", async () => {
		const watchdog = await fireIdle();
		expect(deps.markFailed).not.toHaveBeenCalled();
		expect(watchdog.pendingCount()).toBe(1);

		// The deploy flow ended its job (its cancel handling ran).
		jobs = [];
		running = [];
		clock += MIN;
		await watchdog.sweep();

		expect(deps.markFailed).toHaveBeenCalledTimes(1);
		expect(deps.markFailed.mock.calls[0]).toEqual([
			"dep-1",
			expect.stringContaining("Watchdog: no log output for 20 min"),
		]);
		expect(logLines()).toEqual([
			"Watchdog: no log output for 20 min",
			"Watchdog: marked failed",
		]);
		expect(deps.releaseJob).not.toHaveBeenCalled();
		expect(watchdog.pendingCount()).toBe(0);

		// Nothing more on the next pass.
		clock += MIN;
		await watchdog.sweep();
		expect(deps.markFailed).toHaveBeenCalledTimes(1);
	});

	it("sends the failure notification once, with the service context", async () => {
		const watchdog = await fireIdle();
		jobs = [];
		running = [];
		clock += MIN;
		await watchdog.sweep();

		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.notify).toHaveBeenCalledWith(
			expect.objectContaining({ deploymentId: "dep-1" }),
			null,
			context,
			"Watchdog: no log output for 20 min; marked failed",
		);
	});

	it("does not notify again when the deploy flow already failed the row", async () => {
		const watchdog = await fireIdle();
		deps.markFailed.mockResolvedValueOnce(false);
		jobs = [];
		running = [];
		clock += MIN;
		await watchdog.sweep();

		expect(deps.notify).not.toHaveBeenCalled();
		// Still on the trail.
		expect(deps.recordAudit).toHaveBeenCalledTimes(1);
	});

	it("records the trail entry with the system as the actor", async () => {
		const watchdog = await fireIdle();
		jobs = [];
		running = [];
		clock += MIN;
		await watchdog.sweep();

		expect(deps.recordAudit).toHaveBeenCalledTimes(1);
		expect(deps.recordAudit).toHaveBeenCalledWith({
			organizationId: "org-1",
			action: "watchdog_fail",
			actor: { type: "system" },
			targetType: "deployment",
			targetId: "dep-1",
			targetName: "app-abc123",
			applicationId: "app-1",
			composeId: null,
			deploymentId: "dep-1",
			metadata: expect.objectContaining({
				reason: "idle",
				thresholdMinutes: 20,
				observedMinutes: 25,
				stop: "launcher",
				slotReleased: false,
				notified: true,
			}),
		});
	});

	it("names a compose in the trail entry", async () => {
		running = [
			row({ deploymentId: "dep-c", applicationId: null, composeId: "comp-1" }),
		];
		jobs = [composeJob()];
		deps.loadContext.mockResolvedValue({
			...context,
			serviceType: "compose" as never,
			serviceId: "comp-1",
		});
		const watchdog = await fireIdle();
		jobs = [];
		running = [];
		clock += MIN;
		await watchdog.sweep();
		deps.loadContext.mockResolvedValue(context);

		expect(deps.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: null,
				composeId: "comp-1",
				deploymentId: "dep-c",
			}),
		);
	});

	it("an unreadable service still marks the row failed", async () => {
		const watchdog = await fireIdle();
		deps.loadContext.mockResolvedValueOnce(null as never);
		jobs = [];
		running = [];
		clock += MIN;
		await watchdog.sweep();

		expect(deps.markFailed).toHaveBeenCalledTimes(1);
		expect(deps.notify).not.toHaveBeenCalled();
	});
});

describe("queue slot", () => {
	it("does not release the slot while the stopped job is still ending", async () => {
		clock = START + 30 * MIN;
		idleMs = 25 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();

		// The compose is still restoring its previous release.
		clock += 5 * MIN;
		await watchdog.sweep();

		expect(deps.releaseJob).not.toHaveBeenCalled();
		expect(deps.markFailed).not.toHaveBeenCalled();
		expect(watchdog.pendingCount()).toBe(1);
	});

	it("releases the slot of a job that did not end after the grace period", async () => {
		deps.stop.mockResolvedValue({
			method: "none",
			notRunning: false,
			claimedCancelled: false,
			warning: "no process handle",
		});
		clock = START + 30 * MIN;
		idleMs = 25 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		expect(logLines()).toContain("Watchdog: no process handle");

		clock += 11 * MIN;
		await watchdog.sweep();

		expect(deps.releaseJob).toHaveBeenCalledWith("job-1");
		// The service goes to error unless the flow already settled it.
		expect(deps.failServiceIfRunning).toHaveBeenCalledTimes(1);
		expect(deps.markFailed).toHaveBeenCalledTimes(1);
		expect(logLines()).toContain(
			"Watchdog: the deployment did not end after it was stopped; its queue slot was released",
		);
		expect(deps.recordAudit.mock.calls[0]?.[0]).toMatchObject({
			metadata: expect.objectContaining({ slotReleased: true, stop: "none" }),
		});
		expect(watchdog.pendingCount()).toBe(0);
	});

	it("a stopped deployment with no job in the queue is closed at once", async () => {
		jobs = [];
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.markFailed).toHaveBeenCalledTimes(1);
		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.releaseJob).not.toHaveBeenCalled();
		expect(watchdog.pendingCount()).toBe(0);
	});

	it("a deployment that ended before the stop reached it is closed without a release", async () => {
		deps.stop.mockResolvedValue({
			method: "none",
			notRunning: true,
			claimedCancelled: false,
		});
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.releaseJob).not.toHaveBeenCalled();
		expect(deps.markFailed).toHaveBeenCalledTimes(1);
	});

	it("does not stop a deployment twice while its stop is pending", async () => {
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		clock += MIN;
		await watchdog.sweep();

		expect(deps.stop).toHaveBeenCalledTimes(1);
	});
});

describe("which host", () => {
	it("hands the whole row to the stop so it can target the right host", async () => {
		running = [row({ serverId: "srv-serving", buildServerId: "srv-build" })];
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).toHaveBeenCalledWith(
			expect.objectContaining({
				serverId: "srv-serving",
				buildServerId: "srv-build",
			}),
		);
	});

	it("writes the watchdog lines to the host that holds the log", async () => {
		logHost = "srv-build";
		running = [row({ buildServerId: "srv-build" })];
		clock = START + 30 * MIN;
		idleMs = 25 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		jobs = [];
		running = [];
		clock += MIN;
		await watchdog.sweep();

		const hosts = deps.appendLog.mock.calls.map(
			(call) => (call as unknown[])[0],
		);
		expect(hosts).toEqual(["srv-build", "srv-build"]);
		expect(deps.notify).toHaveBeenCalledWith(
			expect.anything(),
			"srv-build",
			context,
			expect.any(String),
		);
	});

	it("falls back to the build server, then the serving server, when the log host is unknown", async () => {
		logHost = undefined;
		running = [row({ serverId: "srv-serving", buildServerId: null })];
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect((deps.appendLog.mock.calls[0] as unknown[])[0]).toBe("srv-serving");
	});
});

describe("a stop that fails", () => {
	it("is written to the log and the deployment is still closed", async () => {
		deps.stop.mockRejectedValue(new Error("ssh refused"));
		jobs = [];
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(logLines()).toContain(
			"Watchdog: Could not stop the work: ssh refused",
		);
		expect(deps.markFailed).toHaveBeenCalledTimes(1);
	});

	it("one failing check does not block the others", async () => {
		running = [
			row({ deploymentId: "dep-x", applicationId: "app-x" }),
			row({ deploymentId: "dep-y", applicationId: "app-y" }),
		];
		jobs = [appJob("job-x", "app-x"), appJob("job-y", "app-y")];
		deps.resolveService.mockRejectedValueOnce(new Error("db down"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).toHaveBeenCalledTimes(1);
	});
});

describe("jobs that hang with no running deployment", () => {
	it("releases a job whose deployment ended long ago", async () => {
		running = [];
		jobs = [appJob()];
		deps.latestDeploys.mockResolvedValue([
			{
				status: "done",
				createdAt: new Date(START).toISOString(),
				finishedAt: new Date(START + 10 * MIN).toISOString(),
			},
		] as never[]);
		clock = START + 30 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.releaseJob).toHaveBeenCalledWith("job-1");
		expect(deps.recordAudit.mock.calls[0]?.[0]).toMatchObject({
			action: "watchdog_fail",
			actor: { type: "system" },
			targetType: "application",
			metadata: expect.objectContaining({
				reason: "hung-job",
				slotReleased: true,
			}),
		});
	});

	it("leaves a job whose deployment ended a moment ago", async () => {
		running = [];
		deps.latestDeploys.mockResolvedValue([
			{
				status: "done",
				createdAt: new Date(START).toISOString(),
				finishedAt: new Date(START + 10 * MIN).toISOString(),
			},
		] as never[]);
		clock = START + 12 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.releaseJob).not.toHaveBeenCalled();
	});

	it("releases a job that never created a deployment once it passes the wall limit", async () => {
		running = [];
		deps.latestDeploys.mockResolvedValue([] as never[]);
		clock = START + 91 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.releaseJob).toHaveBeenCalledWith("job-1");
	});

	it("leaves a young job that has no deployment yet", async () => {
		running = [];
		deps.latestDeploys.mockResolvedValue([] as never[]);
		clock = START + 5 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.releaseJob).not.toHaveBeenCalled();
	});

	it("never touches the job of an excluded service", async () => {
		config = { ...config, exclusions: [{ type: "application", id: "app-1" }] };
		running = [];
		clock = START + 500 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.releaseJob).not.toHaveBeenCalled();
	});
});

describe("findJobOf", () => {
	it("matches a deploy to the active job of the same service and kind", () => {
		const list = [appJob("a", "app-1"), composeJob("c", "comp-1")];
		expect(findJobOf(row(), list)?.id).toBe("a");
		expect(
			findJobOf(row({ applicationId: null, composeId: "comp-1" }), list)?.id,
		).toBe("c");
		expect(findJobOf(row({ applicationId: "other" }), list)).toBeNull();
	});

	it("a preview deploy matches only its preview job", () => {
		const preview = {
			...appJob("p", "app-1"),
			data: {
				applicationId: "app-1",
				previewDeploymentId: "prev-1",
				applicationType: "application-preview",
				type: "deploy",
				titleLog: "t",
				descriptionLog: "",
			},
		} as unknown as InMemoryJob;
		expect(
			findJobOf(row({ applicationId: null, previewDeploymentId: "prev-1" }), [
				preview,
			])?.id,
		).toBe("p");
		// The service's own deploy is not the preview's job.
		expect(findJobOf(row(), [preview])).toBeNull();
	});
});

describe("a sweep that is still running", () => {
	it("is not doubled by the next tick", async () => {
		let release!: () => void;
		deps.loadConfig.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve(config);
				}),
		);
		const watchdog = createDeploymentWatchdog(asDeps);

		const first = watchdog.sweep();
		await watchdog.sweep();
		expect(deps.loadConfig).toHaveBeenCalledTimes(1);
		release();
		await first;
	});

	it("never throws", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		deps.loadConfig.mockRejectedValueOnce(new Error("db down"));
		const watchdog = createDeploymentWatchdog(asDeps);

		await expect(watchdog.sweep()).resolves.toBeUndefined();
	});
});
