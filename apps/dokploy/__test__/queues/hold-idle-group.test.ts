import { describe, expect, it } from "vitest";
import {
	getGroup,
	InMemoryQueue,
	LOCAL_PARTITION,
} from "../../server/queues/in-memory-queue";
import type { DeploymentJob } from "../../server/queues/queue-types";

// A compose Fetch rewrites the code dir a deploy reads, so it takes the
// compose's group lock, the one the queue's own jobs hold while they run, and
// only while nothing of the compose runs. A deploy that only waits keeps its
// place and starts once the lock is released (T-8239).

const composeJob = (composeId: string): DeploymentJob => ({
	composeId,
	titleLog: `deploy ${composeId}`,
	descriptionLog: "",
	type: "deploy",
	applicationType: "compose",
});

const flush = () => new Promise((r) => setTimeout(r, 0));

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

/** A queue whose jobs run until `finish` is called for their compose. */
const setup = (concurrency = 2) => {
	const started: string[] = [];
	const gates = new Map<string, ReturnType<typeof deferred>>();
	const queue = new InMemoryQueue({ resolveConcurrency: () => concurrency });
	queue.process(async (job) => {
		const { composeId } = job.data as { composeId: string };
		started.push(composeId);
		const gate = deferred();
		gates.set(composeId, gate);
		await gate.promise;
	});
	const finish = async (composeId: string) => {
		gates.get(composeId)?.resolve();
		await flush();
	};
	return { queue, started, finish };
};

const group = (composeId: string) => getGroup(composeJob(composeId));

describe("InMemoryQueue.holdIdleGroup", () => {
	it("takes the lock of an idle compose and gives it back", async () => {
		const { queue } = setup();

		const hold = queue.holdIdleGroup(LOCAL_PARTITION, group("cmp-1"));

		expect("release" in hold).toBe(true);
		if ("release" in hold) hold.release();
		expect(
			"release" in queue.holdIdleGroup(LOCAL_PARTITION, group("cmp-1")),
		).toBe(true);
	});

	it("is refused while a job of the compose runs", async () => {
		const { queue, finish } = setup();
		await queue.add(composeJob("cmp-1"));
		await flush();

		expect(queue.holdIdleGroup(LOCAL_PARTITION, group("cmp-1"))).toEqual({
			busy: "running",
		});

		await finish("cmp-1");
		expect(
			"release" in queue.holdIdleGroup(LOCAL_PARTITION, group("cmp-1")),
		).toBe(true);
	});

	it("is refused while a job of the compose runs in another partition", async () => {
		const { queue } = setup();
		await queue.add({ ...composeJob("cmp-1"), serverId: "srv-1" });
		await flush();

		expect(queue.holdIdleGroup(LOCAL_PARTITION, group("cmp-1"))).toEqual({
			busy: "running",
		});
	});

	it("is taken while a job of the compose only waits, which starts once it is released", async () => {
		const { queue, started, finish } = setup(1);
		// The only slot of the server's lane is taken, so the compose's job waits.
		await queue.add({ ...composeJob("cmp-other"), serverId: "srv-1" });
		await flush();
		await queue.add({ ...composeJob("cmp-1"), serverId: "srv-1" });

		const hold = queue.holdIdleGroup("srv-1", group("cmp-1"));
		if (!("release" in hold)) throw new Error("expected the lock");

		// The slot frees up, but the waiting deploy is held back by the lock.
		await finish("cmp-other");
		expect(started).toEqual(["cmp-other"]);
		expect((await queue.getJobs(["waiting"])).length).toBe(1);

		hold.release();
		await flush();
		expect(started).toEqual(["cmp-other", "cmp-1"]);
	});

	it("is refused while a released job of the compose kept its lock", async () => {
		const { queue } = setup();
		const job = await queue.add(composeJob("cmp-1"));
		await flush();
		queue.releaseActive(job.id, { keepGroupLock: true });

		expect(queue.holdIdleGroup(LOCAL_PARTITION, group("cmp-1"))).toEqual({
			busy: "running",
		});
	});

	it("is refused while another hold has the lock", () => {
		const { queue } = setup();
		queue.holdIdleGroup(LOCAL_PARTITION, group("cmp-1"));

		expect(queue.holdIdleGroup(LOCAL_PARTITION, group("cmp-1"))).toEqual({
			busy: "held",
		});
	});

	it("keeps a deploy of the compose waiting until it is released, and leaves other services alone", async () => {
		const { queue, started } = setup();
		const hold = queue.holdIdleGroup(LOCAL_PARTITION, group("cmp-1"));
		if (!("release" in hold)) throw new Error("expected the lock");

		await queue.add(composeJob("cmp-1"));
		await queue.add(composeJob("cmp-2"));
		await flush();
		expect(started).toEqual(["cmp-2"]);

		hold.release();
		await flush();
		expect(started).toEqual(["cmp-2", "cmp-1"]);
	});

	it("releases once: a second release does not free a job that started since", async () => {
		const { queue, started } = setup();
		const hold = queue.holdIdleGroup(LOCAL_PARTITION, group("cmp-1"));
		if (!("release" in hold)) throw new Error("expected the lock");
		await queue.add(composeJob("cmp-1"));
		hold.release();
		await flush();
		expect(started).toEqual(["cmp-1"]);

		hold.release();
		await queue.add(composeJob("cmp-1"));
		await flush();

		// The second deploy still waits for the first: the group is the job's.
		expect(started).toEqual(["cmp-1"]);
	});
});
