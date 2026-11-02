// Pure: no db, no network. Maps the jobs of a GitHub Actions run (GET /repos/{owner}/{repo}/actions/runs/{id}/jobs)
// to what a live deployment row shows (T-12686): the run state, a short "current step" label and the lines to append
// to the deployment log. The poller (github-run-poller.ts) does the I/O around it.

/** Prefix of every line the poller writes to a deployment log. */
export const GITHUB_LOG_PREFIX = "[GitHub Actions]";

export type GithubRunStep = {
	name: string;
	number?: number;
	status: string;
	conclusion?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
};

export type GithubRunJob = {
	id?: number;
	name: string;
	status: string;
	conclusion?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
	steps?: GithubRunStep[] | null;
};

export type RunStatus = "queued" | "in_progress" | "completed";
export type RunConclusion = "success" | "failure" | "cancelled" | "skipped";

export type RunProgress = {
	/** `completed` only when every job of the run has completed. */
	status: RunStatus;
	/** The outcome of the run, only when `status` is `completed`. */
	conclusion: RunConclusion | null;
	/** "build · Build image (3/7)", or null when nothing runs (yet). */
	step: string | null;
	/** Log lines for step transitions not logged before, oldest first. */
	newLines: string[];
};

// The steps GitHub adds to every job. They say nothing the person watching needs.
const isNoiseStep = (name: string) =>
	name === "Set up job" || name === "Complete job" || name.startsWith("Post ");

const FAILED_CONCLUSIONS = new Set([
	"failure",
	"timed_out",
	"startup_failure",
	"action_required",
]);

const secondsBetween = (
	from: string | null | undefined,
	to: string | null | undefined,
): number | null => {
	if (!from || !to) return null;
	const start = Date.parse(from);
	const end = Date.parse(to);
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
	return Math.round((end - start) / 1000);
};

/** 45s, 2m13s, 1h02m. */
export const formatRunDuration = (seconds: number): string => {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60)
		return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
};

const stepLabelPrefix = (jobName: string, stepName: string) =>
	`${GITHUB_LOG_PREFIX} ${jobName} › ${stepName}`;

/** The steps worth showing, in run order. */
const relevantSteps = (job: GithubRunJob): GithubRunStep[] =>
	[...(job.steps ?? [])]
		.filter((step) => !isNoiseStep(step.name))
		.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

/**
 * The lines one step adds to the log: "started" once it began and, when it ended, "completed in 2m13s" (or
 * "failed after ...", "cancelled after ..."). A skipped step adds none.
 */
const stepLines = (job: GithubRunJob, step: GithubRunStep): string[] => {
	if (step.status !== "in_progress" && step.status !== "completed") return [];
	if (step.conclusion === "skipped") return [];
	const base = stepLabelPrefix(job.name, step.name);
	const lines = [`${base} started`];
	if (step.status !== "completed") return lines;
	const seconds = secondsBetween(step.started_at, step.completed_at);
	const duration = seconds === null ? "" : formatRunDuration(seconds);
	if (step.conclusion === "success" || step.conclusion == null) {
		lines.push(
			duration ? `${base} completed in ${duration}` : `${base} completed`,
		);
	} else {
		const word = FAILED_CONCLUSIONS.has(step.conclusion)
			? "failed"
			: "cancelled";
		lines.push(
			duration ? `${base} ${word} after ${duration}` : `${base} ${word}`,
		);
	}
	return lines;
};

/** The run's outcome from its jobs: any failure wins over a cancel, an all-skipped run is `skipped`. */
export const runConclusionOf = (
	jobs: readonly GithubRunJob[],
): RunConclusion => {
	if (jobs.some((job) => FAILED_CONCLUSIONS.has(job.conclusion ?? ""))) {
		return "failure";
	}
	if (jobs.some((job) => job.conclusion === "cancelled")) return "cancelled";
	if (jobs.length > 0 && jobs.every((job) => job.conclusion === "skipped")) {
		return "skipped";
	}
	return "success";
};

/** The label of what runs now: the job in progress and its step, "(3/7)" counting the shown steps. */
const currentStepLabel = (jobs: readonly GithubRunJob[]): string | null => {
	const running = jobs.find((job) => job.status === "in_progress");
	if (running) {
		const steps = relevantSteps(running);
		if (steps.length === 0) return `${running.name} · starting`;
		const index = steps.findIndex((step) => step.status === "in_progress");
		// Between two steps nothing is "in progress" for a moment: the last finished one stands in.
		const at =
			index !== -1
				? index
				: Math.max(
						0,
						steps.map((step) => step.status).lastIndexOf("completed"),
					);
		const step = steps[at];
		return step
			? `${running.name} · ${step.name} (${at + 1}/${steps.length})`
			: null;
	}
	const waiting = jobs.find(
		(job) => job.status === "queued" || job.status === "waiting",
	);
	// A job waits for a runner, or for the jobs it needs to finish.
	return waiting ? `${waiting.name} · waiting to start` : null;
};

/**
 * Maps the jobs of a run to {status, step, newLines}. `alreadyLogged` holds the log lines that are in the log
 * (compare exact text); only lines missing from it are returned, so the same run can be mapped on every poll, and
 * after a restart, without writing a step twice. Step names are the key: two steps of one job with the same name
 * are written once.
 */
export const mapRunJobs = (
	jobs: readonly GithubRunJob[],
	alreadyLogged: ReadonlySet<string> = new Set(),
): RunProgress => {
	const newLines: string[] = [];
	const seen = new Set(alreadyLogged);
	for (const job of jobs) {
		for (const step of relevantSteps(job)) {
			for (const line of stepLines(job, step)) {
				if (seen.has(line)) continue;
				seen.add(line);
				newLines.push(line);
			}
		}
	}

	const finished =
		jobs.length > 0 && jobs.every((job) => job.status === "completed");
	const started = jobs.some(
		(job) => job.status === "in_progress" || job.status === "completed",
	);
	const status: RunStatus = finished
		? "completed"
		: started
			? "in_progress"
			: "queued";
	return {
		status,
		conclusion: finished ? runConclusionOf(jobs) : null,
		step: finished ? null : currentStepLabel(jobs),
		newLines,
	};
};

/** The exact lines of a log, trimmed, for the `alreadyLogged` set. */
export const loggedLinesOf = (logText: string): Set<string> => {
	const lines = new Set<string>();
	for (const line of logText.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed) lines.add(trimmed);
	}
	return lines;
};

export type ExternalBuildConclusion = "failure" | "cancelled" | "skipped";

/** The row status and the words a conclusion gives. */
export const externalBuildOutcome = (
	conclusion: ExternalBuildConclusion,
	run: { runId: string | null },
	message?: string | null,
) => {
	const number = run.runId ? ` #${run.runId}` : "";
	const verb =
		conclusion === "failure"
			? "failed"
			: conclusion === "cancelled"
				? "was cancelled"
				: "was skipped";
	const detail = message?.trim() ? ` ${message.trim().slice(0, 1000)}` : "";
	if (conclusion === "skipped") {
		// A skipped build is not a failure: it ends cancelled and never counts as a failed deploy.
		return {
			status: "cancelled" as const,
			errorMessage: detail
				? `Build skipped (${detail.trim()})`
				: "Build skipped",
		};
	}
	return {
		status:
			conclusion === "failure" ? ("error" as const) : ("cancelled" as const),
		errorMessage: `GitHub Actions run${number} ${verb}.${detail} The run has the details.`,
	};
};
