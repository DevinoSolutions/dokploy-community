import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema";
import { and, eq, inArray, ne } from "drizzle-orm";
import { appendRunLog } from "./run-log";

/**
 * Status changes of a schedule run that a user can cancel.
 *
 * A cancel claims the run (`running` -> `cancelled`) before it kills anything,
 * and the run records its own end with an update that skips a cancelled row.
 * Both are single conditional updates, so whichever lands first wins and the
 * other sees it: a cancelled run never ends as `error` (and never sends a
 * failure notification), and a run that already ended is never cancelled. A
 * cancel that then fails to kill puts the run back to `running`, unless the run
 * ended on its own in the meantime (see `finishScheduleRun`).
 */

/**
 * Claims a running run for cancellation and returns the claim, a token that
 * `revertScheduleRunCancel` needs to undo it: the finish time the claim wrote.
 * Null when it is no longer running (it ended, or was already cancelled), in
 * which case there is nothing to kill.
 */
export const claimScheduleRunCancel = async (
	deploymentId: string,
): Promise<string | null> => {
	const claimedAt = new Date().toISOString();
	const claimed = await db
		.update(deployments)
		.set({ status: "cancelled", finishedAt: claimedAt })
		.where(
			and(
				eq(deployments.deploymentId, deploymentId),
				eq(deployments.status, "running"),
			),
		)
		.returning({ deploymentId: deployments.deploymentId });
	return claimed.length > 0 ? claimedAt : null;
};

/**
 * Undoes a claim whose kill did not go through, so the run is shown as what it
 * still is and can be cancelled again. Only a claim that is still untouched is
 * undone: a run that ended on its own after the claim had its end noted on the
 * row by `finishScheduleRun`, which moved the finish time off the claim's, so
 * that run stays `cancelled` instead of coming back to `running` with nobody
 * left to end it. True when the claim was undone, false when it was not (the
 * run ended in the meantime, or was reverted already).
 */
export const revertScheduleRunCancel = async (
	deploymentId: string,
	claim: string,
): Promise<boolean> => {
	const reverted = await db
		.update(deployments)
		.set({ status: "running", finishedAt: null })
		.where(
			and(
				eq(deployments.deploymentId, deploymentId),
				eq(deployments.status, "cancelled"),
				eq(deployments.finishedAt, claim),
			),
		)
		.returning({ deploymentId: deployments.deploymentId });
	return reverted.length > 0;
};

/**
 * True once the run has been cancelled. A failed lookup counts as "not
 * cancelled": it is used on failure paths, which must never lose the real error
 * or swallow a failure alert.
 */
export const isScheduleRunCancelled = async (
	deploymentId: string,
): Promise<boolean> => {
	try {
		const row = await db.query.deployments.findFirst({
			where: eq(deployments.deploymentId, deploymentId),
			columns: { status: true },
		});
		return row?.status === "cancelled";
	} catch (error) {
		console.warn(
			`Could not read the status of run ${deploymentId}:`,
			error instanceof Error ? error.message : error,
		);
		return false;
	}
};

/**
 * How a run ended up being recorded: `recorded`, `cancelled` (the row is
 * cancelled and stays so) or `missing` (the row is gone, e.g. pruned by a newer
 * run or deleted, so nothing was recorded).
 */
export type ScheduleRunEnd = "recorded" | "cancelled" | "missing";

/**
 * The finish time of a run that ended on a cancelled row. A claim is written as
 * `toISOString()` (`...Z`) and this is the same kind of instant with a
 * `+00:00` offset, so the two can never be equal whatever the clocks say, and
 * both stay valid dates. The offset makes these finish times tokens, not just
 * timestamps: parse a `finishedAt` with `new Date()`, never compare or sort it as
 * a string.
 */
const endedFinishTime = (): string =>
	new Date().toISOString().replace(/Z$/, "+00:00");

/**
 * Notes on a cancelled row that its run has ended, by moving its finish time
 * (which is also when the run really ended) off the claim's, which is what
 * `revertScheduleRunCancel` looks for.
 */
const markCancelledRunEnded = async (
	deploymentId: string,
): Promise<boolean> => {
	const marked = await db
		.update(deployments)
		.set({ finishedAt: endedFinishTime() })
		.where(
			and(
				eq(deployments.deploymentId, deploymentId),
				eq(deployments.status, "cancelled"),
			),
		)
		.returning({ deploymentId: deployments.deploymentId });
	return marked.length > 0;
};

/**
 * Ends a run that was cancelled before its command started as `cancelled`,
 * whether its row still is (the end is noted, as in `finishScheduleRun`) or a
 * revert has put it back to `running`. A run that already ended is left alone.
 */
export const endScheduleRunCancelled = async (
	deploymentId: string,
): Promise<void> => {
	await db
		.update(deployments)
		.set({ status: "cancelled", finishedAt: endedFinishTime() })
		.where(
			and(
				eq(deployments.deploymentId, deploymentId),
				inArray(deployments.status, ["running", "cancelled"]),
			),
		);
};

export const NO_PROCESS_LOG_LINE =
	"⛔ Run cancelled by user: no process of this run was found, so it already exited or cannot be tracked.";
export const STRANDED_LOG_LINE =
	"⛔ Run cancelled by user: this run was left behind (Dokploy restarted while it was running) and has no process.";

/**
 * Ends a run whose cancel found nothing to stop as `cancelled`, and says why in
 * its log (`line`), instead of leaving it for the user to retry forever. The row
 * may still hold the cancel's claim or have been put back to `running`; either
 * way it ends cancelled, and a run that already ended is left alone.
 */
export const endScheduleRunWithoutProcess = async (
	deploymentId: string,
	logServerId: string | null,
	logPath: string | null,
	line: string = NO_PROCESS_LOG_LINE,
): Promise<void> => {
	await endScheduleRunCancelled(deploymentId);
	if (logPath) await appendRunLog(logServerId, logPath, line);
};

/**
 * Records how a schedule run ended, unless it was cancelled meanwhile, in which
 * case the row stays cancelled and notes that its run is over (so a cancel that
 * fails afterwards cannot bring it back to `running`). Only a row that is
 * really `cancelled` is reported as such, so the caller reports no failure for
 * it; a row that no longer exists is `missing`, and a genuine failure of such a
 * run is still reported.
 *
 * A cancel or a revert can land between the two updates, so a miss on both is
 * tried once more: the row is then in the other state, or gone.
 */
export const finishScheduleRun = async (
	deploymentId: string,
	status: "done" | "error",
): Promise<ScheduleRunEnd> => {
	for (let attempt = 0; attempt < 2; attempt++) {
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
		if (updated.length > 0) return "recorded";
		if (await markCancelledRunEnded(deploymentId)) return "cancelled";
	}
	return "missing";
};
