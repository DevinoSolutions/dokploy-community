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
 *   checks     every check on the commit passes: the expected set (required
 *              checks of the branch, else the checks of the last green commit)
 *              decides what is WAITED for; any other check that failed blocks
 *              too. With no expected set (the fallback) the gate waits for
 *              whatever the commit reports.
 *   workflows  the named workflows pass on the commit
 *
 * What counts as a result of the commit (the sources are not equal):
 *   - a workflow run counts only when it is a push or a manual dispatch of the
 *     tracked branch from the connection's own repository. A pull request from
 *     a fork, or any other event that happens to carry this sha, never counts.
 *   - the latest run of each workflow (by file) decides, not the latest result
 *     of a name across workflows, so two workflows sharing a job name cannot
 *     hide each other's failure.
 *   - a check run of a workflow counts only through such a run (its details URL
 *     or check suite). A check run of another app counts as that app's.
 *   - a commit status counts only for a name no check run reports, and never
 *     overrides a check run.
 * The pass/fail rule itself is build-policy's `evaluateRequiredChecks`.
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
	/** Id of that App (branch protection can pin a required check to one). */
	appId: number | null;
	/** The workflow run behind a check run (from its details URL). */
	runId: number | null;
	/** The check suite of the check run (a workflow run has one). */
	checkSuiteId: number | null;
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
	/** `push`, `workflow_dispatch`, `pull_request`, ... */
	event: string;
	headBranch: string | null;
	/** `owner/name` of the repository the run's commit was pushed to. */
	headRepository: string | null;
	/** Its immutable id: a rename changes the name, not this. */
	headRepositoryId: number | null;
	checkSuiteId: number | null;
}

