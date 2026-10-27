export type TraefikSetupJobState = "pending" | "done" | "failed" | "unknown";

export interface TraefikSetupJobStatus {
	state: TraefikSetupJobState;
	error: string | null;
}

interface TraefikSetupJob {
	state: Exclude<TraefikSetupJobState, "unknown">;
	error: string | null;
	startedAt: number;
}

// Results are read once, right after the save, so a short memory is enough.
const JOB_TTL_MS = 30 * 60_000;
const MAX_JOBS = 200;
// A Docker error can carry a whole command line or log.
const MAX_ERROR_LENGTH = 2000;

const jobs = new Map<string, TraefikSetupJob>();

const keyOf = (serverId: string | undefined, jobId: string) =>
	`${serverId ?? "local"}:${jobId}`;

const prune = (now: number) => {
	for (const [key, job] of jobs) {
		if (now - job.startedAt > JOB_TTL_MS) {
			jobs.delete(key);
		}
	}
	// Leaves room for the run being added. Runs that ended go first, oldest
	// first: one that is still pending is what a page is waiting on.
	for (const state of ["done", "failed", "pending"] as const) {
		for (const [key, job] of jobs) {
			if (jobs.size < MAX_JOBS) {
				return;
			}
			if (state === "pending" || job.state === state) {
				jobs.delete(key);
			}
		}
	}
};

/**
 * Remembers how a queued env, ports or dashboard recreate ends, so the page
 * that saved it can tell its own run from an earlier one. The mutation has
 * already returned by then; this only records the outcome. A job id used again
 * starts a new run: the result of the earlier one is dropped, not shown as the
 * new one's.
 */
export const trackTraefikSetupJob = (
	serverId: string | undefined,
	jobId: string,
	setup: Promise<unknown>,
	label: string,
) => {
	const key = keyOf(serverId, jobId);
	const now = Date.now();
	prune(now);
	const entry: TraefikSetupJob = {
		state: "pending",
		error: null,
		startedAt: now,
	};
	// Deleted first so the entry also counts as the newest.
	jobs.delete(key);
	jobs.set(key, entry);
	// Only this run's entry takes this run's result; one forgotten or replaced
	// meanwhile stays so.
	const settle = (state: "done" | "failed", error: string | null) => {
		if (jobs.get(key) === entry) {
			entry.state = state;
			entry.error = error;
		}
	};
	void setup.then(
		() => settle("done", null),
		(err) => {
			console.error(`${label} background writeTraefikSetup:`, err);
			settle(
				"failed",
				(err instanceof Error ? err.message : String(err)).slice(
					0,
					MAX_ERROR_LENGTH,
				),
			);
		},
	);
};

export const getTraefikSetupJob = (
	serverId: string | undefined,
	jobId: string,
): TraefikSetupJobStatus => {
	const job = jobs.get(keyOf(serverId, jobId));
	return job
		? { state: job.state, error: job.error }
		: { state: "unknown", error: null };
};

export const clearTraefikSetupJobs = () => jobs.clear();
