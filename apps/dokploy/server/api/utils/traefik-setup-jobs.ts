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

const jobs = new Map<string, TraefikSetupJob>();

const keyOf = (serverId: string | undefined, jobId: string) =>
	`${serverId ?? "local"}:${jobId}`;

const prune = (now: number) => {
	for (const [key, job] of jobs) {
		if (now - job.startedAt > JOB_TTL_MS) {
			jobs.delete(key);
		}
	}
	// Insertion order, so the oldest go first. Leaves room for the run being added.
	for (const key of jobs.keys()) {
		if (jobs.size < MAX_JOBS) {
			break;
		}
		jobs.delete(key);
	}
};

/**
 * Remembers how a queued env, ports or dashboard recreate ends, so the page
 * that saved it can tell its own run from an earlier one. The mutation has
 * already returned by then; this only records the outcome.
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
	jobs.set(key, { state: "pending", error: null, startedAt: now });
	// A run forgotten meanwhile stays forgotten.
	const settle = (job: Omit<TraefikSetupJob, "startedAt">) => {
		if (jobs.has(key)) {
			jobs.set(key, { ...job, startedAt: now });
		}
	};
	void setup.then(
		() => settle({ state: "done", error: null }),
		(err) => {
			console.error(`${label} background writeTraefikSetup:`, err);
			settle({
				state: "failed",
				error: err instanceof Error ? err.message : String(err),
			});
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
