import type { ApiResult, RepositoryInfo, RunInfo } from "./actions-api";
import type { CompareStatus } from "./ordering";
import { evaluateStale, type StaleRun } from "./stale";
import type { ConnectionEvent, ConnectionState } from "./state-machine";

/**
 * What a connection looks at on GitHub between releases: is the repository
 * still there (and under which name), is GitHub Actions behind the branch
 * (Stale), and which runs are building right now (live rows). Pure
 * orchestration over injected reads, so the rules are tested without GitHub.
 */

export interface UpkeepReads {
	repository(): Promise<ApiResult<RepositoryInfo>>;
	branchHead(): Promise<ApiResult<{ sha: string }>>;
	workflowRuns(): Promise<ApiResult<RunInfo[]>>;
	compare(base: string, head: string): Promise<ApiResult<CompareStatus>>;
	workflowFile(): Promise<ApiResult<string>>;
}

export interface UpkeepInput {
	now: number;
	state: ConnectionState;
	repoId: number;
	repoFullName: string;
	trackedBranch: string;
	workflowPath: string;
	/** Commit Dokploy runs now (deployed or last verified); null before the first release. */
	deployedSha: string | null;
	/**
	 * Commits of releases Dokploy accepted and has not deployed yet (a release
	 * waiting at the deploy gate): GitHub Actions did publish those, so a branch
	 * head among them is not Stale.
	 */
	acceptedShas?: readonly string[];
}

export interface UpkeepResult {
	/** The repository answers to another name now; store it. */
	renamedTo: string | null;
	events: ConnectionEvent[];
	/** Runs of the release workflow that are queued or running on the tracked branch. */
	liveRuns: RunInfo[];
	/** Highest run id seen, for the stored cursor; null when none were read. */
	newestRunId: number | null;
	/** Every read worked; false means "ask again next tick", never "stale". */
	complete: boolean;
}

const RUNNING = new Set([
	"queued",
	"in_progress",
	"waiting",
	"pending",
	"requested",
]);
const WATCHED_STATES: ConnectionState[] = ["waiting", "connected", "stale"];

const time = (value: string | null) => {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
};

const toStaleRun = (run: RunInfo): StaleRun => {
	const started = time(run.runStartedAt);
	const updated = time(run.updatedAt);
	return {
		status: run.status,
		conclusion: run.conclusion,
		createdAt: started ?? updated ?? 0,
		startedAt: run.status === "queued" ? null : started,
		endedAt: run.status === "completed" ? updated : null,
	};
};

export const runUpkeep = async (
	input: UpkeepInput,
	reads: UpkeepReads,
): Promise<UpkeepResult> => {
	const result: UpkeepResult = {
		renamedTo: null,
		events: [],
		liveRuns: [],
		newestRunId: null,
		complete: false,
	};

	const repository = await reads.repository();
	if (repository.kind === "ok") {
		if (repository.value.fullName !== input.repoFullName) {
			result.renamedTo = repository.value.fullName;
		}
	} else if (repository.kind === "not-modified") {
		// Same answer as last time: the name did not change.
	} else if (repository.kind === "not-found") {
		if (WATCHED_STATES.includes(input.state)) {
			result.events.push({
				type: "stale",
				reason:
					"The repository was not found. Was it deleted, or was access lost?",
			});
		}
		return result;
	} else {
		return result;
	}

	const head = await reads.branchHead();
	if (head.kind !== "ok" && head.kind !== "not-found") return result;
	const branchExists = head.kind === "ok";
	const branchHead = head.kind === "ok" ? head.value.sha : null;

	const runs = await reads.workflowRuns();
	if (runs.kind !== "ok") return result;
	const allRuns = runs.value;
	result.newestRunId = allRuns.reduce<number | null>(
		(max, run) => (max === null || run.id > max ? run.id : max),
		null,
	);
	result.liveRuns = allRuns.filter(
		(run) =>
			RUNNING.has(run.status) &&
			run.headBranch === input.trackedBranch &&
			(run.event === "push" || run.event === "workflow_dispatch") &&
			run.repositoryId === input.repoId &&
			run.headRepositoryId === input.repoId,
	);

	let deployedOnBranch: boolean | null = null;
	if (branchExists && branchHead && input.deployedSha) {
		const compared = await reads.compare(input.deployedSha, branchHead);
		if (compared.kind === "ok") {
			deployedOnBranch =
				compared.value === "ahead" || compared.value === "identical";
		} else if (compared.kind === "not-found") {
			deployedOnBranch = false;
		} else {
			return result;
		}
	}

	let workflowPresent: boolean | null = null;
	if (branchExists) {
		const file = await reads.workflowFile();
		if (file.kind === "ok") workflowPresent = true;
		else if (file.kind === "not-found") workflowPresent = false;
	}

	result.complete = true;
	if (!WATCHED_STATES.includes(input.state)) return result;

	const onBranch = allRuns.filter(
		(run) => run.headBranch === input.trackedBranch,
	);
	const verdict = evaluateStale({
		now: input.now,
		trackedBranch: input.trackedBranch,
		branchExists,
		branchHead,
		lastReleaseSha:
			branchHead && input.acceptedShas?.includes(branchHead)
				? branchHead
				: input.deployedSha,
		deployedOnBranch,
		workflowPresent,
		workflowFile: input.workflowPath,
		runsForHead: onBranch
			.filter((run) => run.headSha === branchHead)
			.map(toStaleRun),
		recentFinishedRuns: onBranch
			.filter((run) => run.status === "completed")
			.slice(0, 5)
			.map(toStaleRun),
	});
	if (verdict.stale) {
		result.events.push({ type: "stale", reason: verdict.reason });
	} else if (input.state === "stale") {
		result.events.push({
			type: "fresh",
			hasRelease: input.deployedSha !== null,
		});
	}
	return result;
};
