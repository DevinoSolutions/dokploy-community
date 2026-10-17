import { describe, expect, it, vi } from "vitest";
import {
	InMemoryQueue,
	type QueueJournal,
} from "../../server/queues/in-memory-queue";
import type { DeploymentJob } from "../../server/queues/queue-types";

const appJob = (
	applicationId: string,
	type: "deploy" | "redeploy" = "deploy",
	extra: Record<string, unknown> = {},
): DeploymentJob =>
	({
		applicationId,
		titleLog: `${type} ${applicationId}`,
		descriptionLog: "",
		type,
		applicationType: "application",
		...extra,
	}) as DeploymentJob;

const isApp = (applicationId: string) => (data: DeploymentJob) =>
	(data as { applicationId?: string }).applicationId === applicationId;

/** A queue with one slot whose first job never finishes, so the rest wait. */
const blockedQueue = (journal?: QueueJournal) => {
	let clock = 1_000;
	const queue = new InMemoryQueue({
		resolveConcurrency: () => 1,
		now: () => ++clock,
		journal,
	});
	queue.process(() => new Promise(() => {}));
	return queue;
};

const flush = () => new Promise((r) => setTimeout(r, 0));

const waitingIds = async (queue: InMemoryQueue) =>
	(await queue.getJobs(["waiting"])).map((job) => job.id);

