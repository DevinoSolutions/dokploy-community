import {
	type ExternalBuildConclusion,
	externalBuildOutcome,
	GITHUB_LOG_PREFIX,
	type GithubRunJob,
	loggedLinesOf,
	mapRunJobs,
	type RunConclusion,
} from "./github-run-progress";

/**
 * Follows the GitHub Actions run behind every live deployment row (T-12686): the run state and the current step go
 * to the row, step transitions go to the deployment log, and a run that ends without a deploy ends the row.
 * This file is the decision logic; every read and write goes through `PollerDeps`
 * (github-run-poller-deps.ts has the real ones), so it is tested without GitHub, a database or a host.
 *
 * Rules:
 * - A row is polled every 15 s with an installation token of a GitHub provider that covers its repository, every 60 s
 *   without one (public repositories only). A run Dokploy cannot read is retried every 5 minutes and said so once in
 *   the log. The rate-limit headers are respected: a 403/429 backs the row off until the limit resets.
 * - A deploy call that takes the row over (`buildRunStatus` becomes `completed`) ends the polling for it; every write
 *   here is guarded by the row still waiting for GitHub, so the deploy always wins.
 * - A run that completed with failure or cancel and was not taken over ends the row (error / cancelled).
 * - A run that succeeded leaves the row 10 minutes for the deploy call to take it over; after that it ends as error
 *   ("Run finished without deploying to Dokploy").
 * - A row older than 6 hours that nothing took over ends as error: "run finished without deploying". This is the
 *   backstop for runs Dokploy cannot read.
 */

export const POLL_INTERVAL_MS = 15_000;
export const UNAUTHENTICATED_POLL_INTERVAL_MS = 60_000;
export const UNREADABLE_POLL_INTERVAL_MS = 5 * 60_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
export const MAX_LIVE_ROW_AGE_MS = 6 * 60 * 60_000;
/** After a run that succeeded, how long the workflow's deploy call has to take the row over. */
export const DEPLOY_TAKEOVER_GRACE_MS = 10 * 60_000;
/** Rows handled in one pass, so a pass cannot run past the next tick for ever. */
const MAX_ROWS_PER_PASS = 25;

export const RUN_UNREADABLE_LINE = `${GITHUB_LOG_PREFIX} Dokploy cannot read this run, so the steps are not shown here. Connect GitHub in Settings to see them, or open the run.`;

/** A deployment row that waits for its GitHub Actions run. */
export type LiveRunRow = {
	deploymentId: string;
	applicationId: string | null;
	composeId: string | null;
	serverId: string | null;
	buildServerId: string | null;
	logPath: string;
	/** `owner/name`. */
	buildRepository: string;
	buildRunId: string;
	/** The normalised run link; names the attempt when the run was re-run. */
	buildRunUrl: string | null;
	buildRunStatus: string | null;
	buildRunStep: string | null;
	startedAt: string | null;
	createdAt: string;
};

export type RunFetchResult =
	| {
			kind: "ok";
			jobs: GithubRunJob[];
			/** The run itself, read once the jobs say it is over; null when that read failed. */
			run: { status: string | null; conclusion: string | null } | null;
			/** False for a public read without a token. */
			authenticated: boolean;
			/** Requests left in the window, when the response said. */
			rateLimitRemaining: number | null;
			/** When the window resets (epoch ms), when the response said. */
			rateLimitResetAt: number | null;
	  }
	| { kind: "unreadable" }
	| { kind: "backoff"; retryAfterMs: number };

export interface PollerDeps {
	now: () => number;
	listLiveRows: () => Promise<LiveRunRow[]>;
	fetchRun: (row: LiveRunRow) => Promise<RunFetchResult>;
	/** The tail of the deployment log, to know which lines are already in it. */
	readLog: (row: LiveRunRow) => Promise<string>;
	appendLines: (row: LiveRunRow, lines: readonly string[]) => Promise<void>;
	/** Writes the state and step; false when the row no longer waits for GitHub. */
	setProgress: (
		deploymentId: string,
		progress: {
			buildRunStatus: "queued" | "in_progress";
			buildRunStep: string | null;
		},
	) => Promise<boolean>;
	/** Hands the row over to Dokploy (`completed`) after a run that succeeded; false when it was taken over. */
	markRunFinished: (deploymentId: string) => Promise<boolean>;
	/** Ends the row; false when it was taken over or already ended. */
	endRow: (
		deploymentId: string,
		outcome: { status: "error" | "cancelled"; errorMessage: string },
	) => Promise<boolean>;
}

