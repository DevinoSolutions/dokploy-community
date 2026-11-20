import { describe, expect, it } from "vitest";
import type { InMemoryJob } from "../../server/queues/in-memory-queue";
import {
	describeQueueStatus,
	type QueueStatusJob,
} from "../../server/queues/queue-status";

/**
 * What deployment.queueStatus answers for one service (T-12497): queued behind
 * other work, running, or not in the queue; the lane, the place in line and how
 * long it has waited. Pure over a snapshot of the queue, so no queue is needed.
 */

const NOW = 1_700_000_100_000;

let seq = 0;

/** One job of the snapshot; `job` overrides the queue's own fields (timestamp, lane...). */
const entry = (
	state: "waiting" | "active",
	data: Record<string, unknown>,
	job: Partial<InMemoryJob> = {},
): QueueStatusJob => {
	seq++;
	return {
		job: {
			id: `job-${seq}`,
			journalId: `journal-${seq}`,
			name: "deployments",
			data: {
				titleLog: "t",
				descriptionLog: "",
				type: "deploy",
				applicationType: "application",
				...data,
			},
			timestamp: NOW - 60_000,
			...(state === "active" ? { processedOn: NOW - 1_000 } : {}),
			lane: "build",
			getState: async () => state,
			remove: async () => {},
			...job,
		} as InMemoryJob,
	};
};

const waiting = (
	data: Record<string, unknown>,
	job: Partial<InMemoryJob> = {},
) => entry("waiting", data, job);
const active = (
	data: Record<string, unknown>,
	job: Partial<InMemoryJob> = {},
) => entry("active", data, job);

const ctx = { now: NOW, intakeClosed: false, restoring: false };
const app = (applicationId: string) => ({ applicationId });

