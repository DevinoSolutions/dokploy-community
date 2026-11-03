import { describeState } from "./state-machine";

/**
 * What the API and the MCP tools return for a connection. Built field by
 * field: the stored row carries the previous source settings and the list of
 * handled runs, which are not for callers.
 */

export interface PresentableConnection {
	ghaConnectionId: string;
	serviceType: string;
	serviceId: string;
	githubConnectionId: string;
	repoId: number;
	repoFullName: string;
	workflowPath: string;
	trackedBranch: string;
	environment: string;
	serviceKey: string;
	protectionMode: string;
	registryPrefix: string | null;
	registryId: string | null;
	gateMode: string;
	state: string;
	stateDetail: string | null;
	stateSince: Date;
	expectedSha: string | null;
	deployedSha: string | null;
	deployedRunId: number | null;
	deployedAt: Date | null;
	previousSource: unknown;
	lastActivityAt: Date | null;
	lastError: string | null;
	createdAt: Date;
}

export const presentGhaConnection = (
	row: PresentableConnection,
	now: Date = new Date(),
) => ({
	ghaConnectionId: row.ghaConnectionId,
	serviceType: row.serviceType,
	serviceId: row.serviceId,
	githubConnectionId: row.githubConnectionId,
	repository: row.repoFullName,
	repoId: row.repoId,
	workflowPath: row.workflowPath,
	trackedBranch: row.trackedBranch,
	environment: row.environment,
	serviceKey: row.serviceKey,
	protectionMode: row.protectionMode,
	registryPrefix: row.registryPrefix,
	registryId: row.registryId,
	gateMode: row.gateMode,
	state: row.state,
	stateSince: row.stateSince,
	/** The sentence the service shows, from the design's state table. */
	statusText: describeState(
		{
			state: row.state as Parameters<typeof describeState>[0]["state"],
			detail: row.stateDetail,
		},
		{
			expectedSha: row.expectedSha,
			deployedSha: row.deployedSha,
			lastReleaseAt: row.deployedAt,
			lastReleaseSha: row.deployedSha,
			now,
		},
	),
	deployedSha: row.deployedSha,
	deployedRunId: row.deployedRunId,
	deployedAt: row.deployedAt,
	hasPreviousSource:
		row.previousSource !== null && row.previousSource !== undefined,
	lastActivityAt: row.lastActivityAt,
	lastError: row.lastError,
	createdAt: row.createdAt,
});

export type PresentedGhaConnection = ReturnType<typeof presentGhaConnection>;
