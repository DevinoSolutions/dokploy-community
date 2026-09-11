import { BuildPolicyError } from "./errors";

/**
 * Per-unit `requiredChecks` gating (spec 5.2.7).
 *
 * Empty list (the default) means "deploy as soon as the image exists", so
 * push-to-deploy latency is unchanged until a team opts in.
 */
export interface CheckRunLike {
	name: string;
	status: string;
	conclusion: string | null;
}

export type RequiredChecksState =
	| { state: "satisfied" }
	| { state: "pending"; waitingOn: string[] }
	| { state: "failed"; failed: string[] };

/** Conclusions GitHub reports that do not block a deploy. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export const evaluateRequiredChecks = (
	requiredChecks: string[],
	runs: CheckRunLike[],
): RequiredChecksState => {
	if (requiredChecks.length === 0) return { state: "satisfied" };

	// A re-run produces a second run with the same name; the newest wins, and
	// the GitHub list endpoint returns them oldest-first.
	const latestByName = new Map<string, CheckRunLike>();
	for (const run of runs) {
		latestByName.set(run.name, run);
	}

	const failed: string[] = [];
	const waitingOn: string[] = [];

	for (const name of requiredChecks) {
		const run = latestByName.get(name);
		if (!run || run.status !== "completed") {
			waitingOn.push(name);
			continue;
		}
		if (!run.conclusion || !PASSING_CONCLUSIONS.has(run.conclusion)) {
			failed.push(name);
		}
	}

	// Fail fast: a failed check will not become successful by waiting.
	if (failed.length > 0) return { state: "failed", failed };
	if (waitingOn.length > 0) return { state: "pending", waitingOn };
	return { state: "satisfied" };
};

export interface WaitForRequiredChecksInput {
	requiredChecks: string[];
	owner: string;
	repo: string;
	sha: string;
	timeoutMs: number;
	pollIntervalMs: number;
	listCheckRuns: () => Promise<CheckRunLike[]>;
	sleep: (ms: number) => Promise<void> | void;
	now: () => number;
}

export const waitForRequiredChecks = async ({
	requiredChecks,
	owner,
	repo,
	sha,
	timeoutMs,
	pollIntervalMs,
	listCheckRuns,
	sleep,
	now,
}: WaitForRequiredChecksInput): Promise<void> => {
	if (requiredChecks.length === 0) return;

	const startedAt = now();
	let lastWaitingOn: string[] = [...requiredChecks];

	for (;;) {
		const runs = await listCheckRuns();
		const result = evaluateRequiredChecks(requiredChecks, runs);

		if (result.state === "satisfied") return;

		if (result.state === "failed") {
			throw new BuildPolicyError(
				"REQUIRED_CHECKS_FAILED",
				`Required GitHub checks failed on ${owner}/${repo}@${sha}: ${result.failed.join(", ")}. ` +
					"The deploy was stopped before the deploy step; the image, if any, stays in the registry.",
				{ owner, repo, sha, failed: result.failed },
			);
		}

		lastWaitingOn = result.waitingOn;

		if (now() - startedAt >= timeoutMs) break;
		await sleep(pollIntervalMs);
		if (now() - startedAt >= timeoutMs) break;
	}

	throw new BuildPolicyError(
		"REQUIRED_CHECKS_TIMEOUT",
		`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for required GitHub checks on ` +
			`${owner}/${repo}@${sha}: ${lastWaitingOn.join(", ")} never concluded.`,
		{ owner, repo, sha, waitingOn: lastWaitingOn, timeoutMs },
	);
};