describe("describeQueueStatus", () => {
	it("says none when nothing of the service is in the queue", () => {
		const jobs = [waiting({ applicationId: "other" })];
		expect(describeQueueStatus(jobs, app("a1"), ctx)).toEqual({
			state: "none",
			lane: null,
			position: null,
			ahead: null,
			waitingSinceMs: null,
			startedAt: null,
			heldReason: null,
			restoring: false,
			queuedBehind: null,
		});
	});

	it("reports a waiting job: queued, its lane, position and how long it waited", () => {
		const jobs = [
			waiting({ applicationId: "x" }),
			waiting({ applicationId: "y" }),
			waiting({ applicationId: "a1" }, { timestamp: NOW - 90_000 }),
		];
		expect(describeQueueStatus(jobs, app("a1"), ctx)).toMatchObject({
			state: "queued",
			lane: "build",
			position: 3,
			ahead: 2,
			waitingSinceMs: 90_000,
			startedAt: null,
		});
	});

	it("is first in line when nothing waits before it", () => {
		expect(
			describeQueueStatus([waiting({ applicationId: "a1" })], app("a1"), ctx),
		).toMatchObject({ state: "queued", position: 1, ahead: 0 });
	});

	it("counts only waiting jobs of the same lane and partition ahead of it", () => {
		const jobs = [
			waiting({ applicationId: "b1" }, { lane: "build" }),
			waiting({ applicationId: "p0" }, { lane: "pull" }),
			waiting({ applicationId: "o1", serverId: "srv-2" }, { lane: "pull" }),
			waiting({ applicationId: "p1" }, { lane: "pull" }),
			waiting({ applicationId: "p2" }, { lane: "pull" }),
		];
		expect(describeQueueStatus(jobs, app("p2"), ctx)).toMatchObject({
			state: "queued",
			lane: "pull",
			position: 3,
			ahead: 2,
		});
		// A running job is not ahead of it: it holds a slot, it does not wait for one.
		const withRunning = [active({ applicationId: "r1" }), ...jobs];
		expect(describeQueueStatus(withRunning, app("p2"), ctx)).toMatchObject({
			position: 3,
			ahead: 2,
		});
	});

	it("reports a running job with when it started and how long it had waited", () => {
		const jobs = [
			active(
				{ applicationId: "a1" },
				{ timestamp: NOW - 300_000, processedOn: NOW - 120_000, lane: "pull" },
			),
		];
		expect(describeQueueStatus(jobs, app("a1"), ctx)).toEqual({
			state: "running",
			lane: "pull",
			position: null,
			ahead: null,
			waitingSinceMs: 180_000,
			startedAt: NOW - 120_000,
			heldReason: null,
			restoring: false,
			queuedBehind: 0,
		});
	});

	it("a running job wins over a newer waiting one of the same service", () => {
		const jobs = [
			waiting({ applicationId: "a1", titleLog: "newer" }),
			active({ applicationId: "a1", titleLog: "older" }, { processedOn: NOW }),
		];
		expect(describeQueueStatus(jobs, app("a1"), ctx).state).toBe("running");
	});

	it("without a deployment id the oldest waiting job of the service answers", () => {
		const jobs = [
			waiting({ applicationId: "x" }),
			waiting(
				{ applicationId: "a1", titleLog: "first" },
				{ timestamp: NOW - 50_000 },
			),
			waiting(
				{ applicationId: "a1", titleLog: "second" },
				{ timestamp: NOW - 10_000 },
			),
		];
		expect(describeQueueStatus(jobs, app("a1"), ctx)).toMatchObject({
			position: 2,
			waitingSinceMs: 50_000,
		});
	});

	it("with a deployment id only the job that carries that row answers", () => {
		const jobs = [
			waiting({ applicationId: "a1", deploymentId: "dep-1" }),
			waiting(
				{ applicationId: "a1", deploymentId: "dep-2" },
				{ timestamp: NOW - 5_000 },
			),
		];
		expect(
			describeQueueStatus(
				jobs,
				{ applicationId: "a1", deploymentId: "dep-2" },
				ctx,
			),
		).toMatchObject({ state: "queued", position: 2, waitingSinceMs: 5_000 });
		expect(
			describeQueueStatus(
				jobs,
				{ applicationId: "a1", deploymentId: "gone" },
				ctx,
			),
		).toMatchObject({ state: "none" });
	});

	it("a deployment id of another service never answers", () => {
		const jobs = [waiting({ applicationId: "other", deploymentId: "dep-1" })];
		expect(
			describeQueueStatus(
				jobs,
				{ applicationId: "a1", deploymentId: "dep-1" },
				ctx,
			),
		).toMatchObject({ state: "none" });
	});

	it("matches composes by compose id, and an application never matches a compose id", () => {
		const compose = waiting({ composeId: "c1", applicationType: "compose" });
		const application = waiting({ applicationId: "c1" });
		expect(
			describeQueueStatus([compose, application], { composeId: "c1" }, ctx),
		).toMatchObject({ state: "queued", position: 1 });
		expect(
			describeQueueStatus([application], { composeId: "c1" }, ctx),
		).toMatchObject({ state: "none" });
	});

	it("ignores preview deploys of the service", () => {
		const jobs = [
			waiting({
				applicationId: "a1",
				applicationType: "application-preview",
				previewDeploymentId: "pv-1",
			}),
		];
		expect(describeQueueStatus(jobs, app("a1"), ctx).state).toBe("none");
	});

	it("says why a waiting job is not starting while the intake is closed, and names no job id", () => {
		const jobs = [waiting({ applicationId: "a1" })];
		const status = describeQueueStatus(jobs, app("a1"), {
			...ctx,
			intakeClosed: true,
		});
		expect(status.heldReason).toBe("intake-closed-for-update");
		expect(JSON.stringify(status)).not.toMatch(/job-\d+|journal-\d+/);
	});

	it("a running job is not held by a closed intake", () => {
		const jobs = [active({ applicationId: "a1" }, { processedOn: NOW })];
		expect(
			describeQueueStatus(jobs, app("a1"), { ...ctx, intakeClosed: true })
				.heldReason,
		).toBeNull();
	});

	it("flags that the boot restore is not over, so none is not final", () => {
		expect(
			describeQueueStatus([], app("a1"), { ...ctx, restoring: true }),
		).toMatchObject({ state: "none", restoring: true });
	});

	it("never reports a negative wait when the clock steps back", () => {
		const jobs = [waiting({ applicationId: "a1" }, { timestamp: NOW + 5_000 })];
		expect(describeQueueStatus(jobs, app("a1"), ctx).waitingSinceMs).toBe(0);
	});

	it("a job without a lane counts as build", () => {
		const jobs = [waiting({ applicationId: "a1" }, { lane: undefined })];
		expect(describeQueueStatus(jobs, app("a1"), ctx).lane).toBe("build");
	});
});

