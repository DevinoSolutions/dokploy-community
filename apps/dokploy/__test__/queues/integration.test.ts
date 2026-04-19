import { describe, expect, test } from "vitest";
import { DeploymentQueueManager } from "../../server/queues/queue-manager";
import type { DeploymentJob } from "../../server/queues/queue-types";

/**
 * End-to-end queue lifecycle against the real `DeploymentQueueManager`, with
 * the handler stubbed out. Exercises the scenarios that the Hetzner smoke
 * plan in docs/ will re-verify against live containers: parallel target
 * isolation, per-service FIFO, dynamic concurrency change, cancel-in-flight.
 *
 * These tests are redundant with the unit tests in isolation, but as a
 * *batch* they are the closest we can get to a production smoke without
 * Postgres + Docker.
 */

const makeAppJob = (id: string, serverId?: string): DeploymentJob => ({
	applicationId: id,
	titleLog: "Smoke deploy",
	descriptionLog: "",
	type: "deploy",
	applicationType: "application",
	...(serverId ? { serverId } : {}),
});

const defer = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

describe("queue integration smoke", () => {
	test("parallel targets + concurrency change + cancel-in-flight + graceful close", async () => {
		const manager = new DeploymentQueueManager({
			defaultConcurrency: 1,
			concurrencyProvider: () => undefined,
		});

		const running = new Set<string>();
		const order: string[] = [];

		manager.setHandler(async (job, signal) => {
			const id = (job as { applicationId: string }).applicationId;
			running.add(id);
			order.push(`start:${id}`);
			try {
				await new Promise<void>((resolve, reject) => {
					const onAbort = () =>
						reject(
							signal.reason instanceof Error
								? signal.reason
								: new Error("aborted"),
						);
					if (signal.aborted) return onAbort();
					signal.addEventListener("abort", onAbort, { once: true });
					// Park until we're cancelled or closed — the test drives the lifecycle.
					setTimeout(resolve, 60_000).unref?.();
				});
			} finally {
				running.delete(id);
				order.push(`end:${id}`);
			}
		});

		// 1. Parallel targets ---------------------------------------------------
		// local + srv-A + srv-B with default concurrency=1 each.
		// 3 jobs → all three should run concurrently (different targets).
		const jLocal = await manager.add(makeAppJob("local-1"));
		const jA1 = await manager.add(makeAppJob("a-1", "srv-A"));
		const jB1 = await manager.add(makeAppJob("b-1", "srv-B"));
		// Yield enough microtasks for the scheduler to dispatch.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(running.has("local-1")).toBe(true);
		expect(running.has("a-1")).toBe(true);
		expect(running.has("b-1")).toBe(true);

		// 2. Same target + different service enqueued — pending while srv-A runs.
		const jA2 = await manager.add(makeAppJob("a-2", "srv-A"));
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(running.has("a-2")).toBe(false);
		expect(manager.summarize().pending.length).toBe(1);

		// 3. Dynamic concurrency change — raise srv-A to 3. a-2 should dispatch
		//    without flushing anything.
		await manager.updateConcurrency("srv-A", 3);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(running.has("a-2")).toBe(true);

		// 4. Cancel one in-flight job — handler's abort signal fires and done
		//    rejects. Other jobs keep running.
		manager.cancelJob(jA1.jobId, "cancelled by user");
		await expect(jA1.done).rejects.toThrow(/cancelled/i);
		expect(running.has("a-1")).toBe(false);
		expect(running.has("a-2")).toBe(true);
		expect(running.has("b-1")).toBe(true);

		// 5. Graceful close aborts everything and resolves.
		await manager.close("smoke shutdown");
		await expect(jLocal.done).rejects.toThrow(/shutdown/);
		await expect(jA2.done).rejects.toThrow(/shutdown/);
		await expect(jB1.done).rejects.toThrow(/shutdown/);
		expect(running.size).toBe(0);
	});

	test("per-service FIFO survives concurrency headroom", async () => {
		const manager = new DeploymentQueueManager({
			defaultConcurrency: 4,
			concurrencyProvider: () => undefined,
		});
		const starts: string[] = [];
		const gate = defer();
		manager.setHandler(async (job) => {
			starts.push(
				`${(job as { applicationId: string }).applicationId}:${job.titleLog}`,
			);
			await gate.promise;
		});

		// Two deploys for the SAME app — must serialise even though the pool
		// has headroom.
		const j1 = await manager.add(makeAppJob("app-x"));
		const j2 = await manager.add({
			...makeAppJob("app-x"),
			titleLog: "Second",
		});
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(starts).toEqual(["app-x:Smoke deploy"]);

		gate.resolve();
		await j1.done;
		await j2.done;
		expect(starts).toEqual(["app-x:Smoke deploy", "app-x:Second"]);
		await manager.close();
	});
});
