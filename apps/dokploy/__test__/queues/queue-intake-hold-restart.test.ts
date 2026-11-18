import type { DeploymentQueueJobRow } from "@dokploy/server/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../server/sentry", () => ({ captureError: vi.fn() }));
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
 * A job accepted while the intake is closed for an update, then a restart:
 * the next process must run it as an ordinary first run.
 */

const appJob = (applicationId: string): DeploymentJob => ({
	applicationId,
	titleLog: `deploy ${applicationId}`,
	descriptionLog: "",
	type: "deploy",
	applicationType: "application",
});

let seq = 0;
const makeStore = (initial: DeploymentQueueJobRow[] = []) => {
	const rows = initial;
	const store: JournalStore & { rows: DeploymentQueueJobRow[] } = {
		rows,
		insert: vi.fn(async (jobId, payload) => {
			rows.push({
				jobId,
				seq: ++seq,
				payload,
				state: "waiting",
				attempts: 0,
				enqueuedAt: new Date(1_700_000_000_000 + seq * 1000),
				startedAt: null,
			});
		}),
		markActive: vi.fn(async (jobId) => {
			const r = rows.find((x) => x.jobId === jobId);
			if (r) r.state = "active";
		}),
		remove: vi.fn(async (ids) => {
			for (const id of ids) {
				const i = rows.findIndex((x) => x.jobId === id);
				if (i >= 0) rows.splice(i, 1);
			}
		}),
		list: vi.fn(async () => [...rows]),
		requeueInterrupted: vi.fn(async (ids) => {
			for (const r of rows) {
				if (ids.includes(r.jobId)) {
					r.state = "waiting";
					r.attempts += 1;
				}
			}
		}),
		markInterrupted: vi.fn(async () => 0),
		updatePayload: vi.fn(async () => {}),
	};
	return store;
};

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	seq = 0;
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("journal.enqueued reports whether the row was written", () => {
	it("resolves true when the insert lands", async () => {
		const { journal } = createQueueJournal(makeStore());

		await expect(
			journal.enqueued({ journalId: "j1", data: appJob("a") }),
		).resolves.toBe(true);
	});

	it("resolves false when the insert fails", async () => {
		const store = makeStore();
		store.insert = vi.fn(async () => {
			throw new Error("db down");
		});
		const { journal } = createQueueJournal(store);

		await expect(
			journal.enqueued({ journalId: "j1", data: appJob("a") }),
		).resolves.toBe(false);
	});

	it("resolves false when the insert is still pending after the timeout", async () => {
		const store = makeStore();
		store.insert = vi.fn(() => new Promise<void>(() => {}));
		const { journal } = createQueueJournal(store, { timeoutMs: 10 });

		await expect(
			journal.enqueued({ journalId: "j1", data: appJob("a") }),
		).resolves.toBe(false);
	});
});

describe("a job accepted while the intake is closed, then a restart", () => {
	it("is restored as a first run: waiting, attempts untouched, not counted as interrupted", async () => {
		const store = makeStore();

		// The old process: update accepted, intake closed, a deploy arrives.
		const first = createQueueJournal(store);
		const oldQueue = new InMemoryQueue({
			resolveConcurrency: () => 1,
			journal: first.journal,
		});
		const oldRan = vi.fn();
		oldQueue.process(async (job) => {
			oldRan(job.data);
		});
		oldQueue.closeIntake(60_000);
		await oldQueue.add(appJob("landing"));
		await flush();
		expect(oldRan).not.toHaveBeenCalled();

		// SIGTERM: nothing starts, the journal is flushed, the process exits.
		await oldQueue.close();
		await first.flush();
		expect(store.rows).toHaveLength(1);
		expect(store.rows[0]).toMatchObject({ state: "waiting", attempts: 0 });

		// The new process boots and replays the journal.
		const second = createQueueJournal(store);
		const newQueue = new InMemoryQueue({
			resolveConcurrency: () => 1,
			journal: second.journal,
		});
		const ran: DeploymentJob[] = [];
		newQueue.pause();
		newQueue.process(async (job) => {
			ran.push(job.data);
		});
		const result = await second.restore(newQueue);

		expect(result).toEqual({ restored: 1, interrupted: 0, dropped: 0 });
		// No job was running, so no attempt is counted and no row is requeued.
		expect(store.requeueInterrupted).toHaveBeenCalledWith([]);
		expect(store.rows[0]).toMatchObject({ state: "waiting", attempts: 0 });

		newQueue.resume();
		await flush();
		expect(
			ran.map((data) => (data as { applicationId: string }).applicationId),
		).toEqual(["landing"]);
	});

	it("contrast: a job that was RUNNING when the process died is the interrupted kind", async () => {
		const store = makeStore();
		const first = createQueueJournal(store);
		const oldQueue = new InMemoryQueue({
			resolveConcurrency: () => 1,
			journal: first.journal,
		});
		oldQueue.process(() => new Promise<void>(() => {}));
		await oldQueue.add(appJob("running"));
		await flush();
		await first.flush();
		expect(store.rows[0]).toMatchObject({ state: "active" });

		const second = createQueueJournal(store);
		const newQueue = new InMemoryQueue({
			resolveConcurrency: () => 1,
			journal: second.journal,
		});
		const result = await second.restore(newQueue);

		expect(result).toEqual({ restored: 1, interrupted: 1, dropped: 0 });
		expect(store.rows[0]).toMatchObject({ attempts: 1 });
	});
});
