import { describe, expect, it, vi } from "vitest";
import {
	InMemoryQueue,
	type QueueJournal,
} from "../../server/queues/in-memory-queue";
import type { DeploymentJob } from "../../server/queues/queue-types";

/**
 * Push-hook coalescing: a push is folded into the oldest waiting deploy of the
 * unit instead of queueing behind it, so N pushes make one build of the newest
 * commit at the earliest slot.
 */

const image = (digest: string) => ({
	ref: "registry.example.com/org/app",
	tag: digest.slice(-4),
	digest,
});

const push = (
	applicationId: string,
	titleLog: string,
	extra: Record<string, unknown> = {},
): DeploymentJob =>
	({
		applicationId,
		titleLog,
		descriptionLog: `Hash: ${titleLog}`,
		type: "deploy",
		applicationType: "application",
		...extra,
	}) as DeploymentJob;

const isApp = (id: string) => (data: DeploymentJob) =>
	(data as { applicationId?: string }).applicationId === id &&
	(data as { applicationType?: string }).applicationType === "application";

const recordingJournal = () => {
	const calls = {
		updated: [] as Array<[string, DeploymentJob]>,
		settled: [] as string[][],
	};
	const journal: QueueJournal = {
		enqueued: () => {},
		started: () => {},
		settled: (ids) => calls.settled.push(ids),
		updated: (id, data) => calls.updated.push([id, data]),
	};
	return { journal, calls };
};

const setup = async (journal?: QueueJournal) => {
	const queue = new InMemoryQueue({ resolveConcurrency: () => 1, journal });
	queue.process(() => new Promise(() => {}));
	await queue.add(push("A", "running"));
	await new Promise((r) => setTimeout(r, 0));
	return queue;
};

const waiting = async (queue: InMemoryQueue) => queue.getJobs(["waiting"]);
const titles = async (queue: InMemoryQueue) =>
	(await waiting(queue)).map(
		(job) => (job.data as { titleLog: string }).titleLog,
	);

/** What a webhook does: coalesce, and enqueue only when nothing absorbed it. */
const pushThroughGate = async (queue: InMemoryQueue, job: DeploymentJob) => {
	const result = queue.coalesceWaiting(job, isApp("A"));
	if (!result.merged) await queue.add(job);
	return result;
};

