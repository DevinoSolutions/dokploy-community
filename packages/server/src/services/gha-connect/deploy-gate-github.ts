import {
	type ApiDeps,
	type ApiFailure,
	type ApiResult,
	apiGet,
	apiRepoPath,
	type RepoRef,
} from "./actions-api";
import {
	createDefaultExclusion,
	type ExpectedCheckSet,
	type GateCheck,
	type GateExclusion,
	type GateWorkflowRun,
	greenCheckRunNames,
} from "./deploy-gate";

/**
 * The GitHub reads of the deploy gate (T-13720): the expected check set of a
 * branch, the checks and statuses of a commit, and the workflow runs of a
 * commit. Everything goes through an injected `fetch` (actions-api's `get`);
 * nothing here logs or returns the token.
 */

/** A read that worked, or the reason it did not. */
export type GateRead<T> =
	| { kind: "ok"; value: T }
	| { kind: "failed"; failure: ApiFailure };

const asObject = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
const str = (value: unknown): string | null =>
	typeof value === "string" ? value : null;
const int = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) ? value : null;

const unwrap = <T>(result: ApiResult<T>): GateRead<T> =>
	result.kind === "ok"
		? { kind: "ok", value: result.value }
		: { kind: "failed", failure: result as ApiFailure };

const encodeBranch = (branch: string) =>
	branch.split("/").map(encodeURIComponent).join("/");

const SHA = /^[0-9a-f]{7,64}$/i;
const MAX_PAGES = 5;

/** Required status check names out of a branch's protection object. */
export const namesFromProtection = (json: unknown): string[] => {
	const required = asObject(
		asObject(asObject(json)?.protection)?.required_status_checks,
	);
	if (!required) return [];
	const names: string[] = [];
	if (Array.isArray(required.contexts)) {
		for (const context of required.contexts) {
			if (typeof context === "string") names.push(context);
		}
	}
	if (Array.isArray(required.checks)) {
		for (const check of required.checks) {
			const context = str(asObject(check)?.context);
			if (context) names.push(context);
		}
	}
	return names;
};

/** Required status check names out of the rules that apply to a branch (rulesets). */
export const namesFromRules = (json: unknown): string[] => {
	if (!Array.isArray(json)) return [];
	const names: string[] = [];
	for (const rule of json) {
		const o = asObject(rule);
		if (o?.type !== "required_status_checks") continue;
		const checks = asObject(o.parameters)?.required_status_checks;
		if (!Array.isArray(checks)) continue;
		for (const check of checks) {
			const context = str(asObject(check)?.context);
			if (context) names.push(context);
		}
	}
	return names;
};

export interface RequiredChecksRead {
	names: string[];
	/** False when neither source could be read (403/404): the next source applies. */
	readable: boolean;
}

/**
 * Required checks of the branch: branch protection
 * (`GET .../branches/{branch}`, `protection.required_status_checks`) and
 * rulesets (`GET .../rules/branches/{branch}`). A source the token cannot read
 * is skipped, not an error.
 */
export const loadRequiredChecks = async (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	branch: string,
): Promise<RequiredChecksRead> => {
	const base = apiRepoPath(ref);
	if (!base) return { names: [], readable: false };
	const [protection, rules] = await Promise.all([
		apiGet(deps, token, `${base}/branches/${encodeBranch(branch)}`, (json) =>
			asObject(json) ? namesFromProtection(json) : null,
		),
		apiGet(
			deps,
			token,
			`${base}/rules/branches/${encodeBranch(branch)}?per_page=100`,
			(json) => (Array.isArray(json) ? namesFromRules(json) : null),
		),
	]);
	const names = new Set<string>();
	let readable = false;
	for (const result of [protection, rules]) {
		if (result.kind !== "ok") continue;
		readable = true;
		for (const name of result.value) names.add(name);
	}
	return { names: [...names], readable };
};

/** The last `limit` commits of a branch, newest first. */
export const loadRecentCommits = async (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	branch: string,
	limit = 10,
): Promise<GateRead<string[]>> => {
	const base = apiRepoPath(ref);
	if (!base) return { kind: "failed", failure: { kind: "not-found" } };
	return unwrap(
		await apiGet(
			deps,
			token,
			`${base}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`,
			(json) =>
				Array.isArray(json)
					? json
							.map((c) => str(asObject(c)?.sha))
							.filter((s): s is string => s !== null)
					: null,
		),
	);
};

const RUN_IN_URL = /\/actions\/runs\/(\d+)/;

