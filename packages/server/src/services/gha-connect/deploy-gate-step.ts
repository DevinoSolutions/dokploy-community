import type {
	GhaGateExpected,
	GhaGateMode,
	GhaGateState,
} from "@dokploy/server/db/schema";
import type { ApiFailure } from "./actions-api";
import {
	createDefaultExclusion,
	type DeployGateInput,
	type ExpectedCheckSet,
	evaluateDeployGate,
	type GateCheck,
	type GateDecision,
	type GateExclusion,
	type GateWorkflowRun,
} from "./deploy-gate";
import {
	type GateGithub,
	type GateRead,
	releaseWorkflowRunIds,
} from "./deploy-gate-github";

/**
 * The one step the connection poll takes between accepting a release and
 * starting its deploy (T-13720):
 *
 *   acceptance -> recordRelease(status accepted) -> runDeployGate -> startDeploy
 *
 * The poll calls `runDeployGate` for every accepted release that has not been
 * deployed, on each tick, and starts the deploy only on `{ state: "deploy" }`.
 * While the answer is `waiting` it posts `describeGateDecision(decision)` as
 * the `queued` status; `blocked` stays blocked until the next tick sees a
 * passing re-run, a mode change or Deploy anyway. A newer release supersedes a
 * waiting one: the poll then calls `store.clearGateStart`.
 *
 * Everything it touches is injected: GitHub reads (`GateGithub`) and the
 * database (`DeployGateStore`), so the order and the persistence are tested
 * without either.
 */

export interface GateConnection {
	ghaConnectionId: string;
	/** The connection's own state, to block and unblock it. */
	state: string;
	/** True while the connection is Blocked by the gate (not by something else). */
	gateBlocked: boolean;
	/** `owner/name` of the repository: runs must come from it to count. */
	repoFullName: string;
	trackedBranch: string;
	/** The release workflow file, `.github/workflows/dokploy.yml`. */
	workflowPath: string;
	gateMode: GhaGateMode;
	gateWorkflows: string[];
	gateTimeoutMinutes: number;
	gateStartedAt: Date | null;
	deployedSha: string | null;
}

export interface GateRelease {
	releaseId: string;
	sha: string;
	/** The release run: never waited for. */
	runId: number;
	createdAt: Date;
	gateState: GhaGateState | null;
	gateExpected: GhaGateExpected | null;
	/** `gateCheckedAt` as read with the release at the start of this tick. */
	gateCheckedAt: Date | null;
}

export interface GateOutcome {
	gateState: GhaGateState;
	gateReason: string | null;
	checkedAt: Date;
	/** What `gateCheckedAt` was when the release was read: the write happens only if it still is. */
	previousCheckedAt: Date | null;
	/** Saved with the release the first time the expected set is learned. */
	gateExpected?: ExpectedCheckSet;
	/** The start of the wait: set now, cleared, or left. */
	gateStart: "mark" | "clear" | "keep";
	/** The connection: block it (with the reason), lift the gate's block, or leave it. */
	connection: "block" | "unblock" | "keep";
	/** For `unblock`: whether a release was ever deployed (Connected) or not (Waiting). */
	hasRelease: boolean;
}

/** What the step writes. The database implementation is in deploy-gate-store.ts. */
export interface DeployGateStore {
	clearGateStart(ghaConnectionId: string): Promise<void>;
	/**
	 * Record one evaluation and its effects in one transaction. Writes nothing
	 * and answers false when the release is no longer accepted, was overridden
	 * (Deploy anyway) or was evaluated by someone else since it was read.
	 */
	recordGateOutcome(
		ghaConnectionId: string,
		releaseId: string,
		outcome: GateOutcome,
	): Promise<boolean>;
}

export interface RunDeployGateInput {
	connection: GateConnection;
	release: GateRelease;
	github: GateGithub;
	/** Milliseconds since the epoch. */
	now: () => number;
	store: DeployGateStore;
	/** The GitHub App Dokploy acts as; its check runs are never waited for. */
	appSlug?: string | null;
	/** Replaces the default exclusion of checks (Dokploy's own statuses and the release run). */
	isExcluded?: GateExclusion;
}

const MINUTE = 60_000;

const blockedBy = (reason: string): GateDecision => ({
	state: "blocked",
	reason,
	failedNames: [],
	neverReported: [],
	unfinished: [],
});

/** GitHub could not be read: wait and try again, but never guess a pass. */
const failureDecision = (
	failure: ApiFailure,
	stage: string | undefined,
	timedOut: boolean,
	minutes: number,
): GateDecision => {
	if (failure.kind === "unauthorized" || failure.kind === "forbidden") {
		return blockedBy(
			"GitHub did not let Dokploy read the checks. Reconnect GitHub.",
		);
	}
	if (timedOut) {
		return blockedBy(`GitHub could not be read for ${minutes} minutes`);
	}
	return {
		state: "waiting",
		reason:
			stage === "protection"
				? "could not read branch protection, retrying"
				: "GitHub could not be read, trying again",
		pendingNames: [],
	};
};

