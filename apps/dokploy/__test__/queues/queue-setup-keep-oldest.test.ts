import { describe, expect, it, vi } from "vitest";

/**
 * The queueSetup helpers over a real InMemoryQueue: the explicit clean-queues
 * "keepOldest" mode and the push-hook coalescing, which folds a push into the
 * oldest waiting deploy. Everything around the queue (DB, journal, worker gate)
 * is mocked; the first job of a service never finishes, so it stays active.
 */

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	updateApplicationStatus: vi.fn(),
	updateCompose: vi.fn(),
	updatePreviewDeployment: vi.fn(),
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));
vi.mock("../../server/queues/concurrency", () => ({
	resolveBuildsConcurrency: () => 1,
}));
vi.mock("../../server/queues/deployments-queue", () => ({
	processDeploymentJob: () => new Promise(() => {}),
}));
vi.mock("../../server/queues/lifecycle", () => ({
	gateWorkerUntilRestored: () => ({ open: () => {} }),
	registerShutdownHandler: () => {},
}));
vi.mock("../../server/queues/queue-journal", () => ({
	createQueueJournal: () => ({ journal: undefined, restore: vi.fn() }),
	dbJournalStore: {},
}));

import type { DeploymentJob } from "../../server/queues/queue-types";
import {
	cleanQueuesByApplication,
	cleanQueuesByCompose,
	coalesceQueuedApplicationDeploys,
	coalesceQueuedComposeDeploys,
	keepOldestQueuesByApplication,
	keepOldestQueuesByCompose,
	myQueue,
} from "../../server/queues/queueSetup";

// One partition (server) per test: its first job never finishes, so it holds
// the single slot and every later job of the test waits.
let partition = 0;

const flush = () => new Promise((r) => setTimeout(r, 0));

const appJob = (
	applicationId: string,
	titleLog: string,
	type: "deploy" | "redeploy" = "deploy",
	applicationType: "application" | "application-preview" = "application",
) =>
	({
		applicationId,
		titleLog,
		descriptionLog: "",
		type,
		applicationType,
		serverId: `srv-${partition}`,
		...(applicationType === "application-preview"
			? { previewDeploymentId: "pv-1" }
			: {}),
	}) as DeploymentJob;

const composeJob = (
	composeId: string,
	titleLog: string,
	type: "deploy" | "redeploy" = "deploy",
) =>
	({
		composeId,
		titleLog,
		descriptionLog: "",
		type,
		applicationType: "compose",
		serverId: `srv-${partition}`,
	}) as DeploymentJob;

const titles = async () =>
	(await myQueue.getJobs(["waiting"])).map(
		(job) => (job.data as { titleLog: string }).titleLog,
	);

const reset = async () => {
	partition++;
	myQueue.clearWaiting();
};

describe("keepOldestQueuesByApplication", () => {
	it("keeps the oldest deploy and the redeploy, drops later deploys, spares the active job and other services", async () => {
		await reset();
		await myQueue.add("deployments", appJob("A", "active"));
		await flush();
		await myQueue.add("deployments", appJob("A", "d1"));
		await myQueue.add("deployments", appJob("B", "b1"));
		await myQueue.add("deployments", appJob("A", "d2"));
		await myQueue.add("deployments", appJob("A", "r1", "redeploy"));
		await myQueue.add("deployments", appJob("B", "b2"));
		await myQueue.add("deployments", appJob("A", "d3"));

		const result = await keepOldestQueuesByApplication("A");

		expect(result.kept.map((job) => job.type)).toEqual(["deploy", "redeploy"]);
		expect(result.removed).toHaveLength(2);
		expect(result.removed.map((job) => job.type)).toEqual(["deploy", "deploy"]);
		expect(Object.keys(result)).toEqual(["kept", "removed"]);
		expect(await titles()).toEqual(["d1", "b1", "r1", "b2"]);
		const active = await myQueue.getJobs(["active"]);
		expect(active.map((job) => (job.data as any).titleLog)).toEqual(["active"]);
	});

	it("leaves a queued PR preview of the application alone", async () => {
		await reset();
		await myQueue.add("deployments", appJob("P", "p1"));
		await flush();
		await myQueue.add("deployments", appJob("P", "d1"));
		await myQueue.add(
			"deployments",
			appJob("P", "preview", "deploy", "application-preview"),
		);
		await myQueue.add("deployments", appJob("P", "d2"));

		const result = await keepOldestQueuesByApplication("P");

		expect(result.removed).toHaveLength(1);
		expect(await titles()).toEqual(["d1", "preview"]);
	});
});

