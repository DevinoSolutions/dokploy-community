import { describe, expect, it } from "vitest";
import { InMemoryQueue } from "../../server/queues/in-memory-queue";
import type { DeploymentJob } from "../../server/queues/queue-types";

/**
 * A queued deploy that carries a registered GitHub Actions deployment (T-12686) and leaves the queue without running
 * must be reported, so its row can be ended: the run poller leaves rows with a deploy on the way alone. A job that
 * runs is never reported.
 */

const job = (
	applicationId: string,
	deploymentId?: string,
	extra: Partial<DeploymentJob> = {},
): DeploymentJob =>
	({
		applicationId,
		titleLog: "deploy",
		descriptionLog: "",
		type: "deploy",
		applicationType: "application",
		...(deploymentId ? { deploymentId } : {}),
		...extra,
	}) as DeploymentJob;

const isApp = (id: string) => (data: DeploymentJob) =>
	(data as { applicationId?: string }).applicationId === id;

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A queue whose first job never ends, so every later job of the same application waits. */
const busyQueue = async () => {
	const dropped: string[][] = [];
	const queue = new InMemoryQueue({
		resolveConcurrency: () => 5,
		onWaitingDropped: (jobs) =>
			dropped.push(
				jobs.map(
					(data) => (data as { deploymentId?: string }).deploymentId ?? "-",
				),
			),
	});
	const started: string[] = [];
	queue.process(async (running) => {
		started.push(
			(running.data as { deploymentId?: string }).deploymentId ?? "-",
		);
		await new Promise<void>(() => {});
	});
	await queue.run();
	await queue.add(job("A"));
	await flush();
	return { queue, dropped, started };
};

describe("waiting deploys that carry a registered deployment", () => {
	it("reports a job removed by id while it waits", async () => {
		const { queue, dropped } = await busyQueue();
		const waiting = await queue.add(job("A", "dep-1"));
		expect(queue.removeWaitingJob(waiting.id)).toBe(true);
		expect(dropped).toEqual([["dep-1"]]);
	});

	it("reports the jobs a predicate removes, and the ones a clean-all drops", async () => {
		const { queue, dropped } = await busyQueue();
		await queue.add(job("A", "dep-1"));
		await queue.add(job("A", "dep-2"));
		expect(queue.removeWaiting(isApp("A"))).toBe(2);
		expect(dropped.flat().sort()).toEqual(["dep-1", "dep-2"]);

		await queue.add(job("A", "dep-3"));
		expect(queue.clearWaiting()).toBe(1);
		expect(dropped.flat()).toContain("dep-3");
	});

	it("reports the older payload that a newer push replaces, but not the job that is merged into", async () => {
		const { queue, dropped } = await busyQueue();
		await queue.add(job("A", "dep-old"));
		const merged = queue.coalesceWaiting(job("A", "dep-new"), isApp("A"));
		expect(merged.merged).not.toBeNull();
		expect(dropped.flat()).toEqual(["dep-old"]);
	});

	it("keeps the registered deployment on the merged job when a plain deploy coalesces over it, and reports nothing", async () => {
		const { queue, dropped } = await busyQueue();
		await queue.add(job("A", "dep-1", { titleLog: "GHA deploy" }));
		// A UI redeploy or a registry webhook: no deploymentId of its own.
		const outcome = queue.coalesceWaiting(
			job("A", undefined, { titleLog: "Manual deployment" }),
			isApp("A"),
		);
		expect(outcome.merged).not.toBeNull();
		expect(dropped).toEqual([]);
		const waiting = (await queue.getJobs(["waiting"])).map(
			(w) => w.data as { deploymentId?: string; titleLog?: string },
		);
		expect(waiting).toEqual([
			expect.objectContaining({
				deploymentId: "dep-1",
				titleLog: "Manual deployment",
			}),
		]);
	});

	it("keeps the id of a dropped twin when the merge target has none, and reports only the ids that are lost", async () => {
		const { queue, dropped } = await busyQueue();
		await queue.add(job("A"));
		await queue.add(job("A", "dep-1"));
		await queue.add(job("A", "dep-2"));
		queue.coalesceWaiting(job("A"), isApp("A"));
		const waiting = (await queue.getJobs(["waiting"])).map(
			(w) => (w.data as { deploymentId?: string }).deploymentId,
		);
		expect(waiting).toEqual(["dep-1"]);
		expect(dropped.flat()).toEqual(["dep-2"]);
	});

	it("cancels the old row, and only it, when the incoming deploy carries a different registered deployment", async () => {
		const { queue, dropped } = await busyQueue();
		await queue.add(job("A", "dep-old"));
		queue.coalesceWaiting(job("A", "dep-new"), isApp("A"));
		expect(dropped).toEqual([["dep-old"]]);
		const waiting = (await queue.getJobs(["waiting"])).map(
			(w) => (w.data as { deploymentId?: string }).deploymentId,
		);
		expect(waiting).toEqual(["dep-new"]);
	});

	it("does not report a retry that carries the same registered deployment", async () => {
		const { queue, dropped } = await busyQueue();
		await queue.add(job("A", "dep-1"));
		queue.coalesceWaiting(job("A", "dep-1"), isApp("A"));
		expect(dropped).toEqual([]);
	});

	it("reports a duplicate dropped by keep-oldest", async () => {
		const { queue, dropped } = await busyQueue();
		await queue.add(job("A", "dep-1"));
		await queue.add(job("A", "dep-2"));
		queue.keepOldestWaiting(isApp("A"));
		expect(dropped.flat()).toEqual(["dep-2"]);
	});

	it("never reports a job that runs", async () => {
		const dropped: unknown[] = [];
		const queue = new InMemoryQueue({
			resolveConcurrency: () => 5,
			onWaitingDropped: (jobs) => dropped.push(...jobs),
		});
		const ran: string[] = [];
		queue.process(async (running) => {
			ran.push((running.data as { deploymentId?: string }).deploymentId ?? "-");
		});
		await queue.run();
		await queue.add(job("B", "dep-9"));
		await flush();
		expect(ran).toEqual(["dep-9"]);
		expect(dropped).toEqual([]);
	});

	it("survives a hook that throws", async () => {
		const queue = new InMemoryQueue({
			resolveConcurrency: () => 5,
			onWaitingDropped: () => {
				throw new Error("boom");
			},
		});
		queue.process(async () => {
			await new Promise<void>(() => {});
		});
		await queue.run();
		await queue.add(job("A"));
		const waiting = await queue.add(job("A", "dep-1"));
		await flush();
		expect(queue.removeWaitingJob(waiting.id)).toBe(true);
	});
});
