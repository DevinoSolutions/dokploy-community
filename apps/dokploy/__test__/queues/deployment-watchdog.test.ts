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
/** Released jobs that still hold their service lock (what the queue keeps). */
let keptLocks = new Set<string>();
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
	releaseJob: vi.fn((id: string, options?: { keepGroupLock?: boolean }) => {
		const had = jobs.some((job) => job.id === id);
		jobs = jobs.filter((job) => job.id !== id);
		if (had && options?.keepGroupLock) keptLocks.add(id);
		return had;
	}),
	hasKeptGroupLock: vi.fn((id: string) => keptLocks.has(id)),
	dropKeptGroupLock: vi.fn((id: string) => keptLocks.delete(id)),
	markDeploymentReleased: vi.fn(),
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
	readStatus: vi.fn(async () => "running" as string | null),
	// Like the real one, it takes the row out of the running set.
	markFailed: vi.fn(async (deploymentId: string) => {
		running = running.filter((r) => r.deploymentId !== deploymentId);
		return "flipped";
	}),
	failServiceIfRunning: vi.fn(async () => {}),
	loadContext: vi.fn(async () => context),
	notify: vi.fn(async () => {}),
	recordAudit: vi.fn(async () => {}),
};
const asDeps = deps as unknown as WatchdogDeps;

/**
 * Silence is only acted on when it is seen on two consecutive sweeps: this runs
 * both, a minute apart, like the interval does.
 */
const sweepTwice = async (watchdog: { sweep: () => Promise<void> }) => {
	await watchdog.sweep();
	clock += MIN;
	await watchdog.sweep();
};

const logLines = () =>
	deps.appendLog.mock.calls.map((call) => (call as unknown[])[2] as string);

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	clock = START;
	keptLocks = new Set();
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
	deps.readStatus.mockResolvedValue("running");
	deps.readLogIdleMs.mockImplementation(async () => idleMs);
	deps.markFailed.mockImplementation(async (deploymentId: string) => {
		running = running.filter((r) => r.deploymentId !== deploymentId);
		return "flipped";
	});
	deps.latestDeploys.mockResolvedValue([] as never[]);
	deps.releaseJob.mockImplementation(
		(id: string, options?: { keepGroupLock?: boolean }) => {
			const had = jobs.some((job) => job.id === id);
			jobs = jobs.filter((job) => job.id !== id);
			if (had && options?.keepGroupLock) keptLocks.add(id);
			return had;
		},
	);
	deps.hasKeptGroupLock.mockImplementation((id: string) => keptLocks.has(id));
	deps.dropKeptGroupLock.mockImplementation((id: string) =>
		keptLocks.delete(id),
	);
});

