import { describe, expect, it } from "vitest";
import { InMemoryQueue } from "../../server/queues/in-memory-queue";
import type { DeploymentJob } from "../../server/queues/queue-types";

/**
 * Explicit keepOldest: what counts as a duplicate, and what "oldest" means.
 */

const pinned = (digest: string) => ({
	ref: "registry.example.com/org/app",
	tag: "abc",
	digest,
});

const composeJob = (
	composeId: string,
	titleLog: string,
	extra: Record<string, unknown> = {},
	type: "deploy" | "redeploy" = "deploy",
): DeploymentJob =>
	({
		composeId,
		titleLog,
		descriptionLog: "",
		type,
		applicationType: "compose",
		...extra,
	}) as DeploymentJob;

const appJob = (
	applicationId: string,
	titleLog: string,
	extra: Record<string, unknown> = {},
): DeploymentJob =>
	({
		applicationId,
		titleLog,
		descriptionLog: "",
		type: "deploy",
		applicationType: "application",
		...extra,
	}) as DeploymentJob;

const isService = (id: string) => (data: DeploymentJob) =>
	(data as { applicationId?: string; composeId?: string }).applicationId ===
		id || (data as { composeId?: string }).composeId === id;

const blocked = (now?: () => number) => {
	const queue = new InMemoryQueue({ resolveConcurrency: () => 1, now });
	queue.process(() => new Promise(() => {}));
	return queue;
};

const flush = () => new Promise((r) => setTimeout(r, 0));

const titlesOf = async (queue: InMemoryQueue) =>
	(await queue.getJobs(["waiting"])).map(
		(job) => (job.data as { titleLog: string }).titleLog,
	);

/** Occupy the single slot so everything added next stays waiting. */
const occupy = async (queue: InMemoryQueue, job: DeploymentJob) => {
	await queue.add(job);
	await flush();
};

describe("keepOldestWaiting: what is a duplicate", () => {
	it("keeps a job that differs in freshVolumes", async () => {
		const queue = blocked();
		await occupy(queue, composeJob("C", "active"));
		await queue.add(composeJob("C", "plain-1"));
		await queue.add(composeJob("C", "fresh-1", { freshVolumes: true }));
		await queue.add(composeJob("C", "plain-2"));
		await queue.add(composeJob("C", "fresh-2", { freshVolumes: true }));

		const result = queue.keepOldestWaiting(isService("C"));

		expect(result.removed).toHaveLength(2);
		expect(await titlesOf(queue)).toEqual(["plain-1", "fresh-1"]);
	});

	it("treats a missing freshVolumes and freshVolumes false as the same", async () => {
		const queue = blocked();
		await occupy(queue, composeJob("C", "active"));
		await queue.add(composeJob("C", "unset"));
		await queue.add(composeJob("C", "false", { freshVolumes: false }));

		queue.keepOldestWaiting(isService("C"));

		expect(await titlesOf(queue)).toEqual(["unset"]);
	});

	it("keeps a job that pins a different image, drops one that pins the same", async () => {
		const queue = blocked();
		await occupy(queue, appJob("A", "active"));
		await queue.add(appJob("A", "build"));
		await queue.add(appJob("A", "pin-1", { pinnedImage: pinned("sha256:1") }));
		await queue.add(appJob("A", "pin-2", { pinnedImage: pinned("sha256:2") }));
		await queue.add(
			appJob("A", "pin-1-again", { pinnedImage: pinned("sha256:1") }),
		);
		await queue.add(appJob("A", "build-2"));

		const result = queue.keepOldestWaiting(isService("A"));

		expect(result.removed).toHaveLength(2);
		expect(await titlesOf(queue)).toEqual(["build", "pin-1", "pin-2"]);
	});

	it("keeps a job that differs in priority or priorityBy", async () => {
		const queue = blocked();
		await occupy(queue, appJob("A", "active"));
		await queue.add(appJob("A", "normal"));
		await queue.add(
			appJob("A", "urgent-u1", { priority: true, priorityBy: "u1" }),
		);
		await queue.add(
			appJob("A", "urgent-u2", { priority: true, priorityBy: "u2" }),
		);
		await queue.add(
			appJob("A", "urgent-u1-again", { priority: true, priorityBy: "u1" }),
		);
		await queue.add(appJob("A", "normal-2"));

		const result = queue.keepOldestWaiting(isService("A"));

		expect(result.removed).toHaveLength(2);
		expect(await titlesOf(queue)).toEqual(["normal", "urgent-u1", "urgent-u2"]);
	});

	it("never lets deploy and redeploy displace each other", async () => {
		const queue = blocked();
		await occupy(queue, composeJob("C", "active"));
		await queue.add(composeJob("C", "redeploy-1", {}, "redeploy"));
		await queue.add(composeJob("C", "deploy-1"));
		await queue.add(composeJob("C", "redeploy-2", {}, "redeploy"));

		queue.keepOldestWaiting(isService("C"));

		expect(await titlesOf(queue)).toEqual(["redeploy-1", "deploy-1"]);
	});
});

describe("keepOldestWaiting: oldest means queue position", () => {
	it("keeps the first of two jobs enqueued in the same millisecond", async () => {
		const queue = blocked(() => 5_000);
		await occupy(queue, appJob("A", "active"));
		const first = await queue.add(appJob("A", "first"));
		await queue.add(appJob("A", "second"));
		await queue.add(appJob("A", "third"));

		const result = queue.keepOldestWaiting(isService("A"));

		expect(result.kept.map((job) => job.jobId)).toEqual([first.id]);
		expect(await titlesOf(queue)).toEqual(["first"]);
	});

	it("keeps the first in line when the clock steps backwards", async () => {
		let clock = 9_000;
		const queue = blocked(() => clock--);
		await occupy(queue, appJob("A", "active"));
		const first = await queue.add(appJob("A", "first"));
		const second = await queue.add(appJob("A", "second"));
		const [a, b] = await queue.getJobs(["waiting"]);
		expect(b?.timestamp).toBeLessThan(a?.timestamp as number);

		const result = queue.keepOldestWaiting(isService("A"));

		// The second job has the smaller timestamp but the later position.
		expect(result.kept.map((job) => job.jobId)).toEqual([first.id]);
		expect(result.removed.map((job) => job.jobId)).toEqual([second.id]);
	});

	it("keeps one oldest per partition, each lane on its own", async () => {
		const queue = blocked();
		await occupy(queue, appJob("A", "active-local"));
		await occupy(queue, appJob("A", "active-remote", { serverId: "srv-1" }));
		await queue.add(appJob("A", "local-1"));
		await queue.add(appJob("A", "remote-1", { serverId: "srv-1" }));
		await queue.add(appJob("A", "local-2"));
		await queue.add(appJob("A", "remote-2", { serverId: "srv-1" }));

		const result = queue.keepOldestWaiting(isService("A"));

		expect(result.kept).toHaveLength(2);
		expect(result.removed).toHaveLength(2);
		expect((await titlesOf(queue)).sort()).toEqual(["local-1", "remote-1"]);
	});
});
