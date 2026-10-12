import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema";
import { and, eq, ne } from "drizzle-orm";

/**
 * Status changes of a schedule run that a user can cancel.
 *
 * A cancel claims the run (`running` -> `cancelled`) before it kills anything,
 * and the run records its own end with an update that skips a cancelled row.
 * Both are single conditional updates, so whichever lands first wins and the
 * other sees it: a cancelled run never ends as `error` (and never sends a
 * failure notification), and a run that already ended is never cancelled.
 */

/**
 * Claims a running run for cancellation. False when it is no longer running
 * (it ended, or was already cancelled), in which case there is nothing to kill.
 */
export const claimScheduleRunCancel = async (
	deploymentId: string,
): Promise<boolean> => {
	const claimed = await db
		.update(deployments)
		.set({ status: "cancelled", finishedAt: new Date().toISOString() })
		.where(
			and(
				eq(deployments.deploymentId, deploymentId),
				eq(deployments.status, "running"),
			),
		)
		.returning({ deploymentId: deployments.deploymentId });
	return claimed.length > 0;
};

/**
 * Undoes a claim whose kill did not go through, so the run is shown as what it
 * still is and can be cancelled again. A run that ended inside that short
 * window had its own end skipped (it saw the claim); it is left `running` and
 * is closed by the next run of the schedule, which supersedes running rows.
 */
export const revertScheduleRunCancel = async (
	deploymentId: string,
): Promise<void> => {
	await db
		.update(deployments)
		.set({ status: "running", finishedAt: null })
		.where(
			and(
				eq(deployments.deploymentId, deploymentId),
				eq(deployments.status, "cancelled"),
			),
		);
};

/**
 * Records how a schedule run ended, unless it was cancelled meanwhile. Returns
 * false for a cancelled run: its status stays `cancelled` and the caller must
 * not report a failure.
 */
export const finishScheduleRun = async (
	deploymentId: string,
	status: "done" | "error",
): Promise<boolean> => {
	const updated = await db
		.update(deployments)
		.set({ status, finishedAt: new Date().toISOString() })
		.where(
			and(
				eq(deployments.deploymentId, deploymentId),
				ne(deployments.status, "cancelled"),
			),
		)
		.returning({ deploymentId: deployments.deploymentId });
	return updated.length > 0;
};