const GATE_STATE_OF: Record<GateDecision["state"], GhaGateState> = {
	deploy: "passed",
	waiting: "waiting",
	blocked: "blocked",
};

export const runDeployGate = async ({
	connection,
	release,
	github,
	now,
	store,
	appSlug = null,
	isExcluded,
}: RunDeployGateInput): Promise<GateDecision> => {
	// The setting off: nothing to read, nothing to write.
	if (connection.gateMode === "image") return { state: "deploy" };
	// Deploy anyway was said for this release: it goes, once.
	if (release.gateState === "overridden") {
		return { state: "deploy", overridden: true };
	}

	const nowMs = now();
	// A start before this release existed belongs to an older release.
	const startedAt =
		connection.gateStartedAt &&
		connection.gateStartedAt.getTime() >= release.createdAt.getTime()
			? connection.gateStartedAt
			: null;
	const timeoutMs = connection.gateTimeoutMinutes * MINUTE;
	const timedOut =
		startedAt !== null && nowMs - startedAt.getTime() >= timeoutMs;
	const failed = (
		read: Extract<GateRead<unknown>, { kind: "failed" }>,
	): GateDecision =>
		failureDecision(
			read.failure,
			read.stage,
			timedOut,
			connection.gateTimeoutMinutes,
		);

	let expected: ExpectedCheckSet | null = release.gateExpected;
	let learned: ExpectedCheckSet | undefined;
	let decision: GateDecision | null = null;
	let checks: GateCheck[] = [];
	let workflowRuns: GateWorkflowRun[] = [];

	const runsRead: GateRead<GateWorkflowRun[]> = await github.loadWorkflowRuns(
		release.sha,
	);
	if (runsRead.kind === "failed") {
		decision = failed(runsRead);
	} else {
		workflowRuns = runsRead.value;
	}

	if (!decision && connection.gateMode === "checks") {
		if (!expected) {
			const expectedRead = await github.loadExpectedCheckSet({
				branch: connection.trackedBranch,
				sha: release.sha,
				workflowPath: connection.workflowPath,
				appSlug,
				isExcluded,
			});
			if (expectedRead.kind === "failed") {
				// Not saved: a set learned from a failed read would be a guess.
				decision = failed(expectedRead);
			} else {
				expected = expectedRead.value;
				learned = expectedRead.value;
			}
		}
		if (!decision) {
			const checksRead = await github.loadCommitChecks(release.sha);
			if (checksRead.kind === "failed") {
				decision = failed(checksRead);
			} else {
				checks = checksRead.value;
			}
		}
	}

	if (!decision) {
		const excludedRunIds = [
			release.runId,
			...releaseWorkflowRunIds(workflowRuns, connection.workflowPath),
		];
		const input: DeployGateInput = {
			mode: connection.gateMode,
			now: nowMs,
			startedAt: startedAt ? startedAt.getTime() : null,
			timeoutMs,
			expected,
			checks,
			workflows: connection.gateWorkflows,
			workflowRuns,
			excludedRunIds,
			trust: {
				branch: connection.trackedBranch,
				repository: connection.repoFullName,
			},
			appSlug,
			isExcluded:
				isExcluded ?? createDefaultExclusion({ appSlug, excludedRunIds }),
		};
		decision = evaluateDeployGate(input);
	}

	// A block the gate did not set (a refused release, say) is not the gate's to
	// replace or to lift.
	const foreignBlock =
		connection.state === "blocked" && !connection.gateBlocked;
	const recorded = await store.recordGateOutcome(
		connection.ghaConnectionId,
		release.releaseId,
		{
			gateState: GATE_STATE_OF[decision.state],
			gateReason: decision.state === "deploy" ? null : decision.reason,
			checkedAt: new Date(nowMs),
			previousCheckedAt: release.gateCheckedAt,
			...(learned ? { gateExpected: learned } : {}),
			gateStart:
				decision.state === "deploy"
					? "clear"
					: decision.state === "waiting" && !startedAt
						? "mark"
						: "keep",
			connection:
				decision.state === "blocked"
					? foreignBlock
						? "keep"
						: "block"
					: connection.gateBlocked
						? "unblock"
						: "keep",
			hasRelease: connection.deployedSha !== null,
		},
	);
	// The release changed under this evaluation (Deploy anyway, or another
	// evaluation): do not act on it, the next tick reads it again.
	if (!recorded) {
		return { state: "waiting", reason: "Checking again", pendingNames: [] };
	}
	return decision;
};