describe("when it fires", () => {
	it("fails a deployment whose log was silent for longer than the idle limit", async () => {
		clock = START + 30 * MIN;
		idleMs = 21 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await sweepTwice(watchdog);

		expect(deps.stop).toHaveBeenCalledTimes(1);
		expect(logLines()[0]).toBe("Watchdog: no log output for 20 min");
	});

	it("does not act on silence it has seen only once", async () => {
		clock = START + 30 * MIN;
		idleMs = 21 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).not.toHaveBeenCalled();
		expect(deps.appendLog).not.toHaveBeenCalled();
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
		config = { ...config, idleMinutes: 15, maxMinutes: 40 };
		clock = START + 20 * MIN;
		idleMs = 16 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await sweepTwice(watchdog);

		expect(logLines()[0]).toBe("Watchdog: no log output for 15 min");
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
		await sweepTwice(watchdog);
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
			{ claimedCancel: true },
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
		deps.markFailed.mockResolvedValueOnce("already-error");
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
		await sweepTwice(watchdog);

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
		await sweepTwice(watchdog);
		expect(logLines()).toContain("Watchdog: no process handle");

		clock += 11 * MIN;
		await watchdog.sweep();

		// Nothing could be stopped: the slot is freed, the service stays locked.
		expect(deps.releaseJob).toHaveBeenCalledWith("job-1", {
			keepGroupLock: true,
		});
		// The service goes to error unless the flow already settled it.
		expect(deps.failServiceIfRunning).toHaveBeenCalledTimes(1);
		expect(deps.markFailed).toHaveBeenCalledTimes(1);
		expect(logLines().join("\n")).toContain(
			"this service stays locked (no new deploy of it starts) until the old process ends or Dokploy restarts",
		);
		expect(deps.recordAudit.mock.calls[0]?.[0]).toMatchObject({
			metadata: expect.objectContaining({
				slotReleased: true,
				groupLockKept: true,
				stop: "none",
			}),
		});
		expect(watchdog.pendingCount()).toBe(0);
	});

	it("frees the slot completely when the process was signalled but did not end", async () => {
		deps.stop.mockResolvedValue({
			method: "pid",
			notRunning: false,
			claimedCancelled: false,
		});
		clock = START + 30 * MIN;
		idleMs = 25 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await sweepTwice(watchdog);

		clock += 11 * MIN;
		await watchdog.sweep();

		expect(deps.releaseJob).toHaveBeenCalledWith("job-1", {
			keepGroupLock: false,
		});
		expect(logLines().join("\n")).toContain("its queue slot was released");
	});

	it("settles the row and the service BEFORE it frees the slot", async () => {
		deps.stop.mockResolvedValue({
			method: "none",
			notRunning: false,
			claimedCancelled: false,
		});
		clock = START + 30 * MIN;
		idleMs = 25 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await sweepTwice(watchdog);
		clock += 11 * MIN;
		await watchdog.sweep();

		const order = (mock: AnyMock) => mock.mock.invocationCallOrder[0] ?? 0;
		// Freeing the slot starts the next job at once: nothing may touch its
		// service after that.
		expect(order(deps.failServiceIfRunning)).toBeLessThan(
			order(deps.releaseJob),
		);
		expect(order(deps.markFailed)).toBeLessThan(order(deps.releaseJob));
		expect(order(deps.notify)).toBeLessThan(order(deps.releaseJob));
		expect(order(deps.recordAudit)).toBeLessThan(order(deps.releaseJob));
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
			{},
		);
	});

	it("writes the watchdog lines to the host that holds the log", async () => {
		logHost = "srv-build";
		running = [row({ buildServerId: "srv-build" })];
		clock = START + 30 * MIN;
		idleMs = 25 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await sweepTwice(watchdog);
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

		// Stuck after the work: nothing runs any more, so no lock is kept.
		expect(deps.releaseJob).toHaveBeenCalledWith("job-1", {
			keepGroupLock: false,
		});
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

		// No deployment at all: whatever it runs was never stopped, so the
		// service stays locked.
		expect(deps.releaseJob).toHaveBeenCalledWith("job-1", {
			keepGroupLock: true,
		});
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

describe("checks before anything is stopped", () => {
	it("a log that moved between the two sweeps starts the count again", async () => {
		clock = START + 30 * MIN;
		idleMs = 25 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();

		idleMs = 1 * MIN;
		clock += MIN;
		await watchdog.sweep();
		expect(deps.stop).not.toHaveBeenCalled();

		// Silent again: the first sighting only.
		idleMs = 25 * MIN;
		clock += MIN;
		await watchdog.sweep();
		expect(deps.stop).not.toHaveBeenCalled();
	});

	it("reads the log again right before the stop, and a log that moved is left alone", async () => {
		clock = START + 30 * MIN;
		// Sweep 1 and the idle read of sweep 2 see silence; the re-read just
		// before the stop sees output.
		deps.readLogIdleMs
			.mockResolvedValueOnce(25 * MIN)
			.mockResolvedValueOnce(25 * MIN)
			.mockResolvedValueOnce(2 * 1000);
		const watchdog = createDeploymentWatchdog(asDeps);

		await sweepTwice(watchdog);

		expect(deps.readLogIdleMs).toHaveBeenCalledTimes(3);
		expect(deps.stop).not.toHaveBeenCalled();
		// No false claim in the log either.
		expect(deps.appendLog).not.toHaveBeenCalled();
	});

	it("reads the row status again, and a deployment that ended meanwhile is left alone", async () => {
		clock = START + 100 * MIN;
		deps.readStatus.mockResolvedValue("done");
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.readStatus).toHaveBeenCalledWith("dep-1");
		expect(deps.stop).not.toHaveBeenCalled();
		expect(deps.appendLog).not.toHaveBeenCalled();
		expect(deps.markFailed).not.toHaveBeenCalled();
	});

	it("only writes the 'no log output' line after the re-check passed", async () => {
		clock = START + 30 * MIN;
		idleMs = 25 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await sweepTwice(watchdog);

		const order = (mock: AnyMock) => mock.mock.invocationCallOrder[0] ?? 0;
		expect(order(deps.readStatus)).toBeLessThan(order(deps.appendLog));
		expect(order(deps.appendLog)).toBeLessThan(order(deps.stop));
	});
});

describe("a leftover running row", () => {
	it("is not bound to the healthy job of its service: nothing is stopped, marked or released", async () => {
		// The job started an hour after this row was created.
		running = [
			row({ createdAt: new Date(START - 3 * 60 * MIN).toISOString() }),
		];
		jobs = [appJob("job-1", "app-1", START)];
		// The job's own deploy is running, the leftover row is an older one.
		deps.latestDeploys.mockResolvedValue([
			{
				status: "running",
				createdAt: new Date(START + MIN).toISOString(),
				finishedAt: null,
			},
		] as never[]);
		clock = START + 200 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();
		await watchdog.sweep();

		expect(deps.stop).not.toHaveBeenCalled();
		expect(deps.markFailed).not.toHaveBeenCalled();
		expect(deps.failServiceIfRunning).not.toHaveBeenCalled();
		expect(deps.releaseJob).not.toHaveBeenCalled();
		expect(deps.recordAudit).not.toHaveBeenCalled();
	});

	it("does not make the healthy job look hung either", async () => {
		running = [
			row({ createdAt: new Date(START - 3 * 60 * MIN).toISOString() }),
		];
		jobs = [appJob("job-1", "app-1", START)];
		deps.latestDeploys.mockResolvedValue([
			{
				status: "running",
				createdAt: new Date(START + MIN).toISOString(),
				finishedAt: null,
			},
		] as never[]);
		clock = START + 30 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.releaseJob).not.toHaveBeenCalled();
	});

	it("a row created just after the job started is its deployment", async () => {
		running = [row({ createdAt: new Date(START + 5 * 1000).toISOString() })];
		jobs = [appJob("job-1", "app-1", START)];
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).toHaveBeenCalledTimes(1);
	});

	it("is also skipped when the job is restarted between the sweep and the stop", async () => {
		clock = START + 100 * MIN;
		// The re-read of the queue before the stop shows a newer job of the service.
		deps.activeJobs
			.mockResolvedValueOnce(jobs)
			.mockResolvedValueOnce([appJob("job-2", "app-1", START + 99 * MIN)]);
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).not.toHaveBeenCalled();
	});
});