const mapCheckRun = (json: unknown): GateCheck | null => {
	const o = asObject(json);
	const id = int(o?.id);
	const name = str(o?.name);
	const status = str(o?.status);
	if (!o || id === null || !name || !status) return null;
	const url = str(o.details_url) ?? str(o.html_url) ?? "";
	const run = RUN_IN_URL.exec(url);
	return {
		name,
		kind: "check-run",
		status,
		conclusion: str(o.conclusion),
		id,
		startedAt: str(o.started_at) ?? str(o.created_at),
		appSlug: str(asObject(o.app)?.slug),
		runId: run?.[1] ? Number(run[1]) : null,
	};
};

/** A commit status carries a `state`; it is mapped onto the check run vocabulary. */
const mapStatus = (json: unknown): GateCheck | null => {
	const o = asObject(json);
	const id = int(o?.id);
	const context = str(o?.context);
	const state = str(o?.state);
	if (!o || id === null || !context || !state) return null;
	const done = state === "success" || state === "failure" || state === "error";
	return {
		name: context,
		kind: "status",
		status: done ? "completed" : "in_progress",
		conclusion: done ? (state === "success" ? "success" : "failure") : null,
		id,
		startedAt: str(o.updated_at) ?? str(o.created_at),
		appSlug: null,
		runId: null,
	};
};

/**
 * The latest check runs (`filter=latest`: the newest run of each name) and
 * commit statuses of a commit. A token that cannot read statuses still gets the
 * check runs; any other failure of either read is a failure of the whole.
 */
export const loadCommitChecks = async (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	sha: string,
): Promise<GateRead<GateCheck[]>> => {
	const base = apiRepoPath(ref);
	if (!base || !SHA.test(sha)) {
		return { kind: "failed", failure: { kind: "not-found" } };
	}
	const readCheckRuns = async (): Promise<GateRead<GateCheck[]>> => {
		const all: GateCheck[] = [];
		for (let page = 1; page <= MAX_PAGES; page++) {
			const result = await apiGet(
				deps,
				token,
				`${base}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`,
				(json) => {
					const o = asObject(json);
					if (!o || !Array.isArray(o.check_runs)) return null;
					return {
						total: int(o.total_count) ?? o.check_runs.length,
						runs: o.check_runs
							.map(mapCheckRun)
							.filter((c): c is GateCheck => c !== null),
					};
				},
			);
			if (result.kind !== "ok") return unwrap(result);
			all.push(...result.value.runs);
			if (all.length >= result.value.total || result.value.runs.length === 0) {
				break;
			}
		}
		return { kind: "ok", value: all };
	};
	const readStatuses = async (): Promise<GateRead<GateCheck[]>> => {
		const result = await apiGet(
			deps,
			token,
			`${base}/commits/${sha}/status?per_page=100`,
			(json) => {
				const o = asObject(json);
				if (!o || !Array.isArray(o.statuses)) return null;
				return o.statuses
					.map(mapStatus)
					.filter((c): c is GateCheck => c !== null);
			},
		);
		// A token without the statuses scope must not stop the gate: the check runs decide.
		if (result.kind === "forbidden" || result.kind === "not-found") {
			return { kind: "ok", value: [] };
		}
		return unwrap(result);
	};
	const [runs, statuses] = await Promise.all([readCheckRuns(), readStatuses()]);
	if (runs.kind === "failed") return runs;
	if (statuses.kind === "failed") return statuses;
	return { kind: "ok", value: [...runs.value, ...statuses.value] };
};

const mapWorkflowRun = (json: unknown): GateWorkflowRun | null => {
	const o = asObject(json);
	const id = int(o?.id);
	const status = str(o?.status);
	if (!o || id === null || !status) return null;
	return {
		id,
		name: str(o.name) ?? "",
		path: (str(o.path) ?? "").split("@")[0] ?? "",
		runAttempt: int(o.run_attempt) ?? 1,
		status,
		conclusion: str(o.conclusion),
		startedAt: str(o.run_started_at) ?? str(o.created_at),
	};
};