describe("InMemoryQueue.keepOldestWaiting", () => {
	// Service A: 1 active deploy, then 3 waiting deploys and 1 waiting redeploy,
	// interleaved with service B's two waiting jobs.
	const setup = async (journal?: QueueJournal) => {
		const queue = blockedQueue(journal);
		const ids: Record<string, string> = {};
		const add = async (name: string, job: DeploymentJob) => {
			ids[name] = (await queue.add(job)).id;
		};
		await add("aActive", appJob("A"));
		await flush();
		await add("aDeploy1", appJob("A"));
		await add("b1", appJob("B"));
		await add("aDeploy2", appJob("A"));
		await add("aRedeploy", appJob("A", "redeploy"));
		await add("b2", appJob("B"));
		await add("aDeploy3", appJob("A"));
		return { queue, ids };
	};

	it("keeps the oldest waiting job of each type and drops the later ones", async () => {
		const { queue, ids } = await setup();

		const result = queue.keepOldestWaiting(isApp("A"));

		expect(result.removed.map((job) => job.jobId)).toEqual([
			ids.aDeploy2,
			ids.aDeploy3,
		]);
		expect(result.removed.every((job) => job.type === "deploy")).toBe(true);
		// deploy and redeploy are separate types: both survive.
		expect(result.kept.map((job) => [job.jobId, job.type])).toEqual([
			[ids.aDeploy1, "deploy"],
			[ids.aRedeploy, "redeploy"],
		]);
		for (const job of [...result.kept, ...result.removed]) {
			expect(new Date(job.enqueuedAt).toISOString()).toBe(job.enqueuedAt);
		}
	});

	it("never touches the active job or another service", async () => {
		const { queue, ids } = await setup();

		queue.keepOldestWaiting(isApp("A"));

		const active = await queue.getJobs(["active"]);
		expect(active.map((job) => job.id)).toEqual([ids.aActive]);
		expect(await waitingIds(queue)).toEqual([
			ids.aDeploy1,
			ids.b1,
			ids.aRedeploy,
			ids.b2,
		]);
	});

	it("leaves the kept job where it was, without re-enqueueing it", async () => {
		const { queue, ids } = await setup();
		const before = await queue.getJobs(["waiting"]);
		const keptBefore = before.find((job) => job.id === ids.aDeploy1);

		queue.keepOldestWaiting(isApp("A"));

		const after = await queue.getJobs(["waiting"]);
		const keptAfter = after.find((job) => job.id === ids.aDeploy1);
		// Same id, same enqueue time, still ahead of service B's first job.
		expect(keptAfter?.timestamp).toBe(keptBefore?.timestamp);
		const order = after.map((job) => job.id);
		expect(order.indexOf(ids.aDeploy1 as string)).toBeLessThan(
			order.indexOf(ids.b1 as string),
		);
	});

	it("does nothing and reports nothing kept when the service has no waiting job", async () => {
		const { queue } = await setup();
		const result = queue.keepOldestWaiting(isApp("nobody"));
		expect(result.kept).toEqual([]);
		expect(result.removed).toEqual([]);
		expect(await queue.getJobs(["waiting"])).toHaveLength(6);
	});

	it("keeps a lone job and is idempotent", async () => {
		const { queue, ids } = await setup();
		queue.keepOldestWaiting(isApp("B"));
		const again = queue.keepOldestWaiting(isApp("B"));
		expect(again.removed).toEqual([]);
		expect(again.kept.map((job) => job.jobId)).toEqual([ids.b1]);
		// b2 was dropped by the first pass.
		expect(await waitingIds(queue)).not.toContain(ids.b2);
	});

	it("settles only the removed jobs in the journal", async () => {
		const settled: string[][] = [];
		const journal: QueueJournal = {
			enqueued: () => {},
			started: () => {},
			settled: (journalIds) => settled.push(journalIds),
		};
		const { queue } = await setup(journal);
		settled.length = 0;
		const waiting = await queue.getJobs(["waiting"]);
		const idToJournal = new Map(waiting.map((j) => [j.id, j.journalId]));

		const { removed } = queue.keepOldestWaiting(isApp("A"));

		expect(settled).toEqual([
			removed.map((job) => idToJournal.get(job.jobId) as string),
		]);
	});

	it("honours the predicate (a preview of the same app is not a duplicate)", async () => {
		const queue = blockedQueue();
		await queue.add(appJob("A"));
		await flush();
		const deploy = await queue.add(appJob("A"));
		const preview = await queue.add(
			appJob("A", "deploy", {
				applicationType: "application-preview",
				previewDeploymentId: "pv-1",
			}),
		);
		const second = await queue.add(appJob("A"));

		const result = queue.keepOldestWaiting(
			(data) =>
				isApp("A")(data) &&
				(data as { applicationType: string }).applicationType === "application",
		);

		expect(result.removed.map((job) => job.jobId)).toEqual([second.id]);
		expect(await waitingIds(queue)).toEqual([deploy.id, preview.id]);
	});

	it("keeps the earliest enqueue time when a restored job sits at the front", async () => {
		const queue = blockedQueue();
		await queue.add(appJob("A"));
		await flush();
		const live = await queue.add(appJob("A"));
		queue.addRestored([
			{ journalId: "restored-1", data: appJob("A"), timestamp: 1 },
		]);

		const result = queue.keepOldestWaiting(isApp("A"));

		expect(result.kept).toHaveLength(1);
		expect(result.kept[0]?.enqueuedAt).toBe(new Date(1).toISOString());
		expect(result.removed.map((job) => job.jobId)).toEqual([live.id]);
	});

	it("leaves removeWaiting dropping every waiting job of the service", async () => {
		const { queue, ids } = await setup();
		expect(queue.removeWaiting(isApp("A"))).toBe(4);
		expect(await waitingIds(queue)).toEqual([ids.b1, ids.b2]);
		expect((await queue.getJobs(["active"])).map((j) => j.id)).toEqual([
			ids.aActive,
		]);
	});

	it("is unaffected by a throwing journal", async () => {
		const journal: QueueJournal = {
			enqueued: () => {},
			started: () => {},
			settled: vi.fn(() => {
				throw new Error("journal down");
			}),
		};
		const queue = blockedQueue(journal);
		await queue.add(appJob("A"));
		await flush();
		await queue.add(appJob("A"));
		await queue.add(appJob("A"));
		expect(queue.keepOldestWaiting(isApp("A")).removed).toHaveLength(1);
	});
});