describe("a row that ended some other way", () => {
	it("is not claimed as a watchdog failure: no log line, no notification, no trail", async () => {
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		deps.appendLog.mockClear();
		// A person cancelled it while the stop was on its way.
		// The person's cancel already ended the row, so it is no longer running.
		deps.markFailed.mockImplementationOnce(async (id: string) => {
			running = running.filter((r) => r.deploymentId !== id);
			return "unchanged";
		});
		jobs = [];
		clock += MIN;
		await watchdog.sweep();

		expect(deps.appendLog).not.toHaveBeenCalled();
		expect(deps.notify).not.toHaveBeenCalled();
		expect(deps.recordAudit).not.toHaveBeenCalled();
		expect(deps.failServiceIfRunning).not.toHaveBeenCalled();
	});

	it("still frees the slot of a job that is hung past the grace period", async () => {
		deps.stop.mockResolvedValue({
			method: "pid",
			notRunning: false,
			claimedCancelled: false,
		});
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		deps.markFailed.mockImplementationOnce(async (id: string) => {
			running = running.filter((r) => r.deploymentId !== id);
			return "unchanged";
		});
		clock += 11 * MIN;
		await watchdog.sweep();

		expect(deps.releaseJob).toHaveBeenCalledWith("job-1", {
			keepGroupLock: false,
		});
		expect(deps.notify).not.toHaveBeenCalled();
	});

	it("tells the row whether the watchdog itself claimed the cancel", async () => {
		deps.stop.mockResolvedValue({
			method: "pid",
			notRunning: false,
			claimedCancelled: false,
		});
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		jobs = [];
		clock += MIN;
		await watchdog.sweep();

		// A cancelled row is only taken over when the launcher cancelled it for us.
		expect(deps.markFailed.mock.calls[0]?.[2]).toEqual({
			claimedCancel: false,
		});
	});
});

