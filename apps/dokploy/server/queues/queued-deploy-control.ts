import type { QueuedDeployControl } from "@dokploy/server/services/deployment-cancel";
import type { InMemoryJob } from "./in-memory-queue";

/** The things of the deploy queue the cancel of a registered GitHub Actions row needs. */
export type QueueOfDeploys = {
	getJobs: (states: Array<"waiting" | "active">) => Promise<InMemoryJob[]>;
	removeWaitingJob: (id: string) => boolean;
	/** True once the boot restore is over; absent (a queue with nothing to restore) counts as over. */
	restoreSettled?: () => boolean;
};

// The same key as `QUEUED_DEPLOY_CONTROL_SLOT` in packages/server/src/services/deployment-cancel.ts, which reads it.
const QUEUED_DEPLOY_CONTROL_SLOT = Symbol.for("dokploy.queuedDeployControl");

/**
 * How long after the control was created a restore that never reports back stops blocking the cancel, so a missing
 * `restore()` call can never leave a row uncancellable. The boot waits at most ~25 s for the builds a restart orphaned.
 */
export const RESTORE_GRACE_MS = 5 * 60_000;

/**
 * How the user's cancel of a registered GitHub Actions row (T-19913) takes the deploy that waits for it out of the
 * queue. A job carries its row as `deploymentId` (see queue-types.ts).
 *
 * - `starting`: the boot restore is not over, so the jobs the previous process left waiting are not in the queue yet and
 *   "no job" would be a guess; nothing is touched.
 * - One snapshot of the waiting and the running jobs is taken (the queue builds it synchronously, so a job that starts
 *   meanwhile cannot fall between two lookups). Every job that carries the row is then removed with `removeWaitingJob`,
 *   one synchronous step that fails for a job that is running or started since the snapshot: that answers `started`
 *   and the deploy is never touched.
 * - The queue's own hook (`closeLiveRowOfJob` in queueSetup.ts) closes the row of a removed job.
 */
export const createQueuedDeployControl = (
	queue: QueueOfDeploys,
	options: { now?: () => number } = {},
): QueuedDeployControl => {
	const now = options.now ?? Date.now;
	const createdAt = now();
	return {
		removeDeployOf: async (deploymentId) => {
			if (
				queue.restoreSettled &&
				!queue.restoreSettled() &&
				now() - createdAt < RESTORE_GRACE_MS
			) {
				return "starting";
			}
			const carrying = (await queue.getJobs(["waiting", "active"])).filter(
				(job) =>
					(job.data as { deploymentId?: string }).deploymentId === deploymentId,
			);
			if (carrying.length === 0) return "none";
			let removedAll = true;
			for (const job of carrying) {
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
	};
};

/**
 * Hands the queue's control to the server package's cancel of a registered row, which cannot import the app's queue.
 * Called once, where the queue is created.
 */
export const installQueuedDeployControl = (queue: QueueOfDeploys) => {
	(globalThis as unknown as Record<symbol, QueuedDeployControl>)[
		QUEUED_DEPLOY_CONTROL_SLOT
	] = createQueuedDeployControl(queue);
};
