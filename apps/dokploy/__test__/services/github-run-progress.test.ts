import {
	externalBuildOutcome,
	formatRunDuration,
	GITHUB_LOG_PREFIX,
	type GithubRunJob,
	loggedLinesOf,
	mapRunJobs,
	runConclusionOf,
} from "@dokploy/server/services/github-run-progress";
import { describe, expect, it } from "vitest";

/**
 * The mapping from the jobs of a GitHub Actions run (GET /actions/runs/{id}/jobs) to what a live deployment row
 * shows: the run state, the current step label and the log lines to append.
 */

const at = (minute: number, second = 0) =>
	`2026-11-02T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`;

const step = (
	number: number,
	name: string,
	status: string,
	conclusion: string | null,
	from?: string,
	to?: string,
) => ({
	number,
	name,
	status,
	conclusion,
	started_at: from ?? null,
	completed_at: to ?? null,
});

/** A run in the middle of "Build image": 7 steps that count, 2 that are GitHub's own. */
const buildInProgress: GithubRunJob[] = [
	{
		id: 1,
		name: "build",
		status: "in_progress",
		conclusion: null,
		started_at: at(0),
		completed_at: null,
		steps: [
			step(1, "Set up job", "completed", "success", at(0), at(0, 2)),
			step(2, "Checkout", "completed", "success", at(0, 2), at(0, 9)),
			step(
				3,
				"Set up Docker Buildx",
				"completed",
				"success",
				at(0, 9),
				at(0, 20),
			),
			step(
				4,
				"Log in to registry",
				"completed",
				"success",
				at(0, 20),
				at(0, 22),
			),
			step(5, "Build image", "in_progress", null, at(0, 22)),
			step(6, "Scan image", "pending", null),
			step(7, "Push image", "pending", null),
			step(8, "Notify", "pending", null),
			step(9, "Post Checkout", "pending", null),
			step(10, "Complete job", "pending", null),
		],
	},
	{
		id: 2,
		name: "deploy",
		status: "queued",
		conclusion: null,
		steps: [],
	},
];

describe("mapRunJobs", () => {
	it("names the step that runs now with its position among the shown steps", () => {
		const progress = mapRunJobs(buildInProgress);
		expect(progress.status).toBe("in_progress");
		expect(progress.conclusion).toBeNull();
		// 7 steps count: Set up job, Post Checkout and Complete job are GitHub's own.
		expect(progress.step).toBe("build · Build image (4/7)");
	});

	it("writes a started line for a running step and both lines for a finished one", () => {
		const { newLines } = mapRunJobs(buildInProgress);
		expect(newLines).toEqual([
			`${GITHUB_LOG_PREFIX} build › Checkout started`,
			`${GITHUB_LOG_PREFIX} build › Checkout completed in 7s`,
			`${GITHUB_LOG_PREFIX} build › Set up Docker Buildx started`,
			`${GITHUB_LOG_PREFIX} build › Set up Docker Buildx completed in 11s`,
			`${GITHUB_LOG_PREFIX} build › Log in to registry started`,
			`${GITHUB_LOG_PREFIX} build › Log in to registry completed in 2s`,
			`${GITHUB_LOG_PREFIX} build › Build image started`,
		]);
	});

	it("never writes GitHub's own bookkeeping steps", () => {
		const { newLines } = mapRunJobs(buildInProgress);
		expect(newLines.join("\n")).not.toMatch(/Set up job|Complete job|Post /);
	});

	it("writes nothing twice: the same jobs again add no lines", () => {
		const first = mapRunJobs(buildInProgress);
		const again = mapRunJobs(buildInProgress, new Set(first.newLines));
		expect(again.newLines).toEqual([]);
		expect(again.step).toBe(first.step);
	});

	it("writes only the transition when the step moves on", () => {
		const first = mapRunJobs(buildInProgress);
		const job = buildInProgress[0];
		if (!job?.steps) throw new Error("fixture");
		const later: GithubRunJob[] = [
			{
				...job,
				steps: job.steps.map((s) =>
					s.name === "Build image"
						? {
								...s,
								status: "completed",
								conclusion: "success",
								completed_at: at(2, 35),
							}
						: s.name === "Scan image"
							? { ...s, status: "in_progress", started_at: at(2, 35) }
							: s,
				),
			},
			...buildInProgress.slice(1),
		];
		const next = mapRunJobs(later, new Set(first.newLines));
		expect(next.newLines).toEqual([
			`${GITHUB_LOG_PREFIX} build › Build image completed in 2m13s`,
			`${GITHUB_LOG_PREFIX} build › Scan image started`,
		]);
		expect(next.step).toBe("build · Scan image (5/7)");
	});

	it("shows the last finished step between two steps", () => {
		const job = buildInProgress[0];
		if (!job?.steps) throw new Error("fixture");
		const between: GithubRunJob[] = [
			{
				...job,
				steps: job.steps.map((s) =>
					s.name === "Build image"
						? {
								...s,
								status: "completed",
								conclusion: "success",
								completed_at: at(2, 35),
							}
						: s,
				),
			},
		];
		expect(mapRunJobs(between).step).toBe("build · Build image (4/7)");
	});

	it("says the job is starting before it has steps, and waiting while it is queued", () => {
		expect(
			mapRunJobs([{ name: "build", status: "in_progress", steps: [] }]).step,
		).toBe("build · starting");
		const queued = mapRunJobs([{ name: "build", status: "queued", steps: [] }]);
		expect(queued.status).toBe("queued");
		expect(queued.step).toBe("build · waiting to start");
	});

	it("is queued with no jobs at all, and has no step", () => {
		expect(mapRunJobs([])).toEqual({
			status: "queued",
			conclusion: null,
			step: null,
			newLines: [],
		});
	});

	it("reports a failed step with the time it took, and a cancelled one", () => {
		const failed = mapRunJobs([
			{
				name: "build",
				status: "completed",
				conclusion: "failure",
				steps: [
					step(1, "Build image", "completed", "failure", at(0), at(1, 5)),
					step(2, "Push image", "completed", "skipped", null as never),
				],
			},
		]);
		expect(failed.newLines).toEqual([
			`${GITHUB_LOG_PREFIX} build › Build image started`,
			`${GITHUB_LOG_PREFIX} build › Build image failed after 1m05s`,
		]);
		const cancelled = mapRunJobs([
			{
				name: "build",
				status: "completed",
				conclusion: "cancelled",
				steps: [
					step(1, "Build image", "completed", "cancelled", at(0), at(0, 30)),
				],
			},
		]);
		expect(cancelled.newLines.at(-1)).toBe(
			`${GITHUB_LOG_PREFIX} build › Build image cancelled after 30s`,
		);
	});

	it("is completed only when every job has completed, and carries the conclusion then", () => {
		const done = mapRunJobs([
			{ name: "build", status: "completed", conclusion: "success", steps: [] },
			{ name: "deploy", status: "completed", conclusion: "success", steps: [] },
		]);
		expect(done.status).toBe("completed");
		expect(done.conclusion).toBe("success");
		expect(done.step).toBeNull();

		const notYet = mapRunJobs([
			{ name: "build", status: "completed", conclusion: "success", steps: [] },
			{ name: "deploy", status: "queued", steps: [] },
		]);
		expect(notYet.status).toBe("in_progress");
		expect(notYet.conclusion).toBeNull();
		expect(notYet.step).toBe("deploy · waiting to start");
	});
});

