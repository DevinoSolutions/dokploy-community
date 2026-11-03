import type { GhaGateExpected, GhaGateMode } from "@dokploy/server/db/schema";
import {
	type CheckRunLike,
	evaluateRequiredChecks,
} from "../build-policy/required-checks";

/**
 * The deploy gate of "Build on GitHub Actions" (T-13720). Pure: no database, no
 * network, no clock. The poller hands an accepted release to the gate (see
 * deploy-gate-step.ts) and deploys it only when the answer is `deploy`.
 *
 *   image      always deploy
 *   checks     every check on the commit passes: the expected set is the
 *              required checks of the branch, else the checks of the last green
 *              commit, else whatever the commit reports (the fallback)
 *   workflows  the named workflows pass on the commit
 *
 * The latest attempt per name decides (a re-run replaces a failure), and a name
 * that has not reported when the timeout is over blocks the release. The
 * pass/fail rule itself is build-policy's `evaluateRequiredChecks`.
 */

/** One check run or commit status of the release commit, as GitHub reports it. */
export interface GateCheck {
	name: string;
	kind: "check-run" | "status";
	/** A check run's status; a commit status is `completed` once it left `pending`. */
	status: string;
	conclusion: string | null;
	id: number;
	startedAt: string | null;
	/** Slug of the GitHub App that created the check run. */
	appSlug: string | null;
	/** The workflow run behind a check run (from its details URL). */
	runId: number | null;
}

/** A workflow run of the release commit. */
export interface GateWorkflowRun {
	id: number;
	name: string;
	/** `.github/workflows/ci.yml`. */
	path: string;
	runAttempt: number;
	status: string;
	conclusion: string | null;
	startedAt: string | null;
}

export type ExpectedCheckSet = GhaGateExpected;

export type GateDecision =
	| { state: "deploy"; overridden?: boolean }
	| { state: "waiting"; reason: string; pendingNames: string[] }
	| {
			state: "blocked";
			reason: string;
			failedNames: string[];
			/** Names that never showed up for the whole timeout. */
			neverReported: string[];
			/** Names that showed up but never finished within the timeout. */
			unfinished: string[];
	  };

export type GateExclusion = (
	check: Pick<GateCheck, "name" | "kind" | "appSlug" | "runId">,
) => boolean;

/** Status contexts Dokploy posts to GitHub itself start with this. */
export const DOKPLOY_STATUS_PREFIX = "dokploy/";

/**
 * What the gate never waits for: the release run itself (and the other runs of
 * the release workflow), Dokploy's own statuses (`dokploy/...`) and the checks
 * of the GitHub App Dokploy acts as. Waiting for any of them would make the
 * gate wait for the release it is gating.
 */
export const createDefaultExclusion =
	({
		appSlug,
		excludedRunIds,
	}: {
		appSlug?: string | null;
		excludedRunIds?: Iterable<number>;
	}): GateExclusion =>
	(check) => {
		const runs = new Set(excludedRunIds ?? []);
		if (check.name.toLowerCase().startsWith(DOKPLOY_STATUS_PREFIX)) return true;
		if (appSlug && check.appSlug === appSlug) return true;
		return check.runId !== null && runs.has(check.runId);
	};

