import type { ConnectionRecord, PendingRelease } from "./poll";
import type { GhaConnectionRow, GhaReleaseRow } from "./store";

/**
 * What one poll reads about a connection, built field by field from its row.
 * The deploy gate's inputs (the state, `gateBlocked`, `gateVersion`,
 * `repoFullName`, `gateStartedAt`, the settings) come from the SAME read as the
 * facts acceptance needs: an evaluation that read an older `gateVersion` is
 * discarded when it is written (recordGateOutcome), so the poll must carry the
 * version it actually read. Pure.
 */
export const buildConnectionRecord = (
	row: GhaConnectionRow,
	watch: { owner: string; repo: string },
	currentRepositories: string[],
): ConnectionRecord => ({
	connectionId: row.ghaConnectionId,
	organizationId: row.organizationId,
	createdAt: row.createdAt.getTime(),
	processed: row.processed,
	gate: {
		ghaConnectionId: row.ghaConnectionId,
		state: row.state,
		gateBlocked: row.gateBlocked,
		repoFullName: row.repoFullName,
		repoId: row.repoId,
		gateVersion: row.gateVersion,
		trackedBranch: row.trackedBranch,
		workflowPath: row.workflowPath,
		gateMode: row.gateMode,
		gateWorkflows: row.gateWorkflows,
		gateTimeoutMinutes: row.gateTimeoutMinutes,
		gateStartedAt: row.gateStartedAt,
		deployedSha: row.deployedSha,
	},
	facts: {
		repoId: row.repoId,
		workflowPath: row.workflowPath,
		trackedBranch: row.trackedBranch,
		environment: row.environment,
		serviceKey: row.serviceKey,
		owner: watch.owner,
		repo: watch.repo,
		protectionMode: row.protectionMode,
		registryPrefix: row.registryPrefix,
		registryProbeHost: row.registryProbeHost,
		deployed:
			row.deployedSha &&
			row.deployedRunId !== null &&
			row.deployedRunAttempt !== null
				? {
						sha: row.deployedSha,
						runId: row.deployedRunId,
						attempt: row.deployedRunAttempt,
						digests: [...(row.deployedDigests ?? [])].sort(),
					}
				: null,
		currentRepositories,
	},
});

/** An accepted release as the gate reads it: `gateCheckedAt` is the value the gate's write compares against. */
export const toPendingRelease = (row: GhaReleaseRow): PendingRelease => ({
	releaseId: row.releaseId,
	manifestReleaseId: row.manifestReleaseId,
	sha: row.sha,
	runId: row.runId,
	runAttempt: row.runAttempt,
	delivery: row.delivery,
	githubDeploymentId: row.githubDeploymentId,
	images: row.images,
	createdAt: row.createdAt,
	gateState: row.gateState,
	gateExpected: row.gateExpected,
	gateCheckedAt: row.gateCheckedAt,
});
