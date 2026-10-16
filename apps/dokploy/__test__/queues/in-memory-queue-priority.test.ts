import { describe, expect, it, vi } from "vitest";
import {
	InMemoryQueue,
	type JobOutcome,
	type QueueJournal,
} from "../../server/queues/in-memory-queue";
import type { DeploymentJob } from "../../server/queues/queue-types";

/**
 * The priority lane of the deploy queue (docs/design/deploy-queue-priority.md):
 * a flagged waiting job may start ahead of the jobs before it, never beyond the
 * concurrency cap, never next to a running job of its own service, and never two
 * in a row.
 */

const app = (applicationId: string, extra: Partial<DeploymentJob> = {}) =>
	({
		applicationId,
		titleLog: applicationId,
		descriptionLog: "",
		type: "deploy",
		applicationType: "application",
		...extra,
	}) as DeploymentJob;

const prio = (id: string) => app(id, { priority: true, priorityBy: "user-1" });

const comp = (composeId: string, extra: Partial<DeploymentJob> = {}) =>
	({
		composeId,
		titleLog: composeId,
		descriptionLog: "",
		type: "deploy",
		applicationType: "compose",
		...extra,
	}) as DeploymentJob;

const idOf = (data: DeploymentJob) =>
	(data as { applicationId?: string }).applicationId ??
	(data as { composeId?: string }).composeId ??
	"";

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * A queue whose jobs run until `finish(id, outcome)` is called. `started` lists
 * the ids in start order (an id may start more than once).
 */
const harness = (
	concurrency: number,
	journal?: QueueJournal,
	partitionConcurrency?: (partition: string) => number,
) => {
	const started: string[] = [];
	const running = new Map<string, (outcome?: JobOutcome) => void>();
	const jobs = new Map<string, { wentAheadOf?: number }>();
	const queue = new InMemoryQueue({
		resolveConcurrency: (partition) =>
			partitionConcurrency ? partitionConcurrency(partition) : concurrency,
		journal,
	});
	queue.process(
		(job) =>
			new Promise<JobOutcome | undefined>((resolve) => {
				const id = idOf(job.data);
				started.push(id);
				jobs.set(id, job);
				running.set(id, resolve);
			}),
	);
	const finish = async (id: string, outcome?: JobOutcome) => {
		const done = running.get(id);
		if (!done) throw new Error(`${id} is not running`);
		running.delete(id);
		done(outcome);
		await flush();
	};
	return { queue, started, running, jobs, finish };
};

/** Fill the single slot with `blocker`, then queue `ids` behind it. */
const behind = async (
	h: ReturnType<typeof harness>,
	blocker: string,
	waiting: DeploymentJob[],
) => {
	await h.queue.add(app(blocker));
	await flush();
	const added = [];
	for (const job of waiting) added.push(await h.queue.add(job));
	await flush();
	return added;
};

describe("priority ordering", () => {
	it("a flagged job starts ahead of the jobs waiting before it", async () => {
		const h = harness(1);
		await behind(h, "blocker", [app("b"), app("c"), prio("p")]);

		await h.finish("blocker");
		expect(h.started).toEqual(["blocker", "p"]);

		await h.finish("p");
		await h.finish("b");
		expect(h.started).toEqual(["blocker", "p", "b", "c"]);
	});

	it("reports how many waiting jobs it went ahead of, at enqueue and when started", async () => {
		const h = harness(1);
		const added = await behind(h, "blocker", [app("b"), app("c"), prio("p")]);

		expect(added[2]?.priority).toEqual({
			requested: true,
			applied: true,
			wentAheadOf: 2,
		});

		await h.finish("blocker");
		expect(h.jobs.get("p")?.wentAheadOf).toBe(2);
		await h.finish("p");
		// b started in plain order: it went ahead of nothing.
		expect(h.jobs.get("b")?.wentAheadOf).toBe(0);
	});

	it("keeps the FIFO order of everything that is not flagged", async () => {
		const h = harness(1);
		await behind(h, "blocker", [app("b"), app("c"), app("d"), prio("p")]);

		await h.finish("blocker");
		await h.finish("p");
		await h.finish("b");
		await h.finish("c");
		expect(h.started).toEqual(["blocker", "p", "b", "c", "d"]);
	});

	it("two flagged jobs keep their order relative to each other", async () => {
		const h = harness(1);
		await behind(h, "blocker", [app("b"), prio("p1"), prio("p2")]);

		await h.finish("blocker");
		await h.finish("p1");
		// p1 -> b (the cooldown) -> p2
		await h.finish("b");
		await h.finish("p2");
		expect(h.started).toEqual(["blocker", "p1", "b", "p2"]);
	});
});

