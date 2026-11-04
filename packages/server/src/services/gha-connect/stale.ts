/**
 * "Stale": GitHub Actions has not published what the branch now holds.
 * Pure: the poller reads the branch and its recent runs and asks this.
 *
 * A push that triggers no run never makes a service stale. Otherwise the
 * tolerance after a run ends is the larger of 15 minutes and twice the median
 * duration of the last five runs. A run queued longer than the queue limit
 * means no runner picked it up.
 */

export const STALE_MIN_TOLERANCE_MS = 15 * 60 * 1000;
export const STALE_QUEUE_LIMIT_MS = 30 * 60 * 1000;

export interface StaleRun {
	status: string;
	conclusion: string | null;
	/** Epoch ms the run was created (queued). */
	createdAt: number;
	/** Epoch ms the run started, when it did. */
	startedAt: number | null;
	/** Epoch ms the run ended, when it did. */
	endedAt: number | null;
}

export interface StaleInput {
	now: number;
	trackedBranch: string;
	/** The branch exists on GitHub. */
	branchExists: boolean;
	branchHead: string | null;
	/** Commit of the last accepted release (deployed or verified), if any. */
	lastReleaseSha: string | null;
	/** The deployed commit is still an ancestor of (or equal to) the branch head; null = not checked. */
	deployedOnBranch: boolean | null;
	/** The workflow file exists on the tracked branch; null = not checked. */
	workflowPresent: boolean | null;
	workflowFile: string;
	/** Runs of the workflow on the tracked branch whose head is `branchHead`, newest first. */
	runsForHead: StaleRun[];
	/** The last five finished runs of the workflow (any commit), for the median. */
	recentFinishedRuns: StaleRun[];
}

export type StaleVerdict = { stale: false } | { stale: true; reason: string };

const median = (values: number[]): number => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "");

export const evaluateStale = (input: StaleInput): StaleVerdict => {
	if (!input.branchExists) {
		return {
			stale: true,
			reason: `Branch ${input.trackedBranch} was deleted or renamed.`,
		};
	}
	if (input.workflowPresent === false) {
		return {
			stale: true,
			reason: `${input.workflowFile.split("/").pop()} was removed from ${input.trackedBranch}.`,
		};
	}
	if (input.deployedOnBranch === false) {
		return {
			stale: true,
			reason: "The deployed commit is no longer on the branch.",
		};
	}
	if (!input.branchHead || input.branchHead === input.lastReleaseSha) {
		return { stale: false };
	}

	const [newest] = input.runsForHead;
	if (!newest) return { stale: false };

	if (newest.status !== "completed") {
		const waiting = input.now - newest.createdAt;
		if (newest.startedAt === null && waiting > STALE_QUEUE_LIMIT_MS) {
			return {
				stale: true,
				reason: `Queued for ${minutes(waiting)} minutes, is a runner online?`,
			};
		}
		return { stale: false };
	}
	// A successful run is judged by the release it should have produced; a
	// failed one is the run's own news, not a missing release.
	if (newest.conclusion !== "success") return { stale: false };

	const durations = input.recentFinishedRuns
		.slice(0, 5)
		.filter((r) => r.startedAt !== null && r.endedAt !== null)
		.map((r) => (r.endedAt as number) - (r.startedAt as number));
	const tolerance = Math.max(STALE_MIN_TOLERANCE_MS, 2 * median(durations));
	const endedAt = newest.endedAt ?? newest.createdAt;
	if (input.now - endedAt > tolerance) {
		return {
			stale: true,
			reason: `GitHub Actions has not published commit ${short(input.branchHead)}.`,
		};
	}
	return { stale: false };
};