describe("a running row that no job runs (orphan)", () => {
	it("is only marked failed: the stop may use the launcher and nothing else", async () => {
		jobs = [];
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).toHaveBeenCalledTimes(1);
		expect(deps.stop.mock.calls[0]?.[1]).toEqual({ launcherOnly: true });
		expect(deps.markFailed).toHaveBeenCalledTimes(1);
		// No job, so no slot to release and no lock to keep.
		expect(deps.releaseJob).not.toHaveBeenCalled();
		expect(watchdog.pendingCount()).toBe(0);
	});

	it("is closed with the same outcome rules as any other row", async () => {
		jobs = [];
		deps.markFailed.mockImplementationOnce(async (id: string) => {
			running = running.filter((r) => r.deploymentId !== id);
			return "unchanged";
		});
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(logLines()).not.toContain("Watchdog: marked failed");
		expect(deps.notify).not.toHaveBeenCalled();
		expect(deps.recordAudit).not.toHaveBeenCalled();
	});

	it("tells the log that no process was signalled", async () => {
		jobs = [];
		deps.stop.mockResolvedValue({
			method: "none",
			notRunning: false,
			claimedCancelled: false,
			warning: "no process was signalled",
		});
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(logLines().join("\n")).toContain("no process was signalled");
		expect(deps.markFailed).toHaveBeenCalledTimes(1);
	});

	it("a row with a job of its own service still gets the full stop", async () => {
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop.mock.calls[0]?.[1]).toEqual({});
	});
});

describe("a stop that found no handle because the host was busy", () => {
	const busy = {
		method: "none" as const,
		notRunning: false,
		claimedCancelled: false,
		warning: "2 other deploys run on the same host",
		retryable: true,
	};

	it("is tried again on the next sweep, and the slot is not released when it works", async () => {
		deps.stop.mockResolvedValueOnce(busy);
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		expect(deps.stop).toHaveBeenCalledTimes(1);

		// The others have ended: the generic stop is safe now.
		deps.stop.mockResolvedValueOnce({
			method: "generic",
			notRunning: false,
			claimedCancelled: false,
		});
		clock += MIN;
		await watchdog.sweep();

		expect(deps.stop).toHaveBeenCalledTimes(2);
		expect(logLines().join("\n")).toContain(
			"had ended, so the build was stopped",
		);
		expect(deps.releaseJob).not.toHaveBeenCalled();
		expect(watchdog.pendingCount()).toBe(1);
	});

	it("gets a fresh grace period after the later stop", async () => {
		deps.stop.mockResolvedValueOnce(busy);
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		clock += 9 * MIN;
		deps.stop.mockResolvedValueOnce({
			method: "generic",
			notRunning: false,
			claimedCancelled: false,
		});
		await watchdog.sweep();

		// 11 min after the first stop, but only 2 after the one that worked.
		clock += 2 * MIN;
		await watchdog.sweep();
		expect(deps.releaseJob).not.toHaveBeenCalled();

		clock += 9 * MIN;
		await watchdog.sweep();
		expect(deps.releaseJob).toHaveBeenCalledWith("job-1", {
			keepGroupLock: false,
		});
	});

	it("keeps asking each sweep while the host is busy, then releases with the lock kept", async () => {
		deps.stop.mockResolvedValue(busy);
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		clock += MIN;
		await watchdog.sweep();
		clock += MIN;
		await watchdog.sweep();
		expect(deps.stop).toHaveBeenCalledTimes(3);
		expect(deps.releaseJob).not.toHaveBeenCalled();

		clock += 10 * MIN;
		await watchdog.sweep();

		expect(deps.releaseJob).toHaveBeenCalledWith("job-1", {
			keepGroupLock: true,
		});
	});

	it("does not ask again when the row is no longer running", async () => {
		deps.stop.mockResolvedValueOnce(busy);
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		deps.readStatus.mockResolvedValue("done");

		clock += MIN;
		await watchdog.sweep();

		expect(deps.stop).toHaveBeenCalledTimes(1);
	});

	it("stops asking once the reason is no longer a busy host", async () => {
		deps.stop.mockResolvedValueOnce(busy);
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		deps.stop.mockResolvedValueOnce({
			method: "none",
			notRunning: false,
			claimedCancelled: false,
			warning: "could not signal",
		});
		clock += MIN;
		await watchdog.sweep();
		clock += MIN;
		await watchdog.sweep();

		expect(deps.stop).toHaveBeenCalledTimes(2);
	});
});