describe("at most one priority job ahead", () => {
	it("a second flagged job does not jump while the first runs", async () => {
		const h = harness(2);
		await h.queue.add(app("x"));
		await h.queue.add(app("y"));
		await flush();
		await h.queue.add(app("b"));
		await h.queue.add(prio("p1"));
		await h.queue.add(prio("p2"));
		await flush();

		await h.finish("x");
		expect(h.started).toEqual(["x", "y", "p1"]);
		// A slot frees while p1 still runs: p2 must not jump, b goes.
		await h.finish("y");
		expect(h.started).toEqual(["x", "y", "p1", "b"]);
	});

	it("is told so when it asks while another priority job runs", async () => {
		const h = harness(2);
		await h.queue.add(app("x"));
		await h.queue.add(app("y"));
		await flush();
		await h.queue.add(app("b"));
		await h.queue.add(prio("p1"));
		await flush();
		await h.finish("x");
		expect(h.started).toContain("p1");

		const second = await h.queue.add(prio("p2"));
		expect(second.priority).toEqual({
			requested: true,
			applied: false,
			wentAheadOf: 0,
			reason: "priority-busy",
		});
		// The flag is kept: it goes ahead as soon as that is allowed.
		const waiting = await h.queue.getJobs(["waiting"]);
		expect(
			waiting.find(
				(j) => (j.data as { applicationId: string }).applicationId === "p2",
			)?.data.priority,
		).toBe(true);
	});

	it("never lets priority jobs starve the normal lane: a plain start sits between two jumps", async () => {
		const h = harness(1);
		await behind(h, "blocker", [
			app("n1"),
			app("n2"),
			prio("p1"),
			prio("p2"),
			prio("p3"),
		]);

		await h.finish("blocker");
		await h.finish("p1");
		await h.finish("n1"); // plain start between p1 and p2
		await h.finish("p2");
		await h.finish("n2");
		await h.finish("p3");
		expect(h.started).toEqual(["blocker", "p1", "n1", "p2", "n2", "p3"]);
	});

	it("a priority job that was first in line anyway does not use the allowance", async () => {
		const h = harness(2);
		await h.queue.add(app("x"));
		await h.queue.add(app("y"));
		await flush();
		const b = await h.queue.add(app("b"));
		await h.queue.add(prio("p1"));
		await h.queue.add(app("c"));
		await h.queue.add(prio("p2"));
		await flush();
		// b leaves, so the flagged p1 is first in line.
		await h.queue.remove(b.id);

		await h.finish("x");
		expect(h.started.at(-1)).toBe("p1");
		expect(h.jobs.get("p1")?.wentAheadOf).toBe(0);
		// p1 was a plain start, so p2 can still jump c.
		await h.finish("y");
		expect(h.started.at(-1)).toBe("p2");
	});
});