describe("runConclusionOf", () => {
	it("lets a failure win over a cancel, and a cancel over success", () => {
		const job = (conclusion: string): GithubRunJob => ({
			name: "j",
			status: "completed",
			conclusion,
		});
		expect(runConclusionOf([job("success"), job("failure")])).toBe("failure");
		expect(runConclusionOf([job("cancelled"), job("failure")])).toBe("failure");
		expect(runConclusionOf([job("success"), job("cancelled")])).toBe(
			"cancelled",
		);
		expect(runConclusionOf([job("timed_out")])).toBe("failure");
		expect(runConclusionOf([job("success"), job("skipped")])).toBe("success");
		expect(runConclusionOf([job("skipped"), job("skipped")])).toBe("skipped");
	});
});

describe("formatRunDuration", () => {
	it("writes seconds, minutes and hours the short way", () => {
		expect(formatRunDuration(45)).toBe("45s");
		expect(formatRunDuration(133)).toBe("2m13s");
		expect(formatRunDuration(600)).toBe("10m00s");
		expect(formatRunDuration(3725)).toBe("1h02m");
	});
});

describe("loggedLinesOf", () => {
	it("knows the lines of a log, trimmed, whatever the line endings", () => {
		const lines = loggedLinesOf(
			`Initializing deployment\r\n  ${GITHUB_LOG_PREFIX} build › Build image started  \n\n`,
		);
		expect(lines.has(`${GITHUB_LOG_PREFIX} build › Build image started`)).toBe(
			true,
		);
		expect(lines.has("Initializing deployment")).toBe(true);
		expect(lines.size).toBe(2);
	});
});

describe("externalBuildOutcome", () => {
	it("maps failure to error and cancelled and skipped to cancelled, with the run in the words", () => {
		expect(externalBuildOutcome("failure", { runId: "42" })).toEqual({
			status: "error",
			errorMessage: "GitHub Actions run #42 failed. The run has the details.",
		});
		expect(externalBuildOutcome("cancelled", { runId: "42" }).status).toBe(
			"cancelled",
		);
		// A skipped build is not a failure: cancelled, with the words the action sends.
		expect(externalBuildOutcome("skipped", { runId: null })).toEqual({
			status: "cancelled",
			errorMessage: "Build skipped",
		});
		expect(
			externalBuildOutcome("skipped", { runId: "42" }, "no changes").errorMessage,
		).toBe("Build skipped (no changes)");
		expect(
			externalBuildOutcome("failure", { runId: "42" }, "  tests red  ")
				.errorMessage,
		).toBe("GitHub Actions run #42 failed. tests red The run has the details.");
	});
});