export interface DeployGateInput {
	mode: GhaGateMode;
	/** Milliseconds since the epoch. */
	now: number;
	/** When the gate began waiting for this release; null: just now. */
	startedAt: number | null;
	timeoutMs: number;
	/** `checks`: the expected set. Null or the fallback: wait for whatever the commit reports. */
	expected: ExpectedCheckSet | null;
	checks: GateCheck[];
	/** `workflows`: the names (or file names) to wait for. */
	workflows: string[];
	workflowRuns: GateWorkflowRun[];
	/** Runs that are never waited for: the release run and the other runs of its workflow. */
	excludedRunIds: number[];
	/** The GitHub App Dokploy acts as. */
	appSlug?: string | null;
	/** Replaces the default exclusion of checks. */
	isExcluded?: GateExclusion;
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const list = (names: string[]) => names.join(", ");
const checkWord = (names: string[], noun: string) =>
	names.length === 1 ? noun : `${noun}s`;

/** Is `a` a later attempt than `b`? By start time when both have one, else by id. */
const isLater = (
	a: { id: number; startedAt: string | null },
	b: { id: number; startedAt: string | null },
) => {
	const ta = a.startedAt ? Date.parse(a.startedAt) : Number.NaN;
	const tb = b.startedAt ? Date.parse(b.startedAt) : Number.NaN;
	if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta > tb;
	return a.id > b.id;
};

const toLike = (
	name: string,
	item: { status: string; conclusion: string | null },
): CheckRunLike => ({
	name,
	status: item.status,
	conclusion: item.conclusion,
});

/** The latest attempt of every check name, oldest first (the order `evaluateRequiredChecks` reads). */
export const latestChecksByName = (
	checks: GateCheck[],
	isExcluded: GateExclusion,
): GateCheck[] => {
	const latest = new Map<string, GateCheck>();
	for (const check of checks) {
		if (isExcluded(check)) continue;
		const known = latest.get(check.name);
		if (!known || isLater(check, known)) latest.set(check.name, check);
	}
	return [...latest.values()].sort((a, b) => (isLater(a, b) ? 1 : -1));
};

/**
 * The names of the check runs of a commit, when that commit is green: it has
 * check runs and the latest attempt of each has passed. Null otherwise. Used to
 * learn what "all checks" means from the last good commit of a branch.
 */
export const greenCheckRunNames = (
	checks: GateCheck[],
	isExcluded: GateExclusion,
): string[] | null => {
	const latest = latestChecksByName(
		checks.filter((c) => c.kind === "check-run"),
		isExcluded,
	);
	if (latest.length === 0) return null;
	const names = latest.map((c) => c.name);
	const result = evaluateRequiredChecks(
		names,
		latest.map((c) => toLike(c.name, c)),
	);
	return result.state === "satisfied" ? names.sort() : null;
};

interface Outcome {
	failed: string[];
	missing: string[];
	running: string[];
}

/** Partition the verdict of `evaluateRequiredChecks`: a name that never appeared is not one that is still running. */
const outcomeOf = (
	names: string[],
	seen: Set<string>,
	likes: CheckRunLike[],
): Outcome => {
	const result = evaluateRequiredChecks(names, likes);
	if (result.state === "failed") {
		return { failed: result.failed, missing: [], running: [] };
	}
	if (result.state === "pending") {
		return {
			failed: [],
			missing: result.waitingOn.filter((n) => !seen.has(n)),
			running: result.waitingOn.filter((n) => seen.has(n)),
		};
	}
	return { failed: [], missing: [], running: [] };
};

type Noun = "check" | "workflow";

const decide = (
	outcome: Outcome,
	noun: Noun,
	timedOut: boolean,
	timeoutMs: number,
): GateDecision => {
	const { failed, missing, running } = outcome;
	const label = noun === "check" ? "Check" : "Workflow";
	if (failed.length > 0) {
		return {
			state: "blocked",
			reason: `${checkWord(failed, label)} ${list(failed)} failed`,
			failedNames: failed,
			neverReported: [],
			unfinished: [],
		};
	}
	const pending = [...missing, ...running];
	if (pending.length === 0) return { state: "deploy" };
	if (!timedOut) {
		return {
			state: "waiting",
			reason: `Waiting for ${list(pending)}`,
			pendingNames: pending,
		};
	}
	const parts: string[] = [];
	if (missing.length > 0) {
		parts.push(
			`${checkWord(missing, label)} ${list(missing)} ${noun === "check" ? "never reported" : "never ran"}`,
		);
	}
	if (running.length > 0) {
		parts.push(
			`${checkWord(running, label)} ${list(running)} did not finish in ${minutes(timeoutMs)} minutes`,
		);
	}
	return {
		state: "blocked",
		reason: parts.join("; "),
		failedNames: [],
		neverReported: missing,
		unfinished: running,
	};
};

const baseName = (path: string) =>
	(path.split("@")[0] ?? "").split("/").pop() ?? "";
const withoutExtension = (file: string) => file.replace(/\.ya?ml$/i, "");

/** Does the workflow run answer to `wanted`: its name, or its file name with or without `.yml`? */
const runMatches = (run: GateWorkflowRun, wanted: string) =>
	run.name === wanted ||
	baseName(run.path) === wanted ||
	withoutExtension(baseName(run.path)) === wanted;

const evaluateChecks = (input: DeployGateInput, timedOut: boolean) => {
	const isExcluded =
		input.isExcluded ??
		createDefaultExclusion({
			appSlug: input.appSlug,
			excludedRunIds: input.excludedRunIds,
		});
	const latest = latestChecksByName(input.checks, isExcluded);
	const seen = new Set(latest.map((c) => c.name));
	const likes = latest.map((c) => toLike(c.name, c));

	const expectedNames =
		input.expected && input.expected.source !== "fallback"
			? [...new Set(input.expected.names)].filter(
					(name) =>
						!isExcluded({ name, kind: "status", appSlug: null, runId: null }),
				)
			: [];

	if (expectedNames.length > 0) {
		return decide(
			outcomeOf(expectedNames, seen, likes),
			"check",
			timedOut,
			input.timeoutMs,
		);
	}

	// The fallback: no expected set, so wait until the commit reports something
	// and nothing it reports is still queued or running.
	if (latest.length === 0) {
		if (timedOut) {
			return {
				state: "blocked",
				reason: `No checks reported on this commit in ${minutes(input.timeoutMs)} minutes`,
				failedNames: [],
				neverReported: [],
				unfinished: [],
			} satisfies GateDecision;
		}
		return {
			state: "waiting",
			reason: "Waiting for the first check to start",
			pendingNames: [],
		} satisfies GateDecision;
	}
	return decide(
		outcomeOf(
			latest.map((c) => c.name),
			seen,
			likes,
		),
		"check",
		timedOut,
		input.timeoutMs,
	);
};

const evaluateWorkflows = (
	input: DeployGateInput,
	timedOut: boolean,
): GateDecision => {
	const wanted = [...new Set(input.workflows)];
	if (wanted.length === 0) {
		return {
			state: "blocked",
			reason: "No workflow is chosen for the gate",
			failedNames: [],
			neverReported: [],
			unfinished: [],
		};
	}
	const excluded = new Set(input.excludedRunIds);
	const runs = input.workflowRuns.filter((run) => !excluded.has(run.id));
	const seen = new Set<string>();
	const likes: CheckRunLike[] = [];
	for (const name of wanted) {
		let latest: GateWorkflowRun | null = null;
		for (const run of runs) {
			if (!runMatches(run, name)) continue;
			if (!latest || isLater(withAttempt(run), withAttempt(latest)))
				latest = run;
		}
		if (latest) {
			seen.add(name);
			likes.push(toLike(name, latest));
		}
	}
	return decide(
		outcomeOf(wanted, seen, likes),
		"workflow",
		timedOut,
		input.timeoutMs,
	);
};

/** A re-run keeps the run id and raises the attempt, so id alone cannot order attempts of one run. */
const withAttempt = (run: GateWorkflowRun) => ({
	id: run.id * 1000 + Math.min(run.runAttempt, 999),
	startedAt: run.startedAt,
});

export const evaluateDeployGate = (input: DeployGateInput): GateDecision => {
	if (input.mode === "image") return { state: "deploy" };
	const startedAt = input.startedAt ?? input.now;
	const timedOut = input.now - startedAt >= input.timeoutMs;
	return input.mode === "workflows"
		? evaluateWorkflows(input, timedOut)
		: evaluateChecks(input, timedOut);
};

const STATUS_DESCRIPTION_MAX = 140;

/**
 * The line to post as the status of the GitHub Deployment while the release is
 * gated ("Waiting for CI"); GitHub keeps 140 characters.
 */
export const describeGateDecision = (decision: GateDecision): string => {
	let text: string;
	switch (decision.state) {
		case "deploy":
			text = decision.overridden
				? "Deployed without waiting for CI"
				: "CI passed";
			break;
		case "waiting": {
			const shown = decision.pendingNames.slice(0, 3);
			const more = decision.pendingNames.length - shown.length;
			text =
				shown.length === 0
					? "Waiting for CI"
					: `Waiting for CI: ${list(shown)}${more > 0 ? ` and ${more} more` : ""}`;
			break;
		}
		case "blocked":
			text = decision.reason;
			break;
	}
	return text.length > STATUS_DESCRIPTION_MAX
		? `${text.slice(0, STATUS_DESCRIPTION_MAX - 1)}…`
		: text;
};