type RowState = {
	nextPollAt: number;
	/** Lines known to be in the log. Seeded from the log on first sight, so a restart writes nothing twice. */
	logged: Set<string> | null;
	lastStatus: string | null;
	lastStep: string | null;
	/** When the run was seen finished (the start of the takeover grace); null while it runs. */
	finishedAt: number | null;
};

const conclusionOfRun = (
	run: { conclusion: string | null } | null,
	fromJobs: RunConclusion,
): RunConclusion => {
	switch (run?.conclusion) {
		case "success":
			return "success";
		case "failure":
		case "timed_out":
		case "startup_failure":
		case "action_required":
			return "failure";
		case "cancelled":
			return "cancelled";
		case "skipped":
		case "neutral":
			return fromJobs === "failure" || fromJobs === "cancelled"
				? fromJobs
				: "skipped";
		default:
			return fromJobs;
	}
};

const openRunLine = (row: Pick<LiveRunRow, "buildRunUrl">) =>
	row.buildRunUrl
		? [`${GITHUB_LOG_PREFIX} Open the run: ${row.buildRunUrl}`]
		: [];

const timeOf = (value: string | null | undefined): number | null => {
	if (!value) return null;
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : time;
};

export const createGithubRunPoller = (deps: PollerDeps) => {
	const states = new Map<string, RowState>();
	let running = false;

	const stateOf = (row: LiveRunRow): RowState => {
		const known = states.get(row.deploymentId);
		if (known) return known;
		const fresh: RowState = {
			nextPollAt: 0,
			logged: null,
			lastStatus: row.buildRunStatus,
			lastStep: row.buildRunStep,
			finishedAt: null,
		};
		states.set(row.deploymentId, fresh);
		return fresh;
	};

	const loggedLines = async (row: LiveRunRow, state: RowState) => {
		if (state.logged) return state.logged;
		state.logged = loggedLinesOf(await deps.readLog(row));
		return state.logged;
	};

	const writeLines = async (
		row: LiveRunRow,
		state: RowState,
		lines: readonly string[],
	) => {
		if (lines.length === 0) return;
		await deps.appendLines(row, lines);
		const logged = await loggedLines(row, state);
		for (const line of lines) logged.add(line);
	};

	const endBecause = async (
		row: LiveRunRow,
		state: RowState,
		outcome: { status: "error" | "cancelled"; errorMessage: string },
		lines: readonly string[],
	) => {
		const ended = await deps.endRow(row.deploymentId, outcome);
		states.delete(row.deploymentId);
		// A row a deploy took over in the meantime is not ours to write to.
		if (ended) await writeLines(row, state, lines);
	};

	const pollRow = async (row: LiveRunRow, now: number) => {
		const state = stateOf(row);
		const startedAt = timeOf(row.startedAt) ?? timeOf(row.createdAt) ?? now;
		if (now - startedAt > MAX_LIVE_ROW_AGE_MS) {
			const message = `GitHub Actions run #${row.buildRunId} finished without deploying: no deploy took over this deployment within 6 hours.`;
			await endBecause(row, state, { status: "error", errorMessage: message }, [
				`${GITHUB_LOG_PREFIX} ${message}`,
				...openRunLine(row),
			]);
			return;
		}

		// The run is over (this pass or an earlier one, maybe before a restart) and the deploy call has not come:
		// wait the grace, then close the row. GitHub is not asked again.
		if (row.buildRunStatus === "completed" || state.finishedAt !== null) {
			state.finishedAt ??= now;
			if (now - state.finishedAt < DEPLOY_TAKEOVER_GRACE_MS) return;
			const message = `GitHub Actions run #${row.buildRunId} finished without deploying to Dokploy. Open the run for details.`;
			await endBecause(row, state, { status: "error", errorMessage: message }, [
				`${GITHUB_LOG_PREFIX} ${message}`,
				...openRunLine(row),
			]);
			return;
		}
		if (now < state.nextPollAt) return;

		const result = await deps.fetchRun(row);
		if (result.kind === "backoff") {
			state.nextPollAt = now + Math.min(result.retryAfterMs, MAX_BACKOFF_MS);
			return;
		}
		if (result.kind === "unreadable") {
			state.nextPollAt = now + UNREADABLE_POLL_INTERVAL_MS;
			const logged = await loggedLines(row, state);
			if (!logged.has(RUN_UNREADABLE_LINE)) {
				await writeLines(row, state, [RUN_UNREADABLE_LINE]);
			}
			return;
		}

		state.nextPollAt =
			now +
			(result.authenticated
				? POLL_INTERVAL_MS
				: UNAUTHENTICATED_POLL_INTERVAL_MS);
		// Close to the limit: wait for the window to reset instead of spending the last requests.
		if (
			result.rateLimitRemaining !== null &&
			result.rateLimitRemaining < 5 &&
			result.rateLimitResetAt !== null
		) {
			state.nextPollAt = Math.max(
				state.nextPollAt,
				Math.min(result.rateLimitResetAt, now + MAX_BACKOFF_MS),
			);
		}

		const logged = await loggedLines(row, state);
		const progress = mapRunJobs(result.jobs, logged);
		// The jobs say the run is over; the run itself has the last word (jobs of a later stage may
		// not exist yet, and the run carries the conclusion).
		const over =
			progress.status === "completed" &&
			(result.run === null || result.run.status === "completed");

		await writeLines(row, state, progress.newLines);

		if (!over) {
			const status =
				progress.status === "completed" ? "in_progress" : progress.status;
			if (status !== state.lastStatus || progress.step !== state.lastStep) {
				const stillWaiting = await deps.setProgress(row.deploymentId, {
					buildRunStatus: status === "queued" ? "queued" : "in_progress",
					buildRunStep: progress.step,
				});
				if (!stillWaiting) {
					states.delete(row.deploymentId);
					return;
				}
				state.lastStatus = status;
				state.lastStep = progress.step;
			}
			return;
		}

		const conclusion = conclusionOfRun(
			result.run,
			progress.conclusion ?? "success",
		);
		if (conclusion !== "success") {
			const kind: ExternalBuildConclusion = conclusion;
			const outcome = externalBuildOutcome(kind, { runId: row.buildRunId });
			await endBecause(row, state, outcome, [
				`${GITHUB_LOG_PREFIX} ${outcome.errorMessage.replace(" The run has the details.", "")}`,
				...openRunLine(row),
			]);
			return;
		}
		const marked = await deps.markRunFinished(row.deploymentId);
		if (!marked) {
			states.delete(row.deploymentId);
			return;
		}
		// Kept in the table: the grace above runs from now.
		state.finishedAt = now;
		await writeLines(row, state, [
			`${GITHUB_LOG_PREFIX} Run #${row.buildRunId} finished. Waiting for the workflow's deploy to take it over.`,
		]);
	};

	return {
		/** One pass over the live rows. Never throws; a pass still running is not doubled. */
		poll: async () => {
			if (running) return;
			running = true;
			try {
				const rows = await deps.listLiveRows();
				const ids = new Set(rows.map((row) => row.deploymentId));
				for (const id of [...states.keys()]) {
					if (!ids.has(id)) states.delete(id);
				}
				const now = deps.now();
				for (const row of rows.slice(0, MAX_ROWS_PER_PASS)) {
					try {
						await pollRow(row, now);
					} catch (error) {
						console.error(
							`GitHub run poller: could not follow ${row.deploymentId}`,
							error instanceof Error ? error.message : error,
						);
					}
				}
			} catch (error) {
				console.error(
					"GitHub run poller pass failed",
					error instanceof Error ? error.message : error,
				);
			} finally {
				running = false;
			}
		},
		/** Rows being followed (for tests and diagnostics). */
		followedCount: () => states.size,
	};
};
