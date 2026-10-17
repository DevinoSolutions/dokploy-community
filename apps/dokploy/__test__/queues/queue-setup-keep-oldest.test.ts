import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The queueSetup helpers over a real InMemoryQueue: the explicit clean-queues
 * "keepOldest" mode and the push-hook coalescing, which folds a push into the
 * oldest waiting deploy. Everything around the queue (DB, journal, worker gate)
 * is mocked; the first job of a service never finishes, so it stays active.
 */

// What the boot replay puts in the queue and which units coalesce, per test.
const boot = vi.hoisted(() => {
	const nothingRestored = { restored: 0, interrupted: 0, dropped: 0 };
	return {
		nothingRestored,
		replay: async (_queue: unknown): Promise<typeof nothingRestored> =>
			nothingRestored,
		enforced: new Set<string>(),
		/** Units whose policy lookup throws. */
		failFor: new Set<string>(),
		/** Units the post-restore pass looked up, in order. */
		lookups: [] as string[],
		/** Runs when the worker gate opens. */
		onOpen: () => {},
	};
});

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
	gateWorkerUntilRestored: () => ({ open: () => boot.onOpen() }),
	registerShutdownHandler: () => {},
}));
vi.mock("../../server/queues/queue-journal", () => ({
	createQueueJournal: () => ({
		journal: undefined,
		restore: (queue: unknown) => boot.replay(queue),
	}),
	dbJournalStore: {},
}));
vi.mock("@dokploy/server/services/build-policy/webhook", () => ({
	isCoalescingEnforcedForUnit: async (unitType: string, unitId: string) => {
		const key = `${unitType}:${unitId}`;
		boot.lookups.push(key);
		if (boot.failFor.has(key)) throw new Error("policy lookup failed");
		return boot.enforced.has(key);
	},
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

		// `removed` counts jobs taken out of the queue, not the one merged into.
		expect(second).toEqual({
			removed: 0,
			titles: ["first push"],
			merged: true,
		});
		expect(third).toEqual({
			removed: 0,
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

describe("boot restore dedupes the units that coalesce", () => {
	/** The journal replay: these jobs land at the front, as addRestored does. */
	const replayOf =
		(...jobs: Array<{ id: string; data: DeploymentJob }>) =>
		async (queue: unknown) => {
			const restored = (
				queue as {
					addRestored: (
						jobs: Array<{
							journalId: string;
							data: DeploymentJob;
							timestamp: number;
						}>,
					) => number;
				}
			).addRestored(
				jobs.map((job, index) => ({
					journalId: job.id,
					data: job.data,
					timestamp: 1_700_000_000_000 + index,
				})),
			);
			return { restored, interrupted: 0, dropped: 0 };
		};

	const restoreWith = async (
		enforced: string[],
		replay: ReturnType<typeof replayOf>,
	) => {
		boot.enforced = new Set(enforced);
		boot.replay = replay;
		return myQueue.restore();
	};

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		boot.replay = async () => boot.nothingRestored;
		boot.enforced = new Set();
		boot.failFor = new Set();
		boot.lookups = [];
		boot.onOpen = () => {};
		vi.restoreAllMocks();
	});

	it("keeps the restored job when a push enqueued ahead of the replay finished", async () => {
		await reset();
		await myQueue.add("deployments", appJob("R1", "active"));
		await flush();
		// The push that beat the replay, and an unrelated service.
		await myQueue.add("deployments", appJob("R1", "push before replay"));
		await myQueue.add("deployments", appJob("R2", "other"));

		await restoreWith(
			["application:R1"],
			replayOf({ id: "j-restored", data: appJob("R1", "restored") }),
		);

		expect(await titles()).toEqual(["restored", "other"]);
		const active = await myQueue.getJobs(["active"]);
		expect(
			active
				.filter((job) => (job.data as any).applicationId === "R1")
				.map((job) => (job.data as any).titleLog),
		).toEqual(["active"]);
	});

	it("does the same for a compose stack", async () => {
		await reset();
		await myQueue.add("deployments", composeJob("RC", "c-active"));
		await flush();
		await myQueue.add("deployments", composeJob("RC", "push before replay"));

		await restoreWith(
			["compose:RC"],
			replayOf({ id: "j-c", data: composeJob("RC", "restored") }),
		);

		expect(await titles()).toEqual(["restored"]);
	});

	it("leaves jobs that are not duplicates: other type, flags, previews", async () => {
		await reset();
		await myQueue.add("deployments", appJob("R3", "active"));
		await flush();
		await myQueue.add("deployments", appJob("R3", "redeploy", "redeploy"));
		await myQueue.add("deployments", {
			...appJob("R3", "fresh"),
			freshVolumes: true,
		} as DeploymentJob);
		await myQueue.add(
			"deployments",
			appJob("R3", "preview", "deploy", "application-preview"),
		);

		await restoreWith(
			["application:R3"],
			replayOf({ id: "j-r3", data: appJob("R3", "restored") }),
		);

		expect(await titles()).toEqual([
			"restored",
			"redeploy",
			"fresh",
			"preview",
		]);
	});

	it("touches nothing for a unit whose organization does not coalesce", async () => {
		await reset();
		await myQueue.add("deployments", appJob("R4", "active"));
		await flush();
		await myQueue.add("deployments", appJob("R4", "push before replay"));

		await restoreWith(
			[],
			replayOf({ id: "j-r4", data: appJob("R4", "restored") }),
		);

		expect(await titles()).toEqual(["restored", "push before replay"]);
	});

	it("a failing policy lookup skips only that unit", async () => {
		await reset();
		await myQueue.add("deployments", appJob("R5", "active"));
		await myQueue.add("deployments", appJob("R6", "active"));
		await flush();
		await myQueue.add("deployments", appJob("R5", "push before replay"));
		await myQueue.add("deployments", appJob("R6", "push before replay"));
		boot.failFor = new Set(["application:R5"]);

		const result = await restoreWith(
			["application:R5", "application:R6"],
			replayOf(
				{ id: "j-r5", data: appJob("R5", "restored r5") },
				{ id: "j-r6", data: appJob("R6", "restored r6") },
			),
		);

		expect(result.restored).toBe(2);
		expect(boot.lookups).toEqual(["application:R5", "application:R6"]);
		// R5 keeps its pair, R6 was still deduped after R5's lookup threw.
		expect(await titles()).toEqual([
			"restored r5",
			"restored r6",
			"push before replay",
		]);
	});

	it("dedupes before the worker gate opens", async () => {
		await reset();
		await myQueue.add("deployments", appJob("R7", "active"));
		await flush();
		await myQueue.add("deployments", appJob("R7", "push before replay"));
		let atOpen: Promise<unknown[]> | undefined;
		const opened = vi.fn(() => {
			// getJobs snapshots the queue synchronously, so this is the state the
			// worker would start from.
			atOpen = myQueue
				.getJobs(["waiting"])
				.then((jobs) => jobs.map((job) => (job.data as any).titleLog));
		});
		boot.onOpen = opened;

		await restoreWith(
			["application:R7"],
			replayOf({ id: "j-r7", data: appJob("R7", "restored") }),
		);

		expect(opened).toHaveBeenCalledTimes(1);
		expect(await atOpen).toEqual(["restored"]);
	});

	it("opens the gate even when the pass itself fails", async () => {
		await reset();
		await myQueue.add("deployments", appJob("R8", "active"));
		await flush();
		await myQueue.add("deployments", appJob("R8", "push before replay"));
		const opened = vi.fn();
		boot.onOpen = opened;
		boot.failFor = new Set(["application:R8"]);

		await restoreWith(
			["application:R8"],
			replayOf({ id: "j-r8", data: appJob("R8", "restored") }),
		);

		expect(opened).toHaveBeenCalledTimes(1);
		expect(await titles()).toEqual(["restored", "push before replay"]);
	});

	it("does no lookup when the replay restored nothing", async () => {
		await reset();
		await myQueue.add("deployments", appJob("R9", "active"));
		await flush();
		await myQueue.add("deployments", appJob("R9", "d1"));
		await myQueue.add("deployments", appJob("R9", "d2"));

		await restoreWith(["application:R9"], async () => boot.nothingRestored);

		expect(boot.lookups).toEqual([]);
		expect(await titles()).toEqual(["d1", "d2"]);
	});

	it("does no lookup for units with a single waiting job", async () => {
		await reset();
		// One slot per partition: only R10 runs, everything else waits.
		await myQueue.add("deployments", appJob("R10", "active"));
		await flush();
		await myQueue.add("deployments", appJob("R11", "lone push before replay"));

		await restoreWith(
			["application:R10", "application:R11"],
			replayOf({ id: "j-r10", data: appJob("R10", "restored") }),
		);

		expect(boot.lookups).toEqual([]);
		expect(await titles()).toEqual(["restored", "lone push before replay"]);
	});
});
