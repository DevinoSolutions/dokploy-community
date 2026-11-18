import type { DeploymentQueueJobRow } from "@dokploy/server/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@dokploy/server/services/deployment-cancel", () => ({
	stopBuildOnBuildServer: vi.fn(),
}));

import {
	killOrphanedBuilds,
	ORPHAN_KILL_BUDGET_MS,
	resetOrphanKillBoot,
	whenOrphanKillsSettled,
} from "@dokploy/server/services/orphan-build-kill";
import { InMemoryQueue } from "../../server/queues/in-memory-queue";
import { gateWorkerUntilRestored } from "../../server/queues/lifecycle";
import {
	createQueueJournal,
	type JournalStore,
} from "../../server/queues/queue-journal";
import type { DeploymentJob } from "../../server/queues/queue-types";

const job = (applicationId: string): DeploymentJob => ({
	applicationId,
	titleLog: applicationId,
	descriptionLog: "",
	type: "deploy",
	applicationType: "application",
});

const store = (): JournalStore => {
	const rows: DeploymentQueueJobRow[] = [
		{
			jobId: "j1",
			seq: 1,
			payload: job("replayed") as unknown as Record<string, unknown>,
			state: "active",
			attempts: 0,
			enqueuedAt: new Date(1_700_000_000_000),
			startedAt: new Date(),
		},
	];
	return {
		insert: vi.fn(async () => {}),
		markActive: vi.fn(async () => {}),
		updatePayload: vi.fn(async () => {}),
		remove: vi.fn(async () => {}),
		list: vi.fn(async () => rows),
		requeueInterrupted: vi.fn(async () => {}),
		markInterrupted: vi.fn(async () => 0),
	};
};

beforeEach(() => {
	resetOrphanKillBoot();
	vi.useFakeTimers();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("a replayed job never starts next to the orphan it replaces", () => {
	it("holds when the gate timer opened before the kill was even registered", async () => {
		const started: string[] = [];
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
		const { restore } = createQueueJournal(store(), {
			beforeReplay: whenOrphanKillsSettled,
		});
		gateWorkerUntilRestored(queue, 30_000, whenOrphanKillsSettled);
		queue.process(async (queued) => {
			started.push((queued.data as { applicationId: string }).applicationId);
		});

		// The timer opens the gate: no kill is registered yet, so it opens fully.
		await vi.advanceTimersByTimeAsync(30_001);

		// Only now does the boot find an orphan on a slow build server.
		let finishKill!: () => void;
		void killOrphanedBuilds([{ deploymentId: "old", buildServerId: "b1" }], {
			stop: () =>
				new Promise((resolve) => {
					finishKill = () => resolve({ result: "KILLED" });
				}),
		});
		const restored = restore(queue);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(started).toEqual([]);

		finishKill();
		await vi.advanceTimersByTimeAsync(0);
		await expect(restored).resolves.toMatchObject({ restored: 1 });
		await vi.advanceTimersByTimeAsync(0);
		expect(started).toEqual(["replayed"]);
	});

	it("is bounded by the shared budget when the build server never answers", async () => {
		const started: string[] = [];
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
		queue.process(async (queued) => {
			started.push((queued.data as { applicationId: string }).applicationId);
		});
		void killOrphanedBuilds([{ deploymentId: "old", buildServerId: "b1" }], {
			stop: () => new Promise(() => {}),
		});
		const { restore } = createQueueJournal(store(), {
			beforeReplay: whenOrphanKillsSettled,
		});

		const restored = restore(queue);
		await vi.advanceTimersByTimeAsync(ORPHAN_KILL_BUDGET_MS - 1_000);
		expect(started).toEqual([]);
		await vi.advanceTimersByTimeAsync(1_100);

		await expect(restored).resolves.toMatchObject({ restored: 1 });
		await vi.advanceTimersByTimeAsync(0);
		expect(started).toEqual(["replayed"]);
	});

	it("does not delay the restore when nothing was orphaned", async () => {
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
		const { restore } = createQueueJournal(store(), {
			beforeReplay: whenOrphanKillsSettled,
		});

		await expect(restore(queue)).resolves.toMatchObject({ restored: 1 });
	});
});