describe("a running deploy and a newer waiting one of the same service", () => {
	const old = () =>
		active(
			{ applicationId: "a1", deploymentId: "dep-old" },
			{ timestamp: NOW - 400_000, processedOn: NOW - 300_000 },
		);
	const newer = () =>
		waiting(
			{ applicationId: "a1", deploymentId: "dep-new" },
			{ timestamp: NOW - 20_000 },
		);

	it("without a deployment id answers running and says how many deploys of the service wait behind it", () => {
		const status = describeQueueStatus(
			[old(), newer(), newer()],
			app("a1"),
			ctx,
		);
		expect(status).toMatchObject({
			state: "running",
			startedAt: NOW - 300_000,
			queuedBehind: 2,
		});
	});

	it("a running deploy with nothing of its service behind it has queuedBehind 0", () => {
		const status = describeQueueStatus(
			[old(), waiting({ applicationId: "other" })],
			app("a1"),
			ctx,
		);
		expect(status).toMatchObject({ state: "running", queuedBehind: 0 });
	});

	it("with the deployment id of the newer deploy answers for it: queued, never the older run", () => {
		const status = describeQueueStatus(
			[old(), newer()],
			{ applicationId: "a1", deploymentId: "dep-new" },
			ctx,
		);
		expect(status).toMatchObject({
			state: "queued",
			startedAt: null,
			waitingSinceMs: 20_000,
			queuedBehind: null,
		});
	});

	it("with the deployment id of the running deploy answers running, counting the ones behind it", () => {
		const status = describeQueueStatus(
			[old(), newer()],
			{ applicationId: "a1", deploymentId: "dep-old" },
			ctx,
		);
		expect(status).toMatchObject({ state: "running", queuedBehind: 1 });
	});

	it("queued and none answers carry no queuedBehind", () => {
		expect(
			describeQueueStatus([newer()], app("a1"), ctx).queuedBehind,
		).toBeNull();
		expect(describeQueueStatus([], app("a1"), ctx).queuedBehind).toBeNull();
	});

	it("a job of another service or a preview of this one is not counted behind it", () => {
		const status = describeQueueStatus(
			[
				old(),
				waiting({ applicationId: "other" }),
				waiting({
					applicationId: "a1",
					applicationType: "application-preview",
					previewDeploymentId: "pv-1",
				}),
			],
			app("a1"),
			ctx,
		);
		expect(status.queuedBehind).toBe(0);
	});
});

describe("the state comes from the snapshot alone", () => {
	it("a job with no start time is queued, whatever its live state says", () => {
		// A job that started after the snapshot was taken: the snapshot has no processedOn.
		const justStarted = waiting(
			{ applicationId: "a1" },
			{ getState: async () => "active" },
		);
		expect(describeQueueStatus([justStarted], app("a1"), ctx)).toMatchObject({
			state: "queued",
			startedAt: null,
		});
	});

	it("a job with a start time is running with its startedAt and wait", () => {
		const started = active(
			{ applicationId: "a1" },
			{ timestamp: NOW - 100_000, processedOn: NOW - 40_000 },
		);
		expect(describeQueueStatus([started], app("a1"), ctx)).toMatchObject({
			state: "running",
			startedAt: NOW - 40_000,
			waitingSinceMs: 60_000,
		});
	});
});