describe("the service and the cap are respected", () => {
	it("never starts a flagged job next to a running job of the same service", async () => {
		const h = harness(2);
		await h.queue.add(app("a"));
		await flush();
		await h.queue.add(app("b"));
		await h.queue.add(prio("a")); // same service as the running job
		await flush();

		// b took the second slot in plain order; the flagged a waits for its group.
		expect(h.started).toEqual(["a", "b"]);
		await h.finish("b");
		expect(h.started).toEqual(["a", "b"]);
		await h.finish("a");
		expect(h.started).toEqual(["a", "b", "a"]);
	});

	it("a flagged job whose service is busy does not block a free one behind it", async () => {
		const h = harness(2);
		await h.queue.add(app("a"));
		await flush();
		await h.queue.add(app("b"));
		await h.queue.add(prio("a"));
		await h.queue.add(app("c"));
		await flush();
		await h.finish("b");
		// Slot free, a is busy, so c (not b's replacement a) is the pick.
		expect(h.started).toEqual(["a", "b", "c"]);
	});

	it("never exceeds the concurrency cap", async () => {
		const h = harness(2);
		await h.queue.add(app("x"));
		await h.queue.add(app("y"));
		await flush();
		await h.queue.add(app("b"));
		await h.queue.add(prio("p"));
		await flush();

		expect(h.running.size).toBe(2);
		expect(h.started).toEqual(["x", "y"]);
		await h.finish("x");
		expect(h.running.size).toBe(2);
		expect(h.started).toEqual(["x", "y", "p"]);
	});

	it("only goes ahead of jobs in its own lane (server)", async () => {
		const h = harness(1);
		await h.queue.add(app("blocker"));
		await flush();
		await h.queue.add(app("r1", { serverId: "remote" }));
		await h.queue.add(app("l1"));
		await h.queue.add(app("l2"));
		await h.queue.add(prio("p"));
		await flush();

		// remote lane had its own free slot.
		expect(h.started).toEqual(["blocker", "r1"]);
		await h.finish("blocker");
		expect(h.started).toEqual(["blocker", "r1", "p"]);
	});
});

describe("no-op and bump", () => {
	it("does nothing when no job is waiting and stores no flag", async () => {
		const journal = {
			enqueued: vi.fn(),
			started: vi.fn(),
			settled: vi.fn(),
		};
		const h = harness(1, journal);
		const result = await h.queue.add(prio("solo"));
		await flush();

		expect(result.priority).toEqual({
			requested: true,
			applied: false,
			wentAheadOf: 0,
			reason: "nothing-waiting",
		});
		const stored = journal.enqueued.mock.calls[0]?.[0].data as DeploymentJob;
		expect(stored.priority).toBeUndefined();
		expect(stored.priorityBy).toBeUndefined();
		expect(h.started).toEqual(["solo"]);
		expect(h.jobs.get("solo")?.wentAheadOf).toBe(0);
	});

	it("a plain add reports no priority outcome", async () => {
		const h = harness(1);
		expect((await h.queue.add(app("a"))).priority).toBeUndefined();
	});

	it("flags a waiting job, which then goes ahead", async () => {
		const journal = {
			enqueued: vi.fn(),
			started: vi.fn(),
			settled: vi.fn(),
			updated: vi.fn(),
		};
		const h = harness(1, journal);
		const added = await behind(h, "blocker", [app("b"), app("c")]);

		const outcome = h.queue.prioritize(added[1]?.id as string, "ops@x.io");
		expect(outcome).toEqual({ requested: true, applied: true, wentAheadOf: 1 });
		expect(journal.updated).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ priority: true, priorityBy: "ops@x.io" }),
		);

		await h.finish("blocker");
		expect(h.started).toEqual(["blocker", "c"]);
	});

	it("flagging the job that is first in line is a no-op", async () => {
		const journal = {
			enqueued: vi.fn(),
			started: vi.fn(),
			settled: vi.fn(),
			updated: vi.fn(),
		};
		const h = harness(1, journal);
		const added = await behind(h, "blocker", [app("b"), app("c")]);

		// Others wait behind it, so it is "first in line", not "nothing waiting".
		expect(h.queue.prioritize(added[0]?.id as string)).toEqual({
			requested: true,
			applied: false,
			wentAheadOf: 0,
			reason: "first-in-line",
		});
		expect(journal.updated).not.toHaveBeenCalled();
	});

	it("flagging a job that is first in line and alone says nothing is waiting", async () => {
		const h = harness(1);
		const added = await behind(h, "blocker", [app("b")]);

		expect(h.queue.prioritize(added[0]?.id as string)).toEqual({
			requested: true,
			applied: false,
			wentAheadOf: 0,
			reason: "nothing-waiting",
		});
	});

	it("cannot flag a job that is running or gone", async () => {
		const h = harness(1);
		const running = await h.queue.add(app("a"));
		await flush();
		expect(h.queue.prioritize(running.id)).toBeNull();
		expect(h.queue.prioritize("job-999")).toBeNull();
	});

	it("flagging twice stores one update", async () => {
		const journal = {
			enqueued: vi.fn(),
			started: vi.fn(),
			settled: vi.fn(),
			updated: vi.fn(),
		};
		const h = harness(1, journal);
		const added = await behind(h, "blocker", [app("b"), app("c")]);
		h.queue.prioritize(added[1]?.id as string);
		h.queue.prioritize(added[1]?.id as string);
		expect(journal.updated).toHaveBeenCalledTimes(1);
	});
});

