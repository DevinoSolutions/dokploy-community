import { beforeEach, describe, expect, test, vi } from "vitest";
import { DeploymentQueueManager } from "../../server/queues/queue-manager";
import type { DeploymentJob } from "../../server/queues/queue-types";

const deferred = <T = void>() => {
	let resolve!: (v: T) => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

const makeJob = (overrides: Partial<DeploymentJob> = {}): DeploymentJob =>
	({
		applicationId: "app-1",
		titleLog: "t",
		descriptionLog: "d",
		type: "deploy",
		applicationType: "application",
		...overrides,
	}) as DeploymentJob;

describe("DeploymentQueueManager", () => {
	let manager: DeploymentQueueManager;

	beforeEach(() => {
		manager = new DeploymentQueueManager({
			defaultConcurrency: 1,
			concurrencyProvider: () => undefined,
		});
	});

	test("routes jobs with different target keys into separate pools", async () => {
		const gate = deferred();
		const running: string[] = [];
		manager.setHandler(async (job) => {
			running.push(
				`${resolveKey(job)}:${(job as { applicationId: string }).applicationId}`,
			);
			await gate.promise;
		});

		// concurrency=1 per target, two different targets, they must run in parallel.
		await manager.add(makeJob({ applicationId: "a", serverId: "srv-A" }));
		await manager.add(makeJob({ applicationId: "b", serverId: "srv-B" }));
		await Promise.resolve();
		await Promise.resolve();

		expect(running).toHaveLength(2);
		gate.resolve();
	});

	test("same target + same service key serialises (FIFO)", async () => {
		const gate1 = deferred();
		const gate2 = deferred();
		let idx = 0;
		const order: string[] = [];
		manager.setHandler(async (job) => {
			order.push(`start:${(job as { applicationId: string }).applicationId}`);
			await (idx++ === 0 ? gate1.promise : gate2.promise);
			order.push(`done:${(job as { applicationId: string }).applicationId}`);
		});

		const j1 = await manager.add(makeJob({ applicationId: "a" }));
		const j2 = await manager.add(makeJob({ applicationId: "a" }));
		await Promise.resolve();
		expect(order).toEqual(["start:a"]);

		gate1.resolve();
		await j1.done;
		await Promise.resolve();
		expect(order).toEqual(["start:a", "done:a", "start:a"]);

		gate2.resolve();
		await j2.done;
	});

	test("cancelAllJobs fans out across every target and aborts in-flight (regression for upstream #3744 cleanAllDeploymentQueue)", async () => {
		manager = new DeploymentQueueManager({
			defaultConcurrency: 1,
			concurrencyProvider: () => undefined,
		});
		manager.setHandler(async (_job, signal) => {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason));
			});
		});

		const j1 = await manager.add(
			makeJob({ applicationId: "a", serverId: "srv-A" }),
		);
		const j2 = await manager.add(
			makeJob({ applicationId: "b", serverId: "srv-B" }),
		);
		await Promise.resolve();

		manager.cancelAllJobs("wipe");
		await expect(j1.done).rejects.toThrow("wipe");
		await expect(j2.done).rejects.toThrow("wipe");
	});

	test("cancelWhere scopes cancellation to one application across all targets", async () => {
		const gate = deferred();
		manager = new DeploymentQueueManager({
			defaultConcurrency: 1,
			concurrencyProvider: () => undefined,
		});
		manager.setHandler(async (_job, signal) => {
			await new Promise<void>((resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason));
				gate.promise.then(resolve);
			});
		});

		const jKeep = await manager.add(
			makeJob({ applicationId: "keep", serverId: "srv-A" }),
		);
		const jKillA = await manager.add(
			makeJob({ applicationId: "kill", serverId: "srv-A" }),
		);
		const jKillB = await manager.add(
			makeJob({ applicationId: "kill", serverId: "srv-B" }),
		);
		await Promise.resolve();

		const removed = manager.cancelWhere(
			(job) =>
				(job.applicationType === "application" ||
					job.applicationType === "application-preview") &&
				job.applicationId === "kill",
		);
		expect(removed).toBeGreaterThanOrEqual(1);

		await expect(jKillA.done).rejects.toThrow();
		await expect(jKillB.done).rejects.toThrow();

		gate.resolve();
		await expect(jKeep.done).resolves.toBeUndefined();
	});

	test("concurrencyProvider seeds per-target concurrency on first enqueue", async () => {
		const provider = vi.fn(async (key: string) => (key === "srv-A" ? 3 : 1));
		manager = new DeploymentQueueManager({
			defaultConcurrency: 1,
			concurrencyProvider: provider,
		});
		const gate = deferred();
		manager.setHandler(async () => {
			await gate.promise;
		});

		await manager.add(makeJob({ applicationId: "a", serverId: "srv-A" }));
		await manager.add(makeJob({ applicationId: "b", serverId: "srv-A" }));
		await manager.add(makeJob({ applicationId: "c", serverId: "srv-A" }));
		await Promise.resolve();
		await Promise.resolve();

		expect(manager.getConcurrency("srv-A")).toBe(3);
		expect(provider).toHaveBeenCalledWith("srv-A");
		gate.resolve();
	});

	test("updateConcurrency does not drop pending jobs", async () => {
		const gate = deferred();
		manager.setHandler(async () => {
			await gate.promise;
		});
		await manager.add(makeJob({ applicationId: "a", serverId: "srv" }));
		await manager.add(makeJob({ applicationId: "b", serverId: "srv" })); // different service → pending
		await Promise.resolve();

		await manager.updateConcurrency("srv", 2);
		await Promise.resolve();

		const summary = manager.summarize();
		expect(summary.active).toHaveLength(2);
		gate.resolve();
	});

	test("updateConcurrency rejects out-of-range values", async () => {
		await expect(manager.updateConcurrency("srv", 0)).rejects.toThrow();
		await expect(manager.updateConcurrency("srv", 11)).rejects.toThrow();
	});

	test("close aborts in-flight and rejects pending across every target", async () => {
		manager.setHandler(async (_job, signal) => {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason));
			});
		});
		const j1 = await manager.add(makeJob({ applicationId: "a" }));
		await Promise.resolve();
		await manager.close("bye");
		await expect(j1.done).rejects.toThrow("bye");
	});

	test("concurrent first-add for the same target does NOT orphan a queue (regression)", async () => {
		let providerCalls = 0;
		const providerGate = deferred();
		manager = new DeploymentQueueManager({
			defaultConcurrency: 1,
			concurrencyProvider: async () => {
				providerCalls++;
				await providerGate.promise;
				return 1;
			},
		});

		const started = new Set<string>();
		const handlerGate = deferred();
		manager.setHandler(async (job) => {
			started.add((job as { applicationId: string }).applicationId);
			await handlerGate.promise;
		});

		// Two concurrent enqueues for the SAME never-seen target. Before the
		// fix, both would miss the cache, both would create queues, and the
		// `Map.set` race would orphan one queue + its job.
		const p1 = manager.add(makeJob({ applicationId: "a", serverId: "srv-X" }));
		const p2 = manager.add(makeJob({ applicationId: "b", serverId: "srv-X" }));
		providerGate.resolve();
		const [j1, j2] = await Promise.all([p1, p2]);

		// Provider called exactly once → both callers converged on one queue.
		expect(providerCalls).toBe(1);

		// concurrency=1 on this target → only one active, one pending.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(started.size).toBe(1);
		expect(manager.summarize().pending).toHaveLength(1);

		handlerGate.resolve();
		await j1.done;
		await j2.done;
		expect(started.size).toBe(2);
	});

	test("getOrCreate failure does not poison the target slot", async () => {
		let attempt = 0;
		manager = new DeploymentQueueManager({
			defaultConcurrency: 1,
			concurrencyProvider: async () => {
				attempt++;
				if (attempt === 1) throw new Error("db blip");
				return 1;
			},
		});
		manager.setHandler(async () => {});

		await expect(
			manager.add(makeJob({ applicationId: "a", serverId: "flaky" })),
		).rejects.toThrow("db blip");

		// Retry against the same target works.
		const j2 = await manager.add(
			makeJob({ applicationId: "b", serverId: "flaky" }),
		);
		await expect(j2.done).resolves.toBeUndefined();
		expect(attempt).toBe(2);
	});
});

// Local helper duplicated from queue-router to keep this test file independent
// of router internals beyond its public contract.
function resolveKey(job: DeploymentJob): string {
	if (job.applicationType === "compose") return job.serverId ?? "local";
	return job.buildServerId ?? job.serverId ?? "local";
}
