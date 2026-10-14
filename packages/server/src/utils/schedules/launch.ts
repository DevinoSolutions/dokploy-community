/**
 * Where a `server` / `dokploy-server` run is on its way to executing its
 * command. Elapsed time since the run started proves nothing about this (an ssh
 * connect can be slow, and so can the database), so a cancel that finds no
 * process carrying the run's tag reads it to tell a command that has not been
 * launched yet (the launch point re-checks the cancel and never starts it) from
 * one that was launched and is gone.
 *
 * - no record: the run has not reached the launch point.
 * - `checking`: the run is looking at the cancel one last time; whether it goes
 *   on is not decided, so a cancel can only ask the user to retry.
 * - `launched`: the check passed and the command was handed over at `at`.
 *
 * Kept in memory, keyed by deployment: a run lives in the process that started
 * it. A run without a record (another process runs it, or Dokploy restarted
 * since) counts as not launched until it is old enough to be stranded.
 *
 * The app can end up with more than one copy of this module (the server bundle
 * that runs the schedules and the chunk that serves the cancel), so the map
 * lives in a slot on `globalThis` that every copy shares.
 */
export type ScheduleRunLaunch =
	| { state: "checking" }
	| { state: "launched"; at: number };

const SLOT = Symbol.for("dokploy.scheduleLaunches");

const launches = (): Map<string, ScheduleRunLaunch> => {
	const holder = globalThis as unknown as Record<
		symbol,
		Map<string, ScheduleRunLaunch> | undefined
	>;
	let map = holder[SLOT];
	if (!map) {
		map = new Map();
		holder[SLOT] = map;
	}
	return map;
};

/** Before the cancel is looked at for the last time. */
export const markScheduleRunChecking = (deploymentId: string): void => {
	launches().set(deploymentId, { state: "checking" });
};

/** Once that check passed, right before the command is handed over. */
export const markScheduleRunLaunched = (
	deploymentId: string,
	now = Date.now(),
): void => {
	launches().set(deploymentId, { state: "launched", at: now });
};

export const getScheduleRunLaunch = (
	deploymentId: string,
): ScheduleRunLaunch | undefined => launches().get(deploymentId);

export const forgetScheduleRunLaunch = (deploymentId: string): void => {
	launches().delete(deploymentId);
};