describe("a flagged job never passes an older job of its own service", () => {
	// Deploy-hook jobs carry a pinned image and compose jobs may reset volumes:
	// running the newer one first would leave the service on the older state.
	it("D2 (flagged) does not run before D1 of the same service", async () => {
		const h = harness(1);
		await behind(h, "blocker", [
			app("b"),
			app("d", {
				pinnedImage: { ref: "r/d", tag: null, digest: "sha256:old" },
			} as Partial<DeploymentJob>),
			app("c"),
		]);
		const d2 = await h.queue.add(prio("d"));
		await flush();

		await h.finish("blocker");
		expect(h.started).toEqual(["blocker", "b"]);
		await h.finish("b");
		expect(h.started).toEqual(["blocker", "b", "d"]);
		expect(d2.priority?.reason).toBe("older-same-service");
	});

	it("the older job of the service always starts first, then the flagged one may pass others", async () => {
		const h = harness(1);
		await behind(h, "blocker", [app("b"), app("d"), app("c"), prio("d")]);

		await h.finish("blocker");
		await h.finish("b");
		await h.finish("d"); // D1
		// D2 is now the oldest of its service and may go ahead of c.
		expect(h.started).toEqual(["blocker", "b", "d", "d"]);
		await h.finish("d");
		expect(h.started).toEqual(["blocker", "b", "d", "d", "c"]);
	});

	it("applies to compose services (fresh volumes) the same way", async () => {
		const h = harness(1);
		await behind(h, "blocker", [
			comp("s", { freshVolumes: true } as Partial<DeploymentJob>),
			app("other"),
			comp("s", { priority: true } as Partial<DeploymentJob>),
		]);

		await h.finish("blocker");
		// The older compose job is first in line; the flagged one cannot pass it.
		expect(h.started).toEqual(["blocker", "s"]);
		await h.finish("s");
		// Now the flagged one is the oldest of its service and passes "other".
		expect(h.started).toEqual(["blocker", "s", "s"]);
	});

	it("flagging a waiting job that has an older job of its service reports it and stores the flag", async () => {
		const journal = {
			enqueued: vi.fn(),
			started: vi.fn(),
			settled: vi.fn(),
			updated: vi.fn(),
		};
		const h = harness(1, journal);
		const added = await behind(h, "blocker", [app("d"), app("b"), app("d")]);

		expect(h.queue.prioritize(added[2]?.id as string, "user-1")).toEqual({
			requested: true,
			applied: false,
			wentAheadOf: 0,
			reason: "older-same-service",
		});
		expect(journal.updated).toHaveBeenCalledTimes(1);

		await h.finish("blocker");
		expect(h.started).toEqual(["blocker", "d"]);
	});

	it("does not stop it passing jobs of other services", async () => {
		const h = harness(1);
		await behind(h, "blocker", [app("x"), app("y"), prio("d")]);
		await h.finish("blocker");
		expect(h.started).toEqual(["blocker", "d"]);
	});
});

