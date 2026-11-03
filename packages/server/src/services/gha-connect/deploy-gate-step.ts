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
}

export interface GateOutcome {
	gateState: GhaGateState;
	gateReason: string | null;
	checkedAt: Date;
	/** Saved with the release the first time the expected set is learned. */
	gateExpected?: ExpectedCheckSet;
}

/** What the step writes. The database implementation is in deploy-gate-store.ts. */
export interface DeployGateStore {
	markGateStarted(ghaConnectionId: string, at: Date): Promise<void>;
	clearGateStart(ghaConnectionId: string): Promise<void>;
	recordGateOutcome(releaseId: string, outcome: GateOutcome): Promise<void>;
	blockConnection(ghaConnectionId: string, reason: string): Promise<void>;
	unblockConnection(
		ghaConnectionId: string,
		hasRelease: boolean,
	): Promise<void>;
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

const failureDecision = (
	failure: ApiFailure,
	timedOut: boolean,
	minutes: number,
): GateDecision => {
	if (failure.kind === "unauthorized" || failure.kind === "forbidden") {
		return {
			state: "blocked",
			reason: "GitHub did not let Dokploy read the checks. Reconnect GitHub.",
			failedNames: [],
			neverReported: [],
			unfinished: [],
		};
	}
	if (timedOut) {
		return {
			state: "blocked",
			reason: `GitHub could not be read for ${minutes} minutes`,
			failedNames: [],
			neverReported: [],
			unfinished: [],
		};
	}
	return {
		state: "waiting",
		reason: "GitHub could not be read, trying again",
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

	let expected: ExpectedCheckSet | null = release.gateExpected;
	let learned: ExpectedCheckSet | undefined;
	let decision: GateDecision | null = null;
	let checks: GateCheck[] = [];
	let workflowRuns: GateWorkflowRun[] = [];

	const runsRead: GateRead<GateWorkflowRun[]> = await github.loadWorkflowRuns(
		release.sha,
	);
	if (runsRead.kind === "failed") {
		decision = failureDecision(
			runsRead.failure,
			timedOut,
			connection.gateTimeoutMinutes,
		);
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
				decision = failureDecision(
					expectedRead.failure,
					timedOut,
					connection.gateTimeoutMinutes,
				);
			} else {
				expected = expectedRead.value;
				learned = expectedRead.value;
			}
		}
		if (!decision) {
			const checksRead = await github.loadCommitChecks(release.sha);
			if (checksRead.kind === "failed") {
				decision = failureDecision(
					checksRead.failure,
					timedOut,
					connection.gateTimeoutMinutes,
				);
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
			appSlug,
			isExcluded:
				isExcluded ?? createDefaultExclusion({ appSlug, excludedRunIds }),
		};
		decision = evaluateDeployGate(input);
	}

	if (decision.state === "waiting" && !startedAt) {
		await store.markGateStarted(connection.ghaConnectionId, new Date(nowMs));
	}
	if (decision.state === "deploy") {
		await store.clearGateStart(connection.ghaConnectionId);
	}
	await store.recordGateOutcome(release.releaseId, {
		gateState: GATE_STATE_OF[decision.state],
		gateReason: decision.state === "deploy" ? null : decision.reason,
		checkedAt: new Date(nowMs),
		...(learned ? { gateExpected: learned } : {}),
	});
	// Blocked shows on the connection; a pass that follows a block lifts it again.
	if (decision.state === "blocked" && connection.state !== "blocked") {
		await store.blockConnection(connection.ghaConnectionId, decision.reason);
	}
	if (
		decision.state === "deploy" &&
		release.gateState === "blocked" &&
		connection.state === "blocked"
	) {
		await store.unblockConnection(
			connection.ghaConnectionId,
			connection.deployedSha !== null,
		);
	}
	return decision;
};
