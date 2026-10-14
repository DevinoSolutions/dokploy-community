/**
 * When a `server` / `dokploy-server` run handed its command over for execution:
 * right before the local spawn, or once the ssh channel is ready. Elapsed time
 * since the run started proves nothing about this (an ssh connect can be slow),
 * so a cancel that finds no process carrying the run's tag uses it to tell a
 * command that has not been launched yet (the launch point re-checks the cancel
 * and never starts it) from one that was launched and is gone.
 *
 * Kept in memory, keyed by deployment: a run lives in the process that started
 * it. A run without a record (another process runs it, or Dokploy restarted
 * since) counts as not launched until it is old enough to be stranded.
 */
const launches = new Map<string, number>();

export const markScheduleRunLaunched = (
	deploymentId: string,
	now = Date.now(),
): void => {
	launches.set(deploymentId, now);
};

export const getScheduleRunLaunchedAt = (
	deploymentId: string,
): number | undefined => launches.get(deploymentId);

export const forgetScheduleRunLaunch = (deploymentId: string): void => {
	launches.delete(deploymentId);
};