describe("keepOldestQueuesByCompose", () => {
	it("drops later waiting deploys of the stack only", async () => {
		await reset();
		await myQueue.add("deployments", composeJob("C", "c-active"));
		await flush();
		await myQueue.add("deployments", composeJob("C", "c1"));
		await myQueue.add("deployments", composeJob("D", "other"));
		await myQueue.add("deployments", composeJob("C", "c2"));

		const result = await keepOldestQueuesByCompose("C");

		expect(result.kept).toHaveLength(1);
		expect(result.removed).toHaveLength(1);
		expect(await titles()).toEqual(["c1", "other"]);
	});
});

describe("default mode (cleanQueuesBy*) is unchanged", () => {
	it("drops every waiting job of the application, previews included", async () => {
		await reset();
		await myQueue.add("deployments", appJob("A2", "active"));
		await flush();
		await myQueue.add("deployments", appJob("A2", "d1"));
		await myQueue.add("deployments", appJob("A2", "d2"));
		await myQueue.add(
			"deployments",
			appJob("A2", "preview", "deploy", "application-preview"),
		);
		await myQueue.add("deployments", appJob("B2", "b1"));

		const removed = await cleanQueuesByApplication("A2");

		expect(removed).toBe(3);
		expect(await titles()).toEqual(["b1"]);
	});

	it("drops every waiting job of the compose stack", async () => {
		await reset();
		await myQueue.add("deployments", composeJob("C2", "active"));
		await flush();
		await myQueue.add("deployments", composeJob("C2", "c1"));
		await myQueue.add("deployments", composeJob("C2", "c2", "redeploy"));

		expect(await cleanQueuesByCompose("C2")).toBe(2);
		expect(await titles()).toEqual([]);
	});
});

describe("push-hook coalescing folds the push into the oldest waiting deploy", () => {
	it("a burst leaves one waiting deploy, at the first position, with the newest title", async () => {
		await reset();
		await myQueue.add("deployments", appJob("A3", "active"));
		await flush();
		// What a webhook does: coalesce, then enqueue only if nothing absorbed it.
		const push = async (title: string) => {
			const job = appJob("A3", title);
			const result = await coalesceQueuedApplicationDeploys("A3", job);
			if (!result.merged) await myQueue.add("deployments", job);
			return result;
		};
		await push("first push");
		await myQueue.add("deployments", appJob("A3", "redo", "redeploy"));
		await myQueue.add("deployments", appJob("Z3", "other service"));
		const second = await push("second push");
		const third = await push("third push");

		expect(second).toEqual({
			removed: 1,
			titles: ["first push"],
			merged: true,
		});
		expect(third).toEqual({
			removed: 1,
			titles: ["second push"],
			merged: true,
		});
		expect(await titles()).toEqual(["third push", "redo", "other service"]);
	});

	it("reports no merge when nothing of the stack waits, so the caller enqueues", async () => {
		await reset();
		await myQueue.add("deployments", composeJob("C3", "active"));
		await flush();
		await myQueue.add("deployments", composeJob("C4", "other"));

		const result = await coalesceQueuedComposeDeploys(
			"C3",
			composeJob("C3", "push"),
		);

		expect(result).toEqual({ removed: 0, titles: [], merged: false });
		expect(await titles()).toEqual(["other"]);
	});

	it("never touches a PR preview or an active job", async () => {
		await reset();
		await myQueue.add("deployments", appJob("A5", "active"));
		await flush();
		await myQueue.add(
			"deployments",
			appJob("A5", "preview", "deploy", "application-preview"),
		);

		const result = await coalesceQueuedApplicationDeploys(
			"A5",
			appJob("A5", "push"),
		);

		expect(result.merged).toBe(false);
		expect(await titles()).toEqual(["preview"]);
	});
});
