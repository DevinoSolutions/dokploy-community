import type { QueuedDeployControl } from "@dokploy/server/services/deployment-cancel";
import type { InMemoryJob } from "./in-memory-queue";

/** The two things of the deploy queue the cancel of a registered GitHub Actions row needs. */
export type QueueOfDeploys = {
	getJobs: (states: Array<"waiting" | "active">) => Promise<InMemoryJob[]>;
	removeWaitingJob: (id: string) => boolean;
};

// The same key as `QUEUED_DEPLOY_CONTROL_SLOT` in packages/server/src/services/deployment-cancel.ts, which reads it.
const QUEUED_DEPLOY_CONTROL_SLOT = Symbol.for("dokploy.queuedDeployControl");

/**
 * How the user's cancel of a registered GitHub Actions row (T-19913) takes the deploy that waits for it out of the
 * queue. A job carries its row as `deploymentId` (see queue-types.ts).
 *
 * A deploy that is already running is never touched: it is answered `started` before any waiting job is removed.
 * `removeWaitingJob` is one synchronous step that fails when the job started since it was looked up, which is also
 * answered `started`. The queue's own hook (`closeLiveRowOfJob` in queueSetup.ts) closes the row of a removed job.
 */
export const createQueuedDeployControl = (
	queue: QueueOfDeploys,
): QueuedDeployControl => ({
	removeDeployOf: async (deploymentId) => {
		const carries = (job: InMemoryJob) =>
			(job.data as { deploymentId?: string }).deploymentId === deploymentId;
		if ((await queue.getJobs(["active"])).some(carries)) return "started";
		const waiting = (await queue.getJobs(["waiting"])).filter(carries);
		if (waiting.length === 0) return "none";
		let removedAll = true;
		for (const job of waiting) {
			let removed: boolean;
			try {
				removed = queue.removeWaitingJob(job.id);
			} catch {
				removed = false;
			}
			if (!removed) removedAll = false;
		}
		return removedAll ? "removed" : "started";
	},
});

/**
 * Hands the queue's control to the server package's cancel of a registered row, which cannot import the app's queue.
 * Called once, where the queue is created.
 */
export const installQueuedDeployControl = (queue: QueueOfDeploys) => {
	(globalThis as unknown as Record<symbol, QueuedDeployControl>)[
		QUEUED_DEPLOY_CONTROL_SLOT
	] = createQueuedDeployControl(queue);
};