/** `GET .../actions/runs?head_sha=`: the workflow runs of a commit (the newest attempt of each run). */
export const loadWorkflowRuns = async (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	sha: string,
): Promise<GateRead<GateWorkflowRun[]>> => {
	const base = apiRepoPath(ref);
	if (!base || !SHA.test(sha)) {
		return { kind: "failed", failure: { kind: "not-found" } };
	}
	const all: GateWorkflowRun[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const result = await apiGet(
			deps,
			token,
			`${base}/actions/runs?head_sha=${sha}&per_page=100&page=${page}`,
			(json) => {
				const o = asObject(json);
				if (!o || !Array.isArray(o.workflow_runs)) return null;
				return {
					total: int(o.total_count) ?? o.workflow_runs.length,
					runs: o.workflow_runs
						.map(mapWorkflowRun)
						.filter((r): r is GateWorkflowRun => r !== null),
				};
			},
		);
		if (result.kind !== "ok") return unwrap(result);
		all.push(...result.value.runs);
		if (all.length >= result.value.total || result.value.runs.length === 0) {
			break;
		}
	}
	return { kind: "ok", value: all };
};

/** Runs of the release workflow (it may run more than once per commit): never waited for. */
export const releaseWorkflowRunIds = (
	runs: GateWorkflowRun[],
	workflowPath: string,
): number[] =>
	runs.filter((run) => run.path === workflowPath).map((run) => run.id);

export interface ExpectedSetInput {
	branch: string;
	/** The release commit: not a candidate for "last green". */
	sha: string;
	/** The release workflow file, `.github/workflows/dokploy.yml`. */
	workflowPath: string;
	appSlug?: string | null;
	/** Replaces the default exclusion of checks. */
	isExcluded?: GateExclusion;
}

/**
 * What "all checks" means on this branch, first that applies:
 *   1. the required checks of branch protection or rulesets (skipped when unreadable);
 *   2. the check run names of the last green commit among the last ten of the
 *      branch (not counting the release workflow's own runs);
 *   3. the fallback: no set, wait for whatever the commit reports.
 * A repository with only commit statuses has no check runs on any commit, so it
 * ends in the fallback.
 */
export const loadExpectedCheckSet = async (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	input: ExpectedSetInput,
): Promise<GateRead<ExpectedCheckSet>> => {
	const exclusionFor = (excludedRunIds: number[]): GateExclusion =>
		input.isExcluded ??
		createDefaultExclusion({ appSlug: input.appSlug, excludedRunIds });
	const ownName = (name: string) =>
		exclusionFor([])({ name, kind: "status", appSlug: null, runId: null });

	const required = await loadRequiredChecks(deps, token, ref, input.branch);
	const requiredNames = required.names.filter((name) => !ownName(name));
	if (requiredNames.length > 0) {
		return {
			kind: "ok",
			value: { source: "required", names: requiredNames.sort() },
		};
	}

	const recent = await loadRecentCommits(deps, token, ref, input.branch, 10);
	if (recent.kind === "failed") {
		// A branch that cannot be listed has no history to learn from; anything
		// else (rate limit, a bad token) is a failure the caller retries.
		if (recent.failure.kind === "not-found") {
			return { kind: "ok", value: { source: "fallback", names: [] } };
		}
		return recent;
	}
	for (const sha of recent.value) {
		if (sha === input.sha) continue;
		const [checks, runs] = await Promise.all([
			loadCommitChecks(deps, token, ref, sha),
			loadWorkflowRuns(deps, token, ref, sha),
		]);
		// A commit that is gone is skipped; any other failure is the caller's to retry.
		if (checks.kind === "failed") {
			if (checks.failure.kind === "not-found") continue;
			return checks;
		}
		if (runs.kind === "failed" && runs.failure.kind !== "not-found")
			return runs;
		const excludedRunIds =
			runs.kind === "ok"
				? releaseWorkflowRunIds(runs.value, input.workflowPath)
				: [];
		const names = greenCheckRunNames(
			checks.value,
			exclusionFor(excludedRunIds),
		);
		if (names) return { kind: "ok", value: { source: "last-green", names } };
	}
	return { kind: "ok", value: { source: "fallback", names: [] } };
};

/** The reads of one repository, bound to its token, for `runDeployGate`. */
export interface GateGithub {
	loadExpectedCheckSet(
		input: ExpectedSetInput,
	): Promise<GateRead<ExpectedCheckSet>>;
	loadCommitChecks(sha: string): Promise<GateRead<GateCheck[]>>;
	loadWorkflowRuns(sha: string): Promise<GateRead<GateWorkflowRun[]>>;
}

export const createGateGithub = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
): GateGithub => ({
	loadExpectedCheckSet: (input) =>
		loadExpectedCheckSet(deps, token, ref, input),
	loadCommitChecks: (sha) => loadCommitChecks(deps, token, ref, sha),
	loadWorkflowRuns: (sha) => loadWorkflowRuns(deps, token, ref, sha),
});