describe("a kept service lock", () => {
	const keepLock = async (
		watchdog: ReturnType<typeof createDeploymentWatchdog>,
	) => {
		deps.stop.mockResolvedValue({
			method: "none",
			notRunning: false,
			claimedCancelled: false,
		});
		clock = START + 100 * MIN;
		await watchdog.sweep();
		clock += 11 * MIN;
		await watchdog.sweep();
		expect(keptLocks.has("job-1")).toBe(true);
		return clock;
	};

	it("is dropped after max(2 x wall limit, 3 h), with a loud log line and an audit entry", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const watchdog = createDeploymentWatchdog(asDeps);
		const releasedAt = await keepLock(watchdog);
		deps.recordAudit.mockClear();

		clock = releasedAt + 179 * MIN;
		await watchdog.sweep();
		expect(deps.dropKeptGroupLock).not.toHaveBeenCalled();

		clock = releasedAt + 181 * MIN;
		await watchdog.sweep();

		expect(deps.dropKeptGroupLock).toHaveBeenCalledWith("job-1");
		expect(keptLocks.has("job-1")).toBe(false);
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("service lock was dropped"),
		);
		expect(logLines().join("\n")).toContain(
			"the lock on this service was dropped",
		);
		expect(deps.recordAudit.mock.calls[0]?.[0]).toMatchObject({
			action: "watchdog_fail",
			actor: { type: "system" },
			metadata: expect.objectContaining({
				reason: "group-lock-dropped",
				groupLockDropped: true,
				jobId: "job-1",
			}),
		});
	});

	it("is dropped only once", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const watchdog = createDeploymentWatchdog(asDeps);
		const releasedAt = await keepLock(watchdog);

		clock = releasedAt + 200 * MIN;
		await watchdog.sweep();
		clock += 10 * MIN;
		await watchdog.sweep();

		expect(deps.dropKeptGroupLock).toHaveBeenCalledTimes(1);
	});

	it("follows twice the wall limit when that is longer than 3 h", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		config = { ...config, maxMinutes: 200 };
		const watchdog = createDeploymentWatchdog(asDeps);
		deps.stop.mockResolvedValue({
			method: "none",
			notRunning: false,
			claimedCancelled: false,
		});
		clock = START + 250 * MIN;
		await watchdog.sweep();
		clock += 11 * MIN;
		await watchdog.sweep();
		const releasedAt = clock;

		clock = releasedAt + 399 * MIN;
		await watchdog.sweep();
		expect(deps.dropKeptGroupLock).not.toHaveBeenCalled();

		clock = releasedAt + 401 * MIN;
		await watchdog.sweep();
		expect(deps.dropKeptGroupLock).toHaveBeenCalledTimes(1);
	});

	it("is left alone once the old process returned and took the lock with it", async () => {
		const watchdog = createDeploymentWatchdog(asDeps);
		const releasedAt = await keepLock(watchdog);
		deps.recordAudit.mockClear();
		keptLocks.delete("job-1");

		clock = releasedAt + 400 * MIN;
		await watchdog.sweep();

		expect(deps.dropKeptGroupLock).not.toHaveBeenCalled();
		expect(deps.recordAudit).not.toHaveBeenCalled();
	});

	it("is also dropped for a hung job that never had a deployment", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		running = [];
		clock = START + 91 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		expect(keptLocks.has("job-1")).toBe(true);

		clock += 181 * MIN;
		await watchdog.sweep();

		expect(deps.dropKeptGroupLock).toHaveBeenCalledWith("job-1");
	});

	it("is still dropped when the watchdog was switched off meanwhile", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const watchdog = createDeploymentWatchdog(asDeps);
		const releasedAt = await keepLock(watchdog);
		config = { ...config, enabled: false };

		clock = releasedAt + 181 * MIN;
		await watchdog.sweep();

		expect(deps.dropKeptGroupLock).toHaveBeenCalledTimes(1);
	});
});

