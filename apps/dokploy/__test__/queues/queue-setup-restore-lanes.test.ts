import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The boot restore and the pull lane (T-12497). Jobs read back from the journal
 * are classified before the worker gate opens, so restored pull jobs start in
 * their lane at once; a classifier that is slow, hangs or fails must still let
 * the gate open (they simply start as build jobs). The queue is the real one;
 * the database, the journal and the worker are mocked, and the gate mock pauses
 * and resumes the queue the way the real one does.
 */

const boot = vi.hoisted(() => ({
	/** Order of what happened: classifications and the gate opening. */
	events: [] as string[],
	/** What the journal replay puts into the queue. */
	restoredJobs: [] as Array<{
		journalId: string;
		data: Record<string, unknown>;
		timestamp: number;
	}>,
	/** The pull cap the queue is configured with (0 = lane off). */
	pullCap: 4,
	/** The classifier, replaced per test. */
	classify: (_data: Record<string, unknown>): Promise<string> | string =>
		"build",
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	updateApplicationStatus: vi.fn(),
	updateCompose: vi.fn(),
	updatePreviewDeployment: vi.fn(),
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));
vi.mock("../../server/queues/concurrency", () => ({
	resolveBuildsConcurrency: () => 1,
}));
vi.mock("../../server/queues/deploy-lane", () => ({
	resolvePullConcurrency: () => boot.pullCap,
	classifyDeployJob: (data: Record<string, unknown>) => {
		boot.events.push(`classify:${String(data.titleLog)}`);
		return boot.classify(data);
	},
}));
vi.mock("../../server/queues/deployments-queue", () => ({
	processDeploymentJob: () => new Promise(() => {}),
}));
vi.mock("../../server/queues/lifecycle", () => ({
	gateWorkerUntilRestored: (queue: { pause(): void; resume(): void }) => {
		queue.pause();
		return {
			open: () => {
				boot.events.push("open");
				queue.resume();
			},
		};
	},
	registerShutdownHandler: () => {},
}));
vi.mock("../../server/queues/queue-journal", () => ({
	createQueueJournal: () => ({
		journal: undefined,
		restore: async (queue: { addRestored: (jobs: unknown[]) => number }) => ({
			restored: queue.addRestored(boot.restoredJobs),
			interrupted: 0,
			dropped: 0,
		}),
	}),
	dbJournalStore: {},
}));
vi.mock("@dokploy/server/services/build-policy/webhook", () => ({
	isCoalescingEnforcedForUnit: async () => false,
}));

const settle = async () => {
	for (let i = 0; i < 80; i++) await Promise.resolve();
};

const appJob = (applicationId: string) => ({
	applicationId,
	titleLog: applicationId,
	descriptionLog: "",
	type: "deploy",
	applicationType: "application",
});

const restoredRows = (...ids: string[]) =>
	ids.map((id, index) => ({
		journalId: `journal-${id}`,
		data: appJob(id),
		timestamp: 1_700_000_000_000 + index,
	}));

/** A fresh queue singleton for each test. */
const freshQueueSetup = async () => {
	vi.resetModules();
	delete (globalThis as { __dokployDeploymentQueue?: unknown })
		.__dokployDeploymentQueue;
	return import("../../server/queues/queueSetup");
};

const lanesOf = async (
	setup: Awaited<ReturnType<typeof freshQueueSetup>>,
	states?: Array<"waiting" | "active">,
) =>
	Object.fromEntries(
		(await setup.myQueue.getJobs(states)).map((job) => [
			(job.data as { titleLog: string }).titleLog,
			job.lane,
		]),
	);

beforeEach(() => {
	boot.events.length = 0;
	boot.restoredJobs = [];
	boot.pullCap = 4;
	boot.classify = () => "build";
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("restoring jobs into the lanes", () => {
	it("classifies the restored jobs before the gate opens, and they start in their lane", async () => {
		const setup = await freshQueueSetup();
		boot.restoredJobs = restoredRows("pullA", "buildB", "pullC");
		let resolveFirst!: (lane: string) => void;
		const answers: Record<string, string> = {
			pullA: "pull",
			buildB: "build",
			pullC: "pull",
		};
		const seen: Record<string, number> = {};
		boot.classify = (data) => {
			const label = String(data.titleLog);
			seen[label] = (seen[label] ?? 0) + 1;
			// The first answer for pullA comes late.
			if (label === "pullA" && seen[label] === 1) {
				return new Promise<string>((resolve) => {
					resolveFirst = resolve;
				});
			}
			return answers[label] as string;
		};

		let restored = false;
		const done = setup.restoreQueuedDeployments().then((result) => {
			restored = true;
			return result;
		});
		await settle();

		// The restore is waiting for the classification: the gate is still shut and nothing runs.
		expect(restored).toBe(false);
		expect(boot.events).not.toContain("open");
		expect(await setup.myQueue.getJobs(["active"])).toEqual([]);

		resolveFirst("pull");
		await expect(done).resolves.toMatchObject({ restored: 3 });

		const open = boot.events.indexOf("open");
		expect(open).toBeGreaterThan(-1);
		const classifiedBefore = boot.events
			.slice(0, open)
			.filter((event) => event.startsWith("classify:"));
		expect(classifiedBefore).toEqual(
			expect.arrayContaining([
				"classify:pullA",
				"classify:buildB",
				"classify:pullC",
			]),
		);

		await settle();
		// One build slot and the pull lane: both pull jobs plus the build job run.
		expect(await lanesOf(setup, ["active"])).toEqual({
			pullA: "pull",
			buildB: "build",
			pullC: "pull",
		});
	});

	it("a classifier that never answers still opens the gate after its time limit", async () => {
		const setup = await freshQueueSetup();
		boot.restoredJobs = restoredRows("hung");
		boot.classify = () => new Promise<string>(() => {});
		vi.useFakeTimers();

		let restored = false;
		const done = setup.restoreQueuedDeployments().then((result) => {
			restored = true;
			return result;
		});
		await vi.advanceTimersByTimeAsync(setup.RESTORE_LANE_CLASSIFY_MS - 1);
		expect(restored).toBe(false);
		expect(boot.events).not.toContain("open");

		await vi.advanceTimersByTimeAsync(1);
		await expect(done).resolves.toMatchObject({ restored: 1 });
		expect(boot.events).toContain("open");

		await settle();
		// It was not classified in time, so it ran as an ordinary build job.
		expect(await lanesOf(setup, ["active"])).toEqual({ hung: "build" });
	});

	it("a classifier that fails still opens the gate and the jobs start as build jobs", async () => {
		const setup = await freshQueueSetup();
		boot.restoredJobs = restoredRows("a", "b");
		boot.classify = () => Promise.reject(new Error("db down"));

		await expect(setup.restoreQueuedDeployments()).resolves.toMatchObject({
			restored: 2,
		});
		expect(boot.events).toContain("open");
		await settle();
		// Build cap 1: the first runs, the second waits; neither is a pull job.
		expect(await lanesOf(setup)).toEqual({ a: "build", b: "build" });
	});

	it("with the pull lane off, restored jobs are not even classified", async () => {
		boot.pullCap = 0;
		const setup = await freshQueueSetup();
		boot.restoredJobs = restoredRows("a", "b");
		boot.classify = () => "pull";

		await expect(setup.restoreQueuedDeployments()).resolves.toMatchObject({
			restored: 2,
		});
		await settle();
		expect(
			boot.events.filter((event) => event.startsWith("classify:")),
		).toEqual([]);
		expect(await lanesOf(setup)).toEqual({ a: "build", b: "build" });
		// One lane, one cap: the second job waits for the first.
		expect(await setup.myQueue.getJobs(["active"])).toHaveLength(1);
	});

	it("restoring nothing still opens the gate", async () => {
		const setup = await freshQueueSetup();
		boot.restoredJobs = [];

		await expect(setup.restoreQueuedDeployments()).resolves.toMatchObject({
			restored: 0,
		});
		expect(boot.events).toEqual(["open"]);
	});
});
