import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DeployIntakeNotDurableError,
	InMemoryQueue,
	type QueueJournal,
} from "../../server/queues/in-memory-queue";
import type { DeploymentJob } from "../../server/queues/queue-types";

const appJob = (applicationId: string, serverId?: string): DeploymentJob => ({
	applicationId,
	titleLog: `deploy ${applicationId}`,
	descriptionLog: "",
	type: "deploy",
	applicationType: "application",
	serverId,
});

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, release: resolve };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

const makeQueue = (
	options: {
		journal?: QueueJournal;
		resolveConcurrency?: () => number | Promise<number>;
	} = {},
) => {
	const started: string[] = [];
	const queue = new InMemoryQueue({
		resolveConcurrency: options.resolveConcurrency ?? (() => 2),
		journal: options.journal,
	});
	queue.process(async (job) => {
		started.push((job.data as { applicationId: string }).applicationId);
	});
	return { queue, started };
};

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("closing the intake", () => {
	it("accepts and journals a job but does not start it", async () => {
		const enqueued = vi.fn(async () => true);
		const { queue, started } = makeQueue({
			journal: { enqueued, started: vi.fn(), settled: vi.fn() },
		});
		queue.closeIntake(60_000);

		await queue.add(appJob("a"));
		await flush();

		expect(enqueued).toHaveBeenCalledTimes(1);
		expect(started).toEqual([]);
		expect(await queue.getJobs(["waiting"])).toHaveLength(1);
		expect(queue.intakeClosed()).toBe(true);
	});

	it("does not start a job that was already waiting, in any partition", async () => {
		const { queue, started } = makeQueue();
		queue.pause();
		await queue.add(appJob("local"));
		await queue.add(appJob("remote", "server-1"));
		const hold = queue.closeIntake(60_000);

		queue.resume();
		await flush();
		expect(started).toEqual([]);

		hold.release();
		await flush();
		expect(started.sort()).toEqual(["local", "remote"]);
	});

	it("starts nothing from a drain that was already in flight", async () => {
		const concurrency = deferred();
		const { queue, started } = makeQueue({
			// The drain is suspended here when the intake closes.
			resolveConcurrency: async () => {
				await concurrency.promise;
				return 5;
			},
		});
		await queue.add(appJob("a"));
		queue.closeIntake(60_000);
		concurrency.release();
		await flush();

		expect(started).toEqual([]);
		expect(queue.busy().active).toEqual([]);
	});

	it("starts the parked jobs, in order, when the hold is released", async () => {
		const { queue, started } = makeQueue({ resolveConcurrency: () => 1 });
		const hold = queue.closeIntake(60_000);
		await queue.add(appJob("a"));
		await queue.add(appJob("b"));
		await flush();
		expect(started).toEqual([]);

		hold.release();
		await flush();

		expect(started).toEqual(["a", "b"]);
		expect(queue.intakeClosed()).toBe(false);
	});

	it("reports what is running and which service locks are held", async () => {
		const gate = deferred();
		const queue = new InMemoryQueue({ resolveConcurrency: () => 2 });
		queue.process(() => gate.promise);
		await queue.add(appJob("a"));
		await queue.add({
			composeId: "c",
			titleLog: "t",
			descriptionLog: "",
			type: "deploy",
			applicationType: "compose",
		});
		await flush();
		const fetch = queue.holdIdleGroup("__local__", "compose:fetching");

		const busy = queue.busy();

		expect(busy.active.map((job) => job.group).sort()).toEqual([
			"application:a",
			"compose:c",
		]);
		expect(busy.heldGroups).toEqual(["compose:fetching"]);
		gate.release();
		if ("release" in fetch) fetch.release();
	});

	it("only counts the running jobs, so closing then reading is a consistent check", async () => {
		const gate = deferred();
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
		queue.process(() => gate.promise);
		await queue.add(appJob("a"));
		await flush();
		await queue.add(appJob("b"));

		queue.closeIntake(60_000);

		expect(queue.busy().active).toHaveLength(1);
		gate.release();
		await flush();
		// "b" was waiting behind "a"; with the intake closed it does not start.
		expect(queue.busy().active).toHaveLength(0);
		expect(await queue.getJobs(["waiting"])).toHaveLength(1);
	});

	it("is independent of the boot gate's pause and resume", async () => {
		const { queue, started } = makeQueue();
		queue.pause();
		const hold = queue.closeIntake(60_000);
		await queue.add(appJob("a"));

		queue.resume();
		await flush();
		expect(started).toEqual([]);

		hold.release();
		await flush();
		expect(started).toEqual(["a"]);
	});

	it("reopens only when every hold is released, and releasing twice is harmless", async () => {
		const { queue, started } = makeQueue();
		const one = queue.closeIntake(60_000);
		const two = queue.closeIntake(60_000);
		await queue.add(appJob("a"));

		one.release();
		one.release();
		await flush();
		expect(started).toEqual([]);
		expect(queue.intakeClosed()).toBe(true);

		two.release();
		await flush();
		expect(started).toEqual(["a"]);
	});
});