describe("the slot is released even when the bookkeeping fails", () => {
	it("releases it when marking the row failed throws", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		deps.stop.mockResolvedValue({
			method: "pid",
			notRunning: false,
			claimedCancelled: false,
		});
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		deps.markFailed.mockRejectedValueOnce(new Error("db down"));

		clock += 11 * MIN;
		await watchdog.sweep();

		expect(deps.releaseJob).toHaveBeenCalledWith("job-1", {
			keepGroupLock: false,
		});
		expect(watchdog.pendingCount()).toBe(0);
	});

	it("keeps the lock of a job nothing could stop, even when marking fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		deps.stop.mockResolvedValue({
			method: "none",
			notRunning: false,
			claimedCancelled: false,
		});
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		deps.markFailed.mockRejectedValueOnce(new Error("db down"));

		clock += 11 * MIN;
		await watchdog.sweep();

		expect(deps.releaseJob).toHaveBeenCalledWith("job-1", {
			keepGroupLock: true,
		});
	});

	it("releases a hung job when the audit trail cannot be written", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		running = [];
		deps.loadContext.mockRejectedValueOnce(new Error("db down"));
		clock = START + 91 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.releaseJob).toHaveBeenCalledWith("job-1", {
			keepGroupLock: true,
		});
	});

	it("one failing hung job does not stop the others from being released", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		running = [];
		jobs = [appJob("job-1", "app-1", START), appJob("job-2", "app-2", START)];
		deps.failServiceIfRunning.mockRejectedValueOnce(new Error("db down"));
		deps.loadContext.mockRejectedValueOnce(new Error("db down"));
		clock = START + 91 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.releaseJob).toHaveBeenCalledTimes(2);
	});

	it("refuses the late writes of the deployment before it frees the slot", async () => {
		deps.stop.mockResolvedValue({
			method: "pid",
			notRunning: false,
			claimedCancelled: false,
		});
		clock = START + 100 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);
		await watchdog.sweep();
		clock += 11 * MIN;
		await watchdog.sweep();

		expect(deps.markDeploymentReleased).toHaveBeenCalledWith("dep-1");
		const order = (mock: AnyMock) => mock.mock.invocationCallOrder[0] ?? 0;
		expect(order(deps.markDeploymentReleased)).toBeLessThan(
			order(deps.releaseJob),
		);
	});
});

