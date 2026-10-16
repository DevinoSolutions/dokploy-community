import type { DeploymentQueueJobRow } from "@dokploy/server/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ captureError: vi.fn() }));

vi.mock("../../server/sentry", () => ({ captureError: mocks.captureError }));

// queue-journal imports the journal functions from the barrel; the tests inject
// a fake store, so keep the heavy barrel (and its db) out of the picture.
vi.mock("@dokploy/server", () => ({
	deleteQueueJobs: vi.fn(),
	insertQueueJob: vi.fn(),
	listQueueJobs: vi.fn(),
	markInterruptedFromJournal: vi.fn(),
	markQueueJobActive: vi.fn(),
	requeueInterruptedQueueJobs: vi.fn(),
	updateQueueJobPayload: vi.fn(),
}));

import { InMemoryQueue } from "../../server/queues/in-memory-queue";
import {
	createQueueJournal,
	type JournalStore,
} from "../../server/queues/queue-journal";
import type { DeploymentJob } from "../../server/queues/queue-types";

/**
 * The priority flag lives in the journaled payload: it is written at enqueue,
 * rewritten when a waiting job is bumped, and read back by the boot replay.
 */

const appJob = (applicationId: string, extra = {}): DeploymentJob => ({
	applicationId,
	titleLog: applicationId,
	descriptionLog: "",
	type: "deploy",
	applicationType: "application",
	...extra,
});

let seq = 0;
const row = (jobId: string, payload: unknown): DeploymentQueueJobRow => ({
	jobId,
	seq: ++seq,
	payload: payload as Record<string, unknown>,
	state: "waiting",
	attempts: 0,
	enqueuedAt: new Date(1_700_000_000_000 + seq * 1000),
	startedAt: null,
});

const makeStore = (rows: DeploymentQueueJobRow[] = []) => {
	const store: JournalStore & { rows: DeploymentQueueJobRow[] } = {
		rows,
		insert: vi.fn(async (jobId, payload) => {
			rows.push(row(jobId, payload));
		}),
		markActive: vi.fn(async () => {}),
		updatePayload: vi.fn(async (jobId, payload) => {
			const r = rows.find((x) => x.jobId === jobId);
			if (r) r.payload = payload;
		}),
		remove: vi.fn(async (ids) => {
			for (const id of ids) {
				const i = rows.findIndex((x) => x.jobId === id);
				if (i >= 0) rows.splice(i, 1);
			}
		}),
		list: vi.fn(async () => [...rows]),
		requeueInterrupted: vi.fn(async () => {}),
		markInterrupted: vi.fn(async () => 0),
	};
	return store;
};

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	seq = 0;
});

describe("journal and the priority flag", () => {
	it("writes the flag with the job at enqueue", async () => {
		const store = makeStore();
		const { journal } = createQueueJournal(store);
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1, journal });

		await queue.add(appJob("a"));
		await queue.add(appJob("p", { priority: true, priorityBy: "ops@x.io" }));

		expect(store.rows.map((r) => r.payload.priority)).toEqual([
			undefined,
			true,
		]);
		expect(store.rows[1]?.payload.priorityBy).toBe("ops@x.io");
	});

	it("does not write a flag the queue dropped because nothing was waiting", async () => {
		const store = makeStore();
		const { journal } = createQueueJournal(store);
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1, journal });

		await queue.add(appJob("p", { priority: true, priorityBy: "ops@x.io" }));

		expect(store.rows[0]?.payload).not.toHaveProperty("priority");
		expect(store.rows[0]?.payload).not.toHaveProperty("priorityBy");
	});

	it("rewrites the payload when a waiting job is bumped, after its insert", async () => {
		const store = makeStore();
		const { journal, flush: flushJournal } = createQueueJournal(store);
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1, journal });
		// No processor: everything stays waiting.
		await queue.add(appJob("a"));
		const b = await queue.add(appJob("b"));

		// Straight after the enqueue, before the insert has necessarily landed.
		expect(queue.prioritize(b.id, "ops@x.io")?.applied).toBe(true);
		await flushJournal();

		expect(store.updatePayload).toHaveBeenCalledTimes(1);
		const stored = store.rows.find((r) => r.payload.applicationId === "b");
		expect(stored?.payload.priority).toBe(true);
		expect(stored?.payload.priorityBy).toBe("ops@x.io");
	});

	it("a journal that cannot update a payload does not stop the bump", async () => {
		const store = makeStore();
		store.updatePayload = vi.fn(async () => {
			throw new Error("db down");
		});
		const { journal, flush: flushJournal } = createQueueJournal(store);
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1, journal });
		await queue.add(appJob("a"));
		const b = await queue.add(appJob("b"));

		expect(queue.prioritize(b.id)?.applied).toBe(true);
		await flushJournal();
		expect(mocks.captureError).toHaveBeenCalledTimes(1);
	});
});

describe("replay keeps the flag", () => {
	it("a flagged job read back from the journal goes ahead of the ones before it", async () => {
		const store = makeStore([
			row("j1", appJob("r1")),
			row("j2", appJob("r2")),
			row("j3", appJob("r3", { priority: true, priorityBy: "ops@x.io" })),
		]);
		const { journal, restore } = createQueueJournal(store);
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1, journal });
		const started: DeploymentJob[] = [];
		queue.pause();
		queue.process(async (job) => {
			started.push(job.data);
		});

		await restore(queue);
		queue.resume();
		await flush();
		await flush();

		const order = started.map(
			(d) => (d as { applicationId: string }).applicationId,
		);
		expect(order).toEqual(["r3", "r1", "r2"]);
		expect(started[0]?.priority).toBe(true);
	});
});
