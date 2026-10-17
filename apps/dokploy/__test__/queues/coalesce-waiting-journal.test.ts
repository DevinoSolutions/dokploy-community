import type { DeploymentQueueJobRow } from "@dokploy/server/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../server/sentry", () => ({ captureError: vi.fn() }));

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
 * A push folded into a waiting deploy must reach the journal row, so memory and
 * the durable copy agree and a restart replays the newest payload.
 */

const push = (titleLog: string, digest?: string): DeploymentJob =>
	({
		applicationId: "A",
		titleLog,
		descriptionLog: `Hash: ${titleLog}`,
		type: "deploy",
		applicationType: "application",
		...(digest ? { pinnedImage: { ref: "r/app", tag: "t", digest } } : {}),
	}) as DeploymentJob;

const isApp = (data: DeploymentJob) =>
	(data as { applicationId?: string }).applicationId === "A";

let seq = 0;
const makeStore = () => {
	const rows: DeploymentQueueJobRow[] = [];
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
		requeueInterrupted: vi.fn(async () => {}),
		markInterrupted: vi.fn(async () => 0),
		updatePayload: vi.fn(async (jobId, payload) => {
			const r = rows.find((x) => x.jobId === jobId);
			if (r) r.payload = payload;
		}),
	};
	return store;
};

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	seq = 0;
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("coalescing and the queue journal", () => {
	it("keeps one row, updated to the newest payload, and a restart replays it", async () => {
		const store = makeStore();
		const { journal } = createQueueJournal(store);
		// The first job runs and stays running, so the pushes below wait.
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1, journal });
		queue.process(() => new Promise(() => {}));
		await queue.add({
			...push("running"),
			applicationId: "R",
		} as DeploymentJob);
		await flush();

		const gate = async (job: DeploymentJob) => {
			const result = queue.coalesceWaiting(job, isApp);
			if (!result.merged) await queue.add(job);
		};
		await gate(push("p1", "sha256:1"));
		await gate(push("p2", "sha256:2"));
		await gate(push("p3", "sha256:3"));
		await flush();
		await flush();

		const waitingRows = store.rows.filter((row) => row.state === "waiting");
		expect(waitingRows).toHaveLength(1);
		expect(waitingRows[0]?.payload).toMatchObject({
			titleLog: "p3",
			pinnedImage: { digest: "sha256:3" },
		});
		const memory = (await queue.getJobs(["waiting"]))[0];
		expect(memory?.journalId).toBe(waitingRows[0]?.jobId);

		// Restart: a fresh queue replays the journal.
		const rebooted = new InMemoryQueue({ resolveConcurrency: () => 1 });
		const { restore } = createQueueJournal(store);
		await restore(rebooted);
		const replayed = await rebooted.getJobs(["waiting"]);
		expect(
			replayed
				.map((job) => job.data)
				.filter(
					(data) => (data as { applicationId?: string }).applicationId === "A",
				),
		).toEqual([
			expect.objectContaining({
				titleLog: "p3",
				pinnedImage: { ref: "r/app", tag: "t", digest: "sha256:3" },
			}),
		]);
	});

	it("deletes the rows of the duplicates it drops", async () => {
		const store = makeStore();
		const { journal } = createQueueJournal(store);
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1, journal });
		queue.process(() => new Promise(() => {}));
		await queue.add({
			...push("running"),
			applicationId: "R",
		} as DeploymentJob);
		await flush();
		await queue.add(push("old-1"));
		await queue.add(push("old-2"));
		await queue.add(push("old-3"));

		queue.coalesceWaiting(push("new"), isApp);
		await flush();
		await flush();

		const rows = store.rows.filter((row) => row.state === "waiting");
		expect(
			rows.map((row) => (row.payload as { titleLog: string }).titleLog),
		).toEqual(["new"]);
	});
});