describe("the hold's time limit", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("reopens on its own when the process was never replaced", async () => {
		const { queue, started } = makeQueue();
		queue.closeIntake(10 * 60_000);
		await queue.add(appJob("a"));

		await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
		expect(started).toEqual([]);
		await vi.advanceTimersByTimeAsync(2);

		expect(queue.intakeClosed()).toBe(false);
		expect(started).toEqual(["a"]);
	});

	it("extend restarts the clock, and a released hold's timer does nothing", async () => {
		const { queue, started } = makeQueue();
		const hold = queue.closeIntake(1_000);

		await vi.advanceTimersByTimeAsync(900);
		hold.extend(5_000);
		await vi.advanceTimersByTimeAsync(4_000);
		expect(queue.intakeClosed()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_100);
		expect(queue.intakeClosed()).toBe(false);

		// A later hold is not reopened by the timer of an earlier one.
		const later = queue.closeIntake(60_000);
		hold.extend(10);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(queue.intakeClosed()).toBe(true);
		later.release();
		expect(started).toEqual([]);
	});
});

describe("accepting a job while the intake is closed", () => {
	it("refuses with a retryable error when the journal could not write it, and leaves nothing queued", async () => {
		const settled = vi.fn();
		const { queue, started } = makeQueue({
			journal: {
				enqueued: async () => false,
				started: vi.fn(),
				settled,
			},
		});
		queue.closeIntake(60_000);

		const result = queue.add(appJob("a"));

		await expect(result).rejects.toBeInstanceOf(DeployIntakeNotDurableError);
		await expect(result).rejects.toMatchObject({ retryable: true });
		expect(await queue.getJobs()).toEqual([]);
		expect(settled).toHaveBeenCalledTimes(1);
		expect(started).toEqual([]);
	});

	it("refuses the same way when the journal throws", async () => {
		const { queue } = makeQueue({
			journal: {
				enqueued: async () => {
					throw new Error("db down");
				},
				started: vi.fn(),
				settled: vi.fn(),
			},
		});
		queue.closeIntake(60_000);

		await expect(queue.add(appJob("a"))).rejects.toBeInstanceOf(
			DeployIntakeNotDurableError,
		);
	});

	it("keeps today's behaviour when the intake is open: an unwritten journal does not block the deploy", async () => {
		const { queue, started } = makeQueue({
			journal: {
				enqueued: async () => false,
				started: vi.fn(),
				settled: vi.fn(),
			},
		});

		await expect(queue.add(appJob("a"))).resolves.toMatchObject({
			id: expect.any(String),
		});
		await flush();
		expect(started).toEqual(["a"]);
	});

	it("accepts a journal that confirms nothing (void) as written", async () => {
		const { queue } = makeQueue({
			journal: { enqueued: () => {}, started: vi.fn(), settled: vi.fn() },
		});
		queue.closeIntake(60_000);

		await expect(queue.add(appJob("a"))).resolves.toBeDefined();
		expect(await queue.getJobs(["waiting"])).toHaveLength(1);
	});
});