/** The branch and repository a run must come from to count. */
export interface GateTrust {
	branch: string;
	/** `owner/name`: compared only when a run or the connection has no id. */
	repository: string;
	/** The connection's repository id; compared with the run's head repository id when both are known. */
	repositoryId?: number | null;
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

/** Events whose runs are results of the tracked branch. */
export const TRUSTED_RUN_EVENTS: readonly string[] = [
	"push",
	"workflow_dispatch",
];

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
	/** `workflows`: the workflow names (or `.yml` file names) to wait for. */
	workflows: string[];
	workflowRuns: GateWorkflowRun[];
	/** Runs that are never waited for: the release run and the other runs of its workflow. */
	excludedRunIds: number[];
	/** Where a run must come from to count. */
	trust: GateTrust;
	/** The GitHub App Dokploy acts as. */
	appSlug?: string | null;
	/** Replaces the default exclusion of checks. */
	isExcluded?: GateExclusion;
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const list = (names: string[]) => names.join(", ");
const checkWord = (names: string[], noun: string) =>
	names.length === 1 ? noun : `${noun}s`;
const unique = (names: string[]) => [...new Set(names)];
const time = (value: string | null) => {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isNaN(parsed) ? null : parsed;
};

/** Is `a` a later attempt than `b`? By start time when both have one, else by id. */
const isLater = (
	a: { id: number; startedAt: string | null },
	b: { id: number; startedAt: string | null },
) => {
	const ta = time(a.startedAt);
	const tb = time(b.startedAt);
	if (ta !== null && tb !== null && ta !== tb) return ta > tb;
	return a.id > b.id;
};

/** A re-run keeps the run id and raises the attempt, so id alone cannot order attempts of one run. */
const withAttempt = (run: GateWorkflowRun) => ({
	id: run.id * 1000 + Math.min(run.runAttempt, 999),
	startedAt: run.startedAt,
});

export type Verdict = "passed" | "failed" | "running";

/** The pass/fail rule of build-policy applied to one result. */
export const verdictOf = (item: {
	status: string;
	conclusion: string | null;
}): Verdict => {
	const like: CheckRunLike = {
		name: "x",
		status: item.status,
		conclusion: item.conclusion,
	};
	const result = evaluateRequiredChecks(["x"], [like]);
	return result.state === "satisfied"
		? "passed"
		: result.state === "failed"
			? "failed"
			: "running";
};

/** The run's commit lives in the connection's repository (by id when both are known, else by name). */
const fromTrustedRepository = (run: GateWorkflowRun, trust: GateTrust) =>
	trust.repositoryId != null && run.headRepositoryId !== null
		? run.headRepositoryId === trust.repositoryId
		: run.headRepository !== null &&
			run.headRepository.toLowerCase() === trust.repository.toLowerCase();

const isTrustedRun = (run: GateWorkflowRun, trust: GateTrust) =>
	TRUSTED_RUN_EVENTS.includes(run.event) &&
	run.headBranch === trust.branch &&
	fromTrustedRepository(run, trust);

const workflowKey = (run: GateWorkflowRun) => run.path || run.name;

/** The latest run of each workflow among the runs that count (trusted, not excluded). */
export const latestTrustedRuns = (
	runs: GateWorkflowRun[],
	trust: GateTrust,
	excludedRunIds: Iterable<number>,
): GateWorkflowRun[] => {
	const excluded = new Set(excludedRunIds);
	const latest = new Map<string, GateWorkflowRun>();
	for (const run of runs) {
		if (excluded.has(run.id) || !isTrustedRun(run, trust)) continue;
		const known = latest.get(workflowKey(run));
		if (!known || isLater(withAttempt(run), withAttempt(known))) {
			latest.set(workflowKey(run), run);
		}
	}
	return [...latest.values()];
};

/** One result that counts, after the sources were sorted out. */
export interface ResolvedCheck {
	name: string;
	kind: "check-run" | "status";
	verdict: Verdict;
	appId: number | null;
	/** Epoch ms the result started, when known. */
	since: number | null;
}

export interface ResolveInput {
	checks: GateCheck[];
	workflowRuns: GateWorkflowRun[];
	trust: GateTrust;
	excludedRunIds: number[];
	isExcluded: GateExclusion;
}

/**
 * The results of a commit that count (see the header): one per workflow and
 * check name for the latest run of each workflow, one per app and name for
 * check runs of other apps (every check run has a check suite, but only an
 * Actions suite has a workflow run), and one per context for the commit
 * statuses of a name that no check run reports.
 */
export const resolveChecks = (input: ResolveInput): ResolvedCheck[] => {
	const latestRuns = latestTrustedRuns(
		input.workflowRuns,
		input.trust,
		input.excludedRunIds,
	);
	const latestIds = new Set(latestRuns.map((run) => run.id));
	const runBySuite = new Map<number, GateWorkflowRun>();
	const runById = new Map<number, GateWorkflowRun>();
	for (const run of input.workflowRuns) {
		runById.set(run.id, run);
		if (run.checkSuiteId !== null) runBySuite.set(run.checkSuiteId, run);
	}

	const latest = new Map<string, GateCheck & { key: string }>();
	for (const check of input.checks) {
		if (input.isExcluded(check)) continue;
		let key: string;
		if (check.kind === "status") {
			key = `status::${check.name}`;
		} else if (check.appSlug === "github-actions" || check.runId !== null) {
			// A check run of GitHub Actions belongs to a workflow run, which has to count.
			// Other apps (CircleCI, SonarCloud, Vercel) have check suites too, but no run.
			const run =
				(check.runId !== null ? runById.get(check.runId) : undefined) ??
				(check.checkSuiteId !== null
					? runBySuite.get(check.checkSuiteId)
					: undefined);
			// A run that is not listed cannot be verified; one that does not count
			// (fork pull request, another branch, an old run of the workflow) is not a result.
			if (!run || !latestIds.has(run.id)) continue;
			key = `wf:${workflowKey(run)}::${check.name}`;
		} else {
			key = `app:${check.appSlug ?? check.appId ?? ""}::${check.name}`;
		}
		const known = latest.get(key);
		if (!known || isLater(check, known)) latest.set(key, { ...check, key });
	}

	const checkRunNames = new Set(
		[...latest.values()]
			.filter((c) => c.kind === "check-run")
			.map((c) => c.name),
	);
	const resolved: ResolvedCheck[] = [];
	for (const check of latest.values()) {
		if (check.kind === "status" && checkRunNames.has(check.name)) continue;
		resolved.push({
			name: check.name,
			kind: check.kind,
			verdict: verdictOf(check),
			appId: check.appId,
			since: time(check.startedAt),
		});
	}
	return resolved;
};

/**
 * The names of the check runs of a commit, when that commit is green: it has
 * check runs, every one that counts passed, and no workflow run that counts
 * failed or is still running. Null otherwise. Used to learn what "all checks"
 * means from the last good commit of a branch.
 */
export const greenCheckRunNames = (input: ResolveInput): string[] | null => {
	const resolved = resolveChecks({
		...input,
		checks: input.checks.filter((c) => c.kind === "check-run"),
	});
	if (resolved.length === 0) return null;
	if (resolved.some((r) => r.verdict !== "passed")) return null;
	const runs = latestTrustedRuns(
		input.workflowRuns,
		input.trust,
		input.excludedRunIds,
	);
	if (runs.some((run) => verdictOf(run) !== "passed")) return null;
	return unique(resolved.map((r) => r.name)).sort();
};

type Noun = "check" | "workflow";

interface Pending {
	name: string;
	/** Epoch ms it started; null: it has not started (or we cannot tell). */
	since: number | null;
}

interface Group {
	noun: Noun;
	failed: string[];
	missing: string[];
	running: Pending[];
}

interface Clock {
	now: number;
	/** When the gate began waiting. */
	gateStart: number;
	timeoutMs: number;
}

const label = (noun: Noun) => (noun === "check" ? "Check" : "Workflow");

const decide = (groups: Group[], clock: Clock): GateDecision => {
	const failed = groups.filter((g) => g.failed.length > 0);
	if (failed.length > 0) {
		return {
			state: "blocked",
			reason: failed
				.map(
					(g) =>
						`${checkWord(g.failed, label(g.noun))} ${list(g.failed)} failed`,
				)
				.join("; "),
			failedNames: unique(failed.flatMap((g) => g.failed)),
			neverReported: [],
			unfinished: [],
		};
	}
	const gateTimedOut = clock.now - clock.gateStart >= clock.timeoutMs;
	const pendingNames = unique(
		groups.flatMap((g) => [...g.missing, ...g.running.map((r) => r.name)]),
	);
	if (pendingNames.length === 0) return { state: "deploy" };

	// A running result is measured from its own start, so a fresh re-run gets its
	// full time even when the gate has been waiting longer.
	const stuck = (g: Group) =>
		g.running.filter(
			(r) => clock.now - (r.since ?? clock.gateStart) >= clock.timeoutMs,
		);
	const parts: string[] = [];
	const neverReported: string[] = [];
	const unfinished: string[] = [];
	for (const g of groups) {
		if (gateTimedOut && g.missing.length > 0) {
			neverReported.push(...g.missing);
			parts.push(
				`${checkWord(g.missing, label(g.noun))} ${list(g.missing)} ${g.noun === "check" ? "never reported" : "never ran"}`,
			);
		}
		const late = stuck(g).map((r) => r.name);
		if (late.length > 0) {
			unfinished.push(...late);
			parts.push(
				`${checkWord(late, label(g.noun))} ${list(late)} did not finish in ${minutes(clock.timeoutMs)} minutes`,
			);
		}
	}
	if (parts.length === 0) {
		return {
			state: "waiting",
			reason: `Waiting for ${list(pendingNames)}`,
			pendingNames,
		};
	}
	return {
		state: "blocked",
		reason: parts.join("; "),
		failedNames: [],
		neverReported: unique(neverReported),
		unfinished: unique(unfinished),
	};
};

const baseName = (path: string) =>
	(path.split("@")[0] ?? "").split("/").pop() ?? "";

/**
 * Does the workflow run answer to `wanted`? An entry ending in `.yml` or
 * `.yaml` is a file name and matches the workflow file only; any other entry
 * is a workflow name and matches the run's name only.
 */
const runMatches = (run: GateWorkflowRun, wanted: string) =>
	/\.ya?ml$/i.test(wanted)
		? baseName(run.path) === wanted || run.path === wanted
		: run.name === wanted;

const worst = (verdicts: Verdict[]): Verdict =>
	verdicts.includes("failed")
		? "failed"
		: verdicts.includes("running")
			? "running"
			: "passed";

const asLike = (name: string, verdict: Verdict): CheckRunLike => ({
	name,
	status: verdict === "running" ? "in_progress" : "completed",
	conclusion:
		verdict === "failed" ? "failure" : verdict === "passed" ? "success" : null,
});

/** Wait for `names` (each judged by the worst of its results), via build-policy's rule. */
const waitFor = (
	names: string[],
	results: (name: string) => Array<{ verdict: Verdict; since: number | null }>,
	noun: Noun,
): Group => {
	const likes: CheckRunLike[] = [];
	const missing: string[] = [];
	const sinceOf = new Map<string, number | null>();
	for (const name of names) {
		const found = results(name);
		if (found.length === 0) {
			missing.push(name);
			continue;
		}
		likes.push(asLike(name, worst(found.map((f) => f.verdict))));
		// The most recent start of what is still running: a fresh re-run restarts the clock.
		const starts = found
			.filter((f) => f.verdict === "running")
			.map((f) => f.since)
			.filter((s): s is number => s !== null);
		sinceOf.set(name, starts.length > 0 ? Math.max(...starts) : null);
	}
	const verdict = evaluateRequiredChecks(
		names.filter((n) => !missing.includes(n)),
		likes,
	);
	return {
		noun,
		failed: verdict.state === "failed" ? verdict.failed : [],
		missing,
		running:
			verdict.state === "pending"
				? verdict.waitingOn.map((name) => ({
						name,
						since: sinceOf.get(name) ?? null,
					}))
				: [],
	};
};

const evaluateChecks = (input: DeployGateInput, clock: Clock): GateDecision => {
	const isExcluded =
		input.isExcluded ??
		createDefaultExclusion({
			appSlug: input.appSlug,
			excludedRunIds: input.excludedRunIds,
		});
	const resolved = resolveChecks({
		checks: input.checks,
		workflowRuns: input.workflowRuns,
		trust: input.trust,
		excludedRunIds: input.excludedRunIds,
		isExcluded,
	});
	const runs = latestTrustedRuns(
		input.workflowRuns,
		input.trust,
		input.excludedRunIds,
	);
	const runResults = runs.map((run) => ({
		name: run.name,
		verdict: verdictOf(run),
		since: time(run.startedAt),
	}));

	const appIds = input.expected?.appIds ?? {};
	const expectedNames =
		input.expected && input.expected.source !== "fallback"
			? unique(input.expected.names).filter(
					(name) =>
						!isExcluded({ name, kind: "status", appSlug: null, runId: null }),
				)
			: [];

	if (expectedNames.length > 0) {
		// The expected set decides what is waited for. Anything else that counts
		// and has failed blocks too.
		const checkGroup = waitFor(
			expectedNames,
			(name) =>
				resolved.filter(
					(r) =>
						r.name === name &&
						(appIds[name] === undefined ||
							(r.kind === "check-run" && r.appId === appIds[name])),
				),
			"check",
		);
		const expected = new Set(expectedNames);
		const otherFailed = unique(
			resolved
				.filter((r) => r.verdict === "failed" && !expected.has(r.name))
				.map((r) => r.name),
		);
		checkGroup.failed = unique([...checkGroup.failed, ...otherFailed]);
		const workflowGroup: Group = {
			noun: "workflow",
			failed: unique(
				runResults.filter((r) => r.verdict === "failed").map((r) => r.name),
			),
			missing: [],
			running: [],
		};
		return decide([checkGroup, workflowGroup], clock);
	}

	// The fallback: no expected set, so wait until the commit reports something
	// and nothing it reports (checks or workflow runs) is queued or running, and
	// block on anything that failed.
	if (resolved.length === 0 && runResults.length === 0) {
		if (clock.now - clock.gateStart >= clock.timeoutMs) {
			return {
				state: "blocked",
				reason: `No checks reported on this commit in ${minutes(clock.timeoutMs)} minutes`,
				failedNames: [],
				neverReported: [],
				unfinished: [],
			};
		}
		return {
			state: "waiting",
			reason: "Waiting for the first check to start",
			pendingNames: [],
		};
	}
	const pendingOf = (
		items: Array<{ name: string; verdict: Verdict; since: number | null }>,
	) =>
		items
			.filter((i) => i.verdict === "running")
			.map((i) => ({ name: i.name, since: i.since }));
	return decide(
		[
			{
				noun: "check",
				failed: unique(
					resolved.filter((r) => r.verdict === "failed").map((r) => r.name),
				),
				missing: [],
				running: pendingOf(resolved),
			},
			{
				noun: "workflow",
				failed: unique(
					runResults.filter((r) => r.verdict === "failed").map((r) => r.name),
				),
				missing: [],
				running: pendingOf(runResults),
			},
		],
		clock,
	);
};

const evaluateWorkflows = (
	input: DeployGateInput,
	clock: Clock,
): GateDecision => {
	const wanted = unique(input.workflows);
	if (wanted.length === 0) {
		return {
			state: "blocked",
			reason: "No workflow is chosen for the gate",
			failedNames: [],
			neverReported: [],
			unfinished: [],
		};
	}
	const runs = latestTrustedRuns(
		input.workflowRuns,
		input.trust,
		input.excludedRunIds,
	);
	const group = waitFor(
		wanted,
		(name) =>
			runs
				.filter((run) => runMatches(run, name))
				.map((run) => ({
					verdict: verdictOf(run),
					since: time(run.startedAt),
				})),
		"workflow",
	);
	return decide([group], clock);
};

export const evaluateDeployGate = (input: DeployGateInput): GateDecision => {
	if (input.mode === "image") return { state: "deploy" };
	const clock: Clock = {
		now: input.now,
		gateStart: input.startedAt ?? input.now,
		timeoutMs: input.timeoutMs,
	};
	return input.mode === "workflows"
		? evaluateWorkflows(input, clock)
		: evaluateChecks(input, clock);
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