describe("the reported outcome is accurate", () => {
	it("does not count a waiting job that is blocked by its own running service", async () => {
		const h = harness(2);
		await h.queue.add(app("a"));
		await h.queue.add(app("z"));
		await flush();
		// a2 cannot start while a runs, so p does not pass it.
		await h.queue.add(app("a"));
		await h.queue.add(app("b"));
		const p = await h.queue.add(prio("p"));

		expect(p.priority).toEqual({
			requested: true,
			applied: true,
			wentAheadOf: 1,
		});
		await h.finish("z");
		expect(h.started.at(-1)).toBe("p");
		expect(h.jobs.get("p")?.wentAheadOf).toBe(1);
	});

	it("is not applied when only blocked jobs wait and a slot is free anyway", async () => {
		const h = harness(2);
		await h.queue.add(app("a"));
		await flush();
		await h.queue.add(app("a")); // blocked behind the running a
		const p = await h.queue.add(prio("p"));
		await flush();

		expect(p.priority).toEqual({
			requested: true,
			applied: false,
			wentAheadOf: 0,
			reason: "first-in-line",
		});
		expect(h.started).toEqual(["a", "p"]);
		expect(h.jobs.get("p")?.wentAheadOf).toBe(0);
	});

	it("is not applied when the waiting jobs ahead will take the free slots anyway", async () => {
		const h = harness(2);
		// Both added before the queue has ticked: x and y fill the two slots.
		await h.queue.add(app("x"));
		const y = await h.queue.add(prio("y"));
		await flush();

		expect(y.priority?.applied).toBe(false);
		expect(h.started).toEqual(["x", "y"]);
		expect(h.jobs.get("y")?.wentAheadOf).toBe(0);
	});
});

describe("the cooldown at a concurrency of 2", () => {
	it("a plain job starts between two priority starts, even when the first has already finished", async () => {
		const h = harness(2);
		await h.queue.add(app("x"));
		await h.queue.add(app("y"));
		await flush();
		for (const job of [app("b1"), app("b2"), prio("p1"), prio("p2")]) {
			await h.queue.add(job);
		}
		await flush();

		await h.finish("x");
		expect(h.started).toEqual(["x", "y", "p1"]);
		// p1 completes while y still runs: the slot goes to a plain job, not p2.
		await h.finish("p1");
		expect(h.started).toEqual(["x", "y", "p1", "b1"]);
		// Now p2 may go ahead of b2.
		await h.finish("y");
		expect(h.started).toEqual(["x", "y", "p1", "b1", "p2"]);
		await h.finish("p2");
		expect(h.started).toEqual(["x", "y", "p1", "b1", "p2", "b2"]);
	});

	it("only one priority job runs at a time even with a free slot", async () => {
		const h = harness(2);
		await h.queue.add(app("x"));
		await h.queue.add(app("y"));
		await flush();
		for (const job of [app("b1"), prio("p1"), prio("p2")]) {
			await h.queue.add(job);
		}
		await flush();

		await h.finish("x");
		await h.finish("y");
		// p1 runs; the second slot goes to b1, not to p2.
		expect(h.started).toEqual(["x", "y", "p1", "b1"]);
	});

	it("a failed priority job returns the cooldown, so a second one can follow it at once (documented)", async () => {
		const h = harness(2);
		await h.queue.add(app("x"));
		await h.queue.add(app("y"));
		await flush();
		for (const job of [app("b1"), prio("p1"), prio("p2")]) {
			await h.queue.add(job);
		}
		await flush();

		await h.finish("x");
		await h.finish("p1", "failed");
		expect(h.started).toEqual(["x", "y", "p1", "p2"]);
	});
});