describe("coalesceWaiting", () => {
	it("a burst p1,p2,p3 leaves one waiting job at p1's position carrying p3", async () => {
		const { journal, calls } = recordingJournal();
		const queue = await setup(journal);
		await queue.add(push("B", "other-before"));
		// p1 goes in through the normal path: nothing is waiting for A yet.
		const first = await pushThroughGate(queue, push("A", "p1"));
		await queue.add(push("B", "other-after"));
		const second = await pushThroughGate(queue, push("A", "p2"));
		const third = await pushThroughGate(queue, push("A", "p3"));

		expect(first.merged).toBeNull();
		expect(second.merged).not.toBeNull();
		expect(third.merged).not.toBeNull();
		// Same position as p1: between the two jobs of B.
		expect(await titles(queue)).toEqual(["other-before", "p3", "other-after"]);
		const kept = (await waiting(queue))[1];
		expect(kept?.id).toBe(third.merged?.jobId);
		expect(kept?.data).toMatchObject({
			titleLog: "p3",
			descriptionLog: "Hash: p3",
		});
		// The journal row of that job was rewritten to p3, twice (p2 then p3).
		expect(calls.updated.map(([id]) => id)).toEqual([
			kept?.journalId,
			kept?.journalId,
		]);
		expect(calls.updated.at(-1)?.[1]).toMatchObject({ titleLog: "p3" });
	});

	it("reports the replaced titles so the audit row names them", async () => {
		const queue = await setup();
		await pushThroughGate(queue, push("A", "p1"));
		const second = await pushThroughGate(queue, push("A", "p2"));
		expect(second.titles).toEqual(["p1"]);
		const third = await pushThroughGate(queue, push("A", "p3"));
		expect(third.titles).toEqual(["p2"]);
	});

	it("a pinned-image burst ends on the newest digest", async () => {
		const queue = await setup();
		await pushThroughGate(
			queue,
			push("A", "p1", { pinnedImage: image("sha256:aaaa") }),
		);
		await pushThroughGate(
			queue,
			push("A", "p2", { pinnedImage: image("sha256:bbbb") }),
		);
		await pushThroughGate(
			queue,
			push("A", "p3", { pinnedImage: image("sha256:cccc") }),
		);

		const jobs = await waiting(queue);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.data).toMatchObject({
			pinnedImage: { digest: "sha256:cccc" },
		});
	});

	it("a push without a pinned image replaces a pinned waiting deploy (newest wins)", async () => {
		const queue = await setup();
		await pushThroughGate(
			queue,
			push("A", "p1", { pinnedImage: image("sha256:aaaa") }),
		);
		await pushThroughGate(queue, push("A", "p2"));

		const jobs = await waiting(queue);
		expect(jobs).toHaveLength(1);
		expect(
			(jobs[0]?.data as { pinnedImage?: unknown }).pinnedImage,
		).toBeUndefined();
	});

	it("keeps the enqueue time and queue position of the first push", async () => {
		const queue = await setup();
		await pushThroughGate(queue, push("A", "p1"));
		const before = (await waiting(queue))[0];
		await pushThroughGate(queue, push("A", "p2"));
		const after = (await waiting(queue))[0];
		expect(after?.id).toBe(before?.id);
		expect(after?.timestamp).toBe(before?.timestamp);
	});

	it("a waiting manual redeploy survives a push", async () => {
		const queue = await setup();
		await queue.add({
			...push("A", "manual redeploy"),
			type: "redeploy",
		} as DeploymentJob);
		await pushThroughGate(queue, push("A", "p1"));
		await pushThroughGate(queue, push("A", "p2"));

		expect(await titles(queue)).toEqual(["manual redeploy", "p2"]);
	});

	it("drops further duplicates behind the kept job and settles them", async () => {
		const { journal, calls } = recordingJournal();
		const queue = await setup(journal);
		// Duplicates that were queued before coalescing existed in this process.
		await queue.add(push("A", "old-1"));
		await queue.add(push("A", "old-2"));
		await queue.add(push("A", "old-3"));
		const all = await waiting(queue);
		calls.settled.length = 0;

		const result = queue.coalesceWaiting(push("A", "new"), isApp("A"));

		expect(result.merged?.jobId).toBe(all[0]?.id);
		expect(result.removed.map((job) => job.jobId)).toEqual([
			all[1]?.id,
			all[2]?.id,
		]);
		expect(result.titles).toEqual(["old-1", "old-2", "old-3"]);
		expect(await titles(queue)).toEqual(["new"]);
		expect(calls.settled).toEqual([[all[1]?.journalId, all[2]?.journalId]]);
	});

	it("does not merge into a job with different freshVolumes", async () => {
		const queue = await setup();
		await queue.add({
			composeId: "C",
			titleLog: "fresh",
			descriptionLog: "",
			type: "deploy",
			applicationType: "compose",
			freshVolumes: true,
		} as DeploymentJob);
		const isCompose = (data: DeploymentJob) =>
			(data as { composeId?: string }).composeId === "C";

		const result = queue.coalesceWaiting(
			{
				composeId: "C",
				titleLog: "push",
				descriptionLog: "",
				type: "deploy",
				applicationType: "compose",
			} as DeploymentJob,
			isCompose,
		);

		expect(result.merged).toBeNull();
		expect(await titles(queue)).toEqual(["fresh"]);
	});

	it("does not merge into a job with a different priority request", async () => {
		const queue = await setup();
		await queue.add(push("A", "first"));
		await queue.add(push("A", "urgent", { priority: true, priorityBy: "u1" }));

		const result = queue.coalesceWaiting(push("A", "push"), isApp("A"));

		expect(result.merged?.jobId).toBe((await waiting(queue))[0]?.id);
		expect(await titles(queue)).toEqual(["push", "urgent"]);
	});

	it("leaves a PR preview and other services alone", async () => {
		const queue = await setup();
		await queue.add(
			push("A", "preview", {
				applicationType: "application-preview",
				previewDeploymentId: "pv-1",
			}),
		);
		await queue.add(push("B", "b-deploy"));

		const result = queue.coalesceWaiting(push("A", "push"), isApp("A"));

		expect(result.merged).toBeNull();
		expect(result.removed).toEqual([]);
		expect(await titles(queue)).toEqual(["preview", "b-deploy"]);
	});

	it("never touches the running job", async () => {
		const queue = await setup();
		const result = queue.coalesceWaiting(push("A", "push"), isApp("A"));
		expect(result.merged).toBeNull();
		expect(
			(await queue.getJobs(["active"])).map(
				(job) => (job.data as { titleLog: string }).titleLog,
			),
		).toEqual(["running"]);
	});

	it("a throwing journal does not break the merge", async () => {
		const journal: QueueJournal = {
			enqueued: () => {},
			started: () => {},
			settled: () => {},
			updated: vi.fn(() => {
				throw new Error("journal down");
			}),
		};
		const queue = await setup(journal);
		await pushThroughGate(queue, push("A", "p1"));
		await pushThroughGate(queue, push("A", "p2"));
		expect(await titles(queue)).toEqual(["p2"]);
	});

	describe("when the matching job waits in another partition", () => {
		const onServer = (
			applicationId: string,
			titleLog: string,
			serverId: string,
			extra: Record<string, unknown> = {},
		) => push(applicationId, titleLog, { serverId, ...extra });

		/** Each server is its own lane with its own never-ending running job. */
		const twoServers = async (journal?: QueueJournal) => {
			const queue = new InMemoryQueue({ resolveConcurrency: () => 1, journal });
			queue.process(() => new Promise(() => {}));
			await queue.add(onServer("X", "running-1", "srv-1"));
			await queue.add(onServer("Y", "running-2", "srv-2"));
			await new Promise((r) => setTimeout(r, 0));
			return queue;
		};

		it("is dropped, not merged into, and the push then enqueues in its own partition", async () => {
			const { journal, calls } = recordingJournal();
			const queue = await twoServers(journal);
			// The service used to build on srv-1 and now deploys to srv-2.
			await queue.add(onServer("A", "stale", "srv-1"));
			const stale = (await waiting(queue))[0];
			calls.settled.length = 0;

			const incoming = onServer("A", "moved", "srv-2");
			const result = queue.coalesceWaiting(incoming, isApp("A"));

			expect(result.merged).toBeNull();
			expect(result.removed.map((job) => job.jobId)).toEqual([stale?.id]);
			expect(result.titles).toEqual(["stale"]);
			expect(calls.settled).toEqual([[stale?.journalId]]);
			expect(calls.updated).toEqual([]);
			expect(await titles(queue)).toEqual([]);

			// What the webhook does when nothing absorbed the push.
			await queue.add(incoming);
			const jobs = await waiting(queue);
			expect(jobs.map((job) => job.data)).toEqual([incoming]);
		});

		it("still merges into the oldest match of its own partition and drops the other one", async () => {
			const queue = await twoServers();
			await queue.add(onServer("A", "stale", "srv-1"));
			await queue.add(onServer("A", "home", "srv-2"));
			const home = (await waiting(queue)).find(
				(job) => (job.data as { titleLog: string }).titleLog === "home",
			);

			const result = queue.coalesceWaiting(
				onServer("A", "push", "srv-2"),
				isApp("A"),
			);

			expect(result.merged?.jobId).toBe(home?.id);
			expect(result.removed).toHaveLength(1);
			expect(result.titles).toEqual(["home", "stale"]);
			expect(await titles(queue)).toEqual(["push"]);
		});
	});
});
