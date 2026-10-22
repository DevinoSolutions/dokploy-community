import { describe, expect, it, vi } from "vitest";
import {
	InMemoryQueue,
	type QueueJournal,
} from "../../server/queues/in-memory-queue";
import type { DeploymentJob } from "../../server/queues/queue-types";

const appJob = (applicationId: string): DeploymentJob => ({
	applicationId,
	titleLog: `deploy ${applicationId}`,
	descriptionLog: "",
	type: "deploy",
	applicationType: "application",
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** One slot whose first job never finishes, so every other job waits. */
const setup = async () => {
	const settled: string[][] = [];
	const journal: QueueJournal = {
		enqueued: vi.fn(),
		started: vi.fn(),
		settled: (ids) => settled.push(ids),
	};
	const started: string[] = [];
	const queue = new InMemoryQueue({ resolveConcurrency: () => 1, journal });
	queue.process(async (job) => {
		started.push((job.data as { applicationId: string }).applicationId);
		await new Promise(() => {});
	});
	const active = await queue.add(appJob("active"));
	await flush();
	const first = await queue.add(appJob("first"));
	const second = await queue.add(appJob("second"));
	return { queue, active, first, second, settled, started };
};

describe("InMemoryQueue.removeWaitingJob", () => {
	it("removes one waiting job, leaves the others in place and settles its journal row", async () => {
		const { queue, first, second, settled } = await setup();
		const firstJournalId = (await queue.getJobs(["waiting"])).find(
			(job) => job.id === first.id,
		)?.journalId;

		expect(queue.removeWaitingJob(first.id)).toBe(true);

		const waiting = await queue.getJobs(["waiting"]);
		expect(waiting.map((job) => job.id)).toEqual([second.id]);
		expect(settled).toEqual([[firstJournalId]]);
	});

	it("refuses a job that is running, and leaves it running", async () => {
		const { queue, active, settled } = await setup();

		expect(queue.removeWaitingJob(active.id)).toBe(false);

		expect((await queue.getJobs(["active"])).map((job) => job.id)).toEqual([
			active.id,
		]);
		expect(settled).toEqual([]);
	});

	it("answers false for an unknown id and for a job it already removed", async () => {
		const { queue, first } = await setup();

		expect(queue.removeWaitingJob("nope")).toBe(false);
		expect(queue.removeWaitingJob(first.id)).toBe(true);
		expect(queue.removeWaitingJob(first.id)).toBe(false);
	});

	it("never starts a removed job, so no deployment is ever created for it", async () => {
		const { queue, first, second, started } = await setup();
		queue.removeWaitingJob(first.id);
		queue.removeWaitingJob(second.id);
		await flush();

		expect(started).toEqual(["active"]);
	});
});
