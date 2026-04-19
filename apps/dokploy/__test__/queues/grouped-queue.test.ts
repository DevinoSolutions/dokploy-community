import { beforeEach, describe, expect, test, vi } from "vitest";
import { GroupedQueue } from "../../server/queues/grouped-queue";

type Job = { id: string };

/** Manual promise for precisely controlling handler timing in tests. */
const deferred = <T = void>() => {
	let resolve!: (v: T) => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

describe("GroupedQueue", () => {
	let queue: GroupedQueue<Job>;

	beforeEach(() => {
		queue = new GroupedQueue<Job>(1);
	});

	test("serializes jobs within the same group (FIFO)", async () => {
		const order: string[] = [];
		const gate1 = deferred();
		const gate2 = deferred();
		const gates = [gate1, gate2];
		let idx = 0;
		queue.setHandler(async (data) => {
			order.push(`start:${data.id}`);
			const gate = gates[idx++] ?? gate1;
			await gate.promise;
			order.push(`done:${data.id}`);
		});

		const j1 = queue.add("g1", { id: "a" });
		const j2 = queue.add("g1", { id: "b" });

		// Wait a tick so the scheduler has a chance to start the first task.
		await Promise.resolve();
		expect(order).toEqual(["start:a"]);

		gate1.resolve();
		await j1.done;
		await Promise.resolve();
		expect(order).toEqual(["start:a", "done:a", "start:b"]);

		gate2.resolve();
		await j2.done;
		expect(order).toEqual(["start:a", "done:a", "start:b", "done:b"]);
	});

	test("runs different groups in parallel up to concurrency", async () => {
		queue = new GroupedQueue<Job>(2);
		const starts: string[] = [];
		const gate = deferred();
		queue.setHandler(async (data) => {
			starts.push(data.id);
			await gate.promise;
		});

		queue.add("g1", { id: "a" });
		queue.add("g2", { id: "b" });
		queue.add("g3", { id: "c" }); // blocked: concurrency is 2

		// Allow microtasks to flush so the scheduler dispatches what it can.
		await Promise.resolve();
		await Promise.resolve();
		expect(starts).toHaveLength(2);
		expect(starts).toContain("a");
		expect(starts).toContain("b");

		gate.resolve();
	});

	test("setConcurrency does NOT drop pending jobs (regression for upstream #3744)", async () => {
		const gate = deferred();
		queue.setHandler(async () => {
			await gate.promise;
		});

		queue.add("g1", { id: "a" });
		queue.add("g2", { id: "b" });
		await Promise.resolve();

		// While one is running (concurrency 1), raise the cap.
		queue.setConcurrency(3);
		await Promise.resolve();
		await Promise.resolve();

		// The previously-pending 'b' should now be running too.
		const active = queue.listActive();
		expect(active.map((j) => j.data.id).sort()).toEqual(["a", "b"]);

		gate.resolve();
	});

	test("cancel(jobId) on active job aborts and rejects its promise", async () => {
		const started = deferred();
		const handlerSignal: { value?: AbortSignal } = {};
		queue.setHandler(async (_data, signal) => {
			handlerSignal.value = signal;
			started.resolve();
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason));
			});
		});

		const job = queue.add("g1", { id: "a" });
		await started.promise;

		const ok = queue.cancel(job.jobId, "boom");
		expect(ok).toBe(true);
		await expect(job.done).rejects.toThrow("boom");
		expect(handlerSignal.value?.aborted).toBe(true);
	});

	test("cancel(jobId) on pending job removes it without running the handler", async () => {
		const handler = vi.fn(async () => {
			await new Promise(() => {}); // hang forever — job 'a' occupies the slot
		});
		queue.setHandler(handler);

		queue.add("g1", { id: "a" });
		const j2 = queue.add("g2", { id: "b" });
		// Pending behind concurrency limit
		queue.setConcurrency(1);
		const j3 = queue.add("g2", { id: "c" });

		const removed = queue.cancel(j3.jobId);
		expect(removed).toBe(true);
		await expect(j3.done).rejects.toThrow("Cancelled");

		// j2 should still be there, unaffected.
		expect(queue.listPending().some((j) => j.jobId === j2.jobId)).toBe(true);
	});

	test("cancelAll aborts actives and rejects pendings", async () => {
		const gate = deferred();
		queue = new GroupedQueue<Job>(2);
		queue.setHandler(async (_data, signal) => {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason));
				gate.promise.then(() => reject(new Error("gate never opens in test")));
			});
		});

		const jA = queue.add("g1", { id: "a" });
		const jB = queue.add("g2", { id: "b" });
		const jC = queue.add("g3", { id: "c" });
		await Promise.resolve();

		queue.cancelAll("bye");

		await expect(jA.done).rejects.toThrow("bye");
		await expect(jB.done).rejects.toThrow("bye");
		await expect(jC.done).rejects.toThrow("bye");
	});

	test("cancelWhere scopes cancellation by predicate", async () => {
		const gate = deferred();
		queue = new GroupedQueue<Job>(3);
		queue.setHandler(async (_data, signal) => {
			await new Promise<void>((resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason));
				gate.promise.then(resolve);
			});
		});

		const jA = queue.add("g1", { id: "keep" });
		const jB = queue.add("g2", { id: "kill" });
		const jC = queue.add("g3", { id: "kill" });
		await Promise.resolve();

		const removed = queue.cancelWhere((d) => d.id === "kill");
		expect(removed).toBe(2);

		await expect(jB.done).rejects.toThrow();
		await expect(jC.done).rejects.toThrow();

		gate.resolve();
		await expect(jA.done).resolves.toBeUndefined();
	});

	test("groups are cleaned up once drained (no memory leak)", async () => {
		queue.setHandler(async () => {
			/* instant */
		});
		const j = queue.add("g1", { id: "a" });
		await j.done;
		expect(queue.size()).toBe(0);
	});

	test("close aborts in-flight and rejects pending; subsequent add throws", async () => {
		queue.setHandler(async (_data, signal) => {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason));
			});
		});
		const j1 = queue.add("g1", { id: "a" });
		await Promise.resolve();

		await queue.close("shutdown");
		await expect(j1.done).rejects.toThrow("shutdown");
		expect(() => queue.add("g1", { id: "b" })).toThrow("closed");
	});

	test("handler errors reject the job's done promise without poisoning the queue", async () => {
		let first = true;
		queue.setHandler(async () => {
			if (first) {
				first = false;
				throw new Error("boom");
			}
		});

		const j1 = queue.add("g1", { id: "a" });
		const j2 = queue.add("g1", { id: "b" });

		await expect(j1.done).rejects.toThrow("boom");
		await expect(j2.done).resolves.toBeUndefined();
	});
});