describe("cancel", () => {
	it("a cancelled waiting priority job simply leaves; the queue goes on in order", async () => {
		const h = harness(1);
		const added = await behind(h, "blocker", [app("b"), prio("p"), app("c")]);

		await h.queue.remove(added[1]?.id as string);
		await h.finish("blocker");
		await h.finish("b");
		expect(h.started).toEqual(["blocker", "b", "c"]);
	});

	it("a priority job that is cancelled while running gives the allowance back", async () => {
		const h = harness(1);
		await behind(h, "blocker", [app("b"), prio("p1"), prio("p2")]);

		await h.finish("blocker");
		await h.finish("p1", "cancelled");
		// p2 can go ahead of b straight away.
		expect(h.started).toEqual(["blocker", "p1", "p2"]);
	});

	it("a priority job that fails gives the allowance back too", async () => {
		const h = harness(1);
		await behind(h, "blocker", [app("b"), prio("p1"), prio("p2")]);

		await h.finish("blocker");
		await h.finish("p1", "failed");
		expect(h.started).toEqual(["blocker", "p1", "p2"]);
	});

	it("a priority job that completes does not: a plain job is next", async () => {
		const h = harness(1);
		await behind(h, "blocker", [app("b"), prio("p1"), prio("p2")]);

		await h.finish("blocker");
		await h.finish("p1");
		expect(h.started).toEqual(["blocker", "p1", "b"]);
	});

	it("a processor that throws frees the slot and the allowance", async () => {
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
		const started: string[] = [];
		let release!: () => void;
		queue.process(async (job) => {
			const id = (job.data as { applicationId: string }).applicationId;
			started.push(id);
			if (id === "blocker") await new Promise<void>((r) => (release = r));
			if (id === "p1") throw new Error("build blew up");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await queue.add(app("blocker"));
		await flush();
		await queue.add(app("b"));
		await queue.add(prio("p1"));
		await queue.add(prio("p2"));
		release();
		await flush();
		await flush();
		expect(started.slice(0, 3)).toEqual(["blocker", "p1", "p2"]);
	});

	it("the allowance is held while the cancelled job still holds its slot", async () => {
		// T-2458: a cancelled compose keeps its queue slot until the release
		// trap has finished. Until then nothing else, priority or not, may start.
		const h = harness(1);
		await behind(h, "blocker", [app("b"), prio("p1"), prio("p2")]);
		await h.finish("blocker");
		expect(h.started).toEqual(["blocker", "p1"]);
		// p1 was cancelled but its processor has not returned yet.
		await flush();
		expect(h.started).toEqual(["blocker", "p1"]);
		await h.finish("p1", "cancelled");
		expect(h.started).toEqual(["blocker", "p1", "p2"]);
	});
});

describe("restore", () => {
	it("a restored flagged job keeps its flag and goes ahead of the restored jobs before it", async () => {
		const h = harness(1);
		h.queue.pause();
		h.queue.addRestored([
			{ journalId: "j1", data: app("r1"), timestamp: 1 },
			{ journalId: "j2", data: app("r2"), timestamp: 2 },
			{ journalId: "j3", data: prio("r3"), timestamp: 3 },
		]);
		h.queue.resume();
		await flush();

		expect(h.started).toEqual(["r3"]);
		await h.finish("r3");
		await h.finish("r1");
		expect(h.started).toEqual(["r3", "r1", "r2"]);
	});

	it("ignores a priority value that is not exactly true", async () => {
		const h = harness(1);
		h.queue.pause();
		h.queue.addRestored([
			{ journalId: "j1", data: app("r1"), timestamp: 1 },
			{
				journalId: "j2",
				data: app("r2", { priority: "yes" as unknown as boolean }),
				timestamp: 2,
			},
		]);
		h.queue.resume();
		await flush();
		expect(h.started).toEqual(["r1"]);
	});
});