describe("a deploy that stalls after the image push", () => {
	// job-4512: the log ended at "✅ Image Pushed", the rollout never started and
	// the row stayed running for 66 minutes. The watchdog reads the log's
	// modification time, not its content, so this stall is a plain idle stall.
	const stalledAfterPush = () => {
		running = [row({ title: "Deploy (Image Pushed)" })];
		clock = START + 30 * MIN;
		idleMs = 25 * MIN;
	};

	it("fires the idle trigger like a build-phase stall: stop, mark failed, notify, release", async () => {
		stalledAfterPush();
		deps.stop.mockResolvedValue({
			method: "pid",
			notRunning: false,
			claimedCancelled: false,
		});
		const watchdog = createDeploymentWatchdog(asDeps);

		await sweepTwice(watchdog);
		expect(logLines()[0]).toBe("Watchdog: no log output for 20 min");
		expect(deps.stop).toHaveBeenCalledTimes(1);

		// The rollout never started, so the job does not end by itself.
		clock += 11 * MIN;
		await watchdog.sweep();

		expect(deps.markFailed).toHaveBeenCalledTimes(1);
		expect(deps.markFailed.mock.calls[0]?.[1]).toContain(
			"Watchdog: no log output for 20 min",
		);
		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.recordAudit.mock.calls[0]?.[0]).toMatchObject({
			action: "watchdog_fail",
			metadata: expect.objectContaining({ reason: "idle", slotReleased: true }),
		});
		expect(deps.releaseJob).toHaveBeenCalledWith("job-1", {
			keepGroupLock: false,
		});
		expect(logLines()).toContain("Watchdog: marked failed");
	});

	it("handles it the same way as a stall in the build phase", async () => {
		const outcomes: Array<Record<string, unknown>> = [];
		for (const title of ["Deploy (building)", "Deploy (Image Pushed)"]) {
			vi.clearAllMocks();
			keptLocks = new Set();
			running = [row({ title })];
			jobs = [appJob()];
			clock = START + 30 * MIN;
			idleMs = 25 * MIN;
			deps.readStatus.mockResolvedValue("running");
			deps.readLogIdleMs.mockImplementation(async () => idleMs);
			const watchdog = createDeploymentWatchdog(asDeps);
			await sweepTwice(watchdog);
			outcomes.push({
				stops: deps.stop.mock.calls.length,
				marked: deps.markFailed.mock.calls.length,
				notified: deps.notify.mock.calls.length,
				line: logLines()[0],
			});
		}

		expect(outcomes[1]).toEqual(outcomes[0]);
		expect(outcomes[1]).toMatchObject({
			stops: 1,
			line: "Watchdog: no log output for 20 min",
		});
	});

	it("does not fire on the first silent sweep alone", async () => {
		stalledAfterPush();
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(deps.stop).not.toHaveBeenCalled();
		expect(deps.markFailed).not.toHaveBeenCalled();
	});
});

describe("a log host that cannot be reached", () => {
	it("never fires the idle trigger, however long it stays unreachable", async () => {
		idleMs = null;
		clock = START + 80 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();
		clock += MIN;
		await watchdog.sweep();
		clock += MIN;
		await watchdog.sweep();

		expect(deps.stop).not.toHaveBeenCalled();
		expect(deps.markFailed).not.toHaveBeenCalled();
		expect(deps.appendLog).not.toHaveBeenCalled();
		expect(deps.releaseJob).not.toHaveBeenCalled();
	});

	it("still fires the wall limit, without reading the log", async () => {
		idleMs = null;
		clock = START + 91 * MIN;
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();

		expect(logLines()[0]).toBe("Watchdog: exceeded 90 min");
		expect(deps.stop).toHaveBeenCalledTimes(1);
		expect(deps.readLogIdleMs).not.toHaveBeenCalled();
	});

	it("an unreachable sighting between two silent ones does not count as silence", async () => {
		clock = START + 30 * MIN;
		deps.readLogIdleMs
			.mockResolvedValueOnce(25 * MIN)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(25 * MIN);
		const watchdog = createDeploymentWatchdog(asDeps);

		await watchdog.sweep();
		clock += MIN;
		await watchdog.sweep();
		clock += MIN;
		await watchdog.sweep();

		expect(deps.stop).not.toHaveBeenCalled();
	});
});
