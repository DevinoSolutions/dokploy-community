import { describe, expect, it, vi } from "vitest";
import {
	InMemoryQueue,
	type QueueJournal,
} from "../../server/queues/in-memory-queue";
import type { DeploymentJob } from "../../server/queues/queue-types";

/**
 * Freeing the slot of a job whose processor never returns (the watchdog's last
 * resort): the slot, the service's group lock and the journal row are released
 * and the next waiting job starts, and the hung processor's late return
 * changes nothing.
 */

const appJob = (applicationId: string): DeploymentJob => ({
	applicationId,
	titleLog: "deploy",
	descriptionLog: "",
	type: "deploy",
	applicationType: "application",
});

const deferred = () => {
	let resolve!: (value?: unknown) => void;
	const promise = new Promise<unknown>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

const journal = () => {
	const settled: string[][] = [];
	const impl: QueueJournal = {
		enqueued: vi.fn(),
		started: vi.fn(),
		settled: (ids) => {
			settled.push(ids);
		},
	};
	return { impl, settled };
};

describe("InMemoryQueue.releaseActive", () => {
	it("frees the slot so the next waiting job starts", async () => {
		const hung = deferred();
		const started: string[] = [];
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
		queue.process(async (job) => {
			const id = (job.data as { applicationId: string }).applicationId;
			started.push(id);
			if (id === "a") await hung.promise;
		});
		await queue.add(appJob("a"));
		await queue.add(appJob("b"));
		await flush();
		expect(started).toEqual(["a"]);

		const [active] = await queue.getJobs(["active"]);
		expect(queue.releaseActive(active?.id as string)).toBe(true);
		await flush();

		expect(started).toEqual(["a", "b"]);
		expect(await queue.getJobs(["active"])).toHaveLength(0);
		hung.resolve();
	});

	it("frees the service's group lock, so the same service can deploy again", async () => {
		const hung = deferred();
		let runs = 0;
		const queue = new InMemoryQueue({ resolveConcurrency: () => 4 });
		queue.process(async () => {
			runs++;
			if (runs === 1) await hung.promise;
		});
		await queue.add(appJob("a"));
		await queue.add(appJob("a"));
		await flush();
		// Same service: the second waits behind the first.
		expect(runs).toBe(1);

		const [active] = await queue.getJobs(["active"]);
		queue.releaseActive(active?.id as string);
		await flush();

		expect(runs).toBe(2);
		hung.resolve();
	});

	it("settles the journal row of the released job", async () => {
		const { impl, settled } = journal();
		const hung = deferred();
		const queue = new InMemoryQueue({
			resolveConcurrency: () => 1,
			journal: impl,
		});
		queue.process(() => hung.promise);
		await queue.add(appJob("a"));
		await flush();

		const [active] = await queue.getJobs(["active"]);
		queue.releaseActive(active?.id as string);

		expect(settled).toEqual([[active?.journalId]]);
		hung.resolve();
	});

	it("a late return of the hung processor changes nothing", async () => {
		const { impl, settled } = journal();
		const hung = deferred();
		const next = deferred();
		const queue = new InMemoryQueue({
			resolveConcurrency: () => 1,
			journal: impl,
		});
		let calls = 0;
		queue.process(async () => {
			calls++;
			await (calls === 1 ? hung.promise : next.promise);
		});
		await queue.add(appJob("a"));
		await queue.add(appJob("a"));
		await flush();
		const [first] = await queue.getJobs(["active"]);
		queue.releaseActive(first?.id as string);
		await flush();
		// The second deploy of the same service is running now.
		const [second] = await queue.getJobs(["active"]);
		expect(second?.id).not.toBe(first?.id);
		const settledBefore = settled.length;

		hung.resolve();
		await flush();

		// Still running, still holding the lock, nothing settled twice.
		expect((await queue.getJobs(["active"])).map((job) => job.id)).toEqual([
			second?.id,
		]);
		expect(settled).toHaveLength(settledBefore);
		next.resolve();
	});

	it("is false for a job that is waiting, finished or unknown", async () => {
		const hung = deferred();
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
		queue.process(() => hung.promise);
		await queue.add(appJob("a"));
		await queue.add(appJob("b"));
		await flush();

		const [waiting] = await queue.getJobs(["waiting"]);
		expect(queue.releaseActive(waiting?.id as string)).toBe(false);
		expect(queue.releaseActive("job-999")).toBe(false);
		// Both finished: a finished job cannot be released again.
		hung.resolve();
		await flush();
		expect(queue.releaseActive("job-1")).toBe(false);
	});

	it("wakes a shutdown that waits for idle", async () => {
		const hung = deferred();
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
		queue.process(() => hung.promise);
		await queue.add(appJob("a"));
		await flush();
		const idle = queue.waitForIdle(10_000);

		const [active] = await queue.getJobs(["active"]);
		queue.releaseActive(active?.id as string);

		await expect(idle).resolves.toBe(true);
		hung.resolve();
	});
});

describe("InMemoryQueue.releaseActive with keepGroupLock", () => {
	it("frees the slot for other services but keeps the service locked", async () => {
		const hung = deferred();
		const started: string[] = [];
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
		queue.process(async (job) => {
			const id = (job.data as { applicationId: string }).applicationId;
			started.push(id);
			if (started.length === 1) await hung.promise;
		});
		await queue.add(appJob("a"));
		await queue.add(appJob("a"));
		await queue.add(appJob("b"));
		await flush();
		expect(started).toEqual(["a"]);

		const [active] = await queue.getJobs(["active"]);
		expect(
			queue.releaseActive(active?.id as string, { keepGroupLock: true }),
		).toBe(true);
		await flush();

		// The slot went to the other service; the second deploy of "a" still waits
		// behind the process nobody could stop.
		expect(started).toEqual(["a", "b"]);
		expect(await queue.getJobs(["waiting"])).toHaveLength(1);
		hung.resolve();
	});

	it("starts the service again once the old process really ends", async () => {
		const hung = deferred();
		const started: string[] = [];
		const queue = new InMemoryQueue({ resolveConcurrency: () => 4 });
		queue.process(async (job) => {
			started.push((job.data as { applicationId: string }).applicationId);
			if (started.length === 1) await hung.promise;
		});
		await queue.add(appJob("a"));
		await queue.add(appJob("a"));
		await flush();
		const [active] = await queue.getJobs(["active"]);
		queue.releaseActive(active?.id as string, { keepGroupLock: true });
		await flush();
		expect(started).toEqual(["a"]);

		hung.resolve();
		await flush();

		expect(started).toEqual(["a", "a"]);
	});

	it("without the option the service is free at once", async () => {
		const hung = deferred();
		const started: string[] = [];
		const queue = new InMemoryQueue({ resolveConcurrency: () => 4 });
		queue.process(async (job) => {
			started.push((job.data as { applicationId: string }).applicationId);
			if (started.length === 1) await hung.promise;
		});
		await queue.add(appJob("a"));
		await queue.add(appJob("a"));
		await flush();
		const [active] = await queue.getJobs(["active"]);
		queue.releaseActive(active?.id as string, { keepGroupLock: false });
		await flush();

		expect(started).toEqual(["a", "a"]);
		hung.resolve();
	});
});

describe("InMemoryQueue.dropKeptGroupLock", () => {
	const setup = async () => {
		const hung = deferred();
		const started: string[] = [];
		const queue = new InMemoryQueue({ resolveConcurrency: () => 4 });
		queue.process(async (job) => {
			started.push((job.data as { applicationId: string }).applicationId);
			if (started.length === 1) await hung.promise;
		});
		await queue.add(appJob("a"));
		await queue.add(appJob("a"));
		await flush();
		const [active] = await queue.getJobs(["active"]);
		const id = active?.id as string;
		queue.releaseActive(id, { keepGroupLock: true });
		await flush();
		return { queue, hung, started, id };
	};

	it("reports the lock while it is kept, and not for a job that did not keep it", async () => {
		const { queue, hung, id } = await setup();

		expect(queue.hasKeptGroupLock(id)).toBe(true);
		expect(queue.hasKeptGroupLock("job-999")).toBe(false);
		hung.resolve();
	});

	it("lets the service deploy again when dropped", async () => {
		const { queue, started, id, hung } = await setup();
		expect(started).toEqual(["a"]);

		expect(queue.dropKeptGroupLock(id)).toBe(true);
		await flush();

		expect(started).toEqual(["a", "a"]);
		expect(queue.hasKeptGroupLock(id)).toBe(false);
		hung.resolve();
	});

	it("the old processor's late return does not free the lock of the newer job", async () => {
		const first = deferred();
		const second = deferred();
		const started: string[] = [];
		const queue = new InMemoryQueue({ resolveConcurrency: () => 4 });
		queue.process(async (job) => {
			started.push((job.data as { applicationId: string }).applicationId);
			await (started.length === 1 ? first.promise : second.promise);
		});
		await queue.add(appJob("a"));
		await queue.add(appJob("a"));
		await flush();
		const [active] = await queue.getJobs(["active"]);
		queue.releaseActive(active?.id as string, { keepGroupLock: true });
		queue.dropKeptGroupLock(active?.id as string);
		await flush();
		// The second deploy of the service runs now; a third waits behind it.
		expect(started).toEqual(["a", "a"]);
		await queue.add(appJob("a"));
		await flush();
		expect(started).toEqual(["a", "a"]);

		first.resolve();
		await flush();

		// The first processor's late return took nobody's lock.
		expect(started).toEqual(["a", "a"]);
		expect(await queue.getJobs(["waiting"])).toHaveLength(1);
		second.resolve();
	});

	it("is false when nothing is kept, and when the processor already returned", async () => {
		const { queue, hung, id } = await setup();
		hung.resolve();
		await flush();

		expect(queue.hasKeptGroupLock(id)).toBe(false);
		expect(queue.dropKeptGroupLock(id)).toBe(false);
		expect(queue.dropKeptGroupLock("job-999")).toBe(false);
	});

	it("cannot be dropped twice", async () => {
		const { queue, id, hung } = await setup();

		expect(queue.dropKeptGroupLock(id)).toBe(true);
		expect(queue.dropKeptGroupLock(id)).toBe(false);
		hung.resolve();
	});
});
