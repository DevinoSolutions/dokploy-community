import { describeRegistryRetry, MAX_REGISTRY_RETRIES } from "./registry-retry";
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
	gateWorkflows?: string[];
	gateTimeoutMinutes?: number;
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
	gateWorkflows: row.gateWorkflows ?? [],
	gateTimeoutMinutes: row.gateTimeoutMinutes ?? 60,
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

export interface PresentableRelease {
	status: string;
	delivery: string;
	retryAt: Date | null;
	retryAttempt: number;
}

/**
 * A pull release that waits for the registry (T-15783) is stored as accepted
 * with `retryAt` set; the API calls it `retrying`.
 */
export const presentReleaseStatus = (release: PresentableRelease): string =>
	release.status === "accepted" && release.retryAt
		? "retrying"
		: release.status;

export interface PresentedRetry {
	attempt: number;
	max: number;
	retryAt: Date;
	/** The sentence the service shows instead of the state's own. */
	statusText: string;
}

/** The release that waits for its retry, newest first as the list is read; null when none does. */
export const presentRetry = (
	releases: PresentableRelease[],
	now: Date = new Date(),
): PresentedRetry | null => {
	const waiting = releases.find(
		(release) =>
			release.delivery === "pull" &&
			release.status === "accepted" &&
			Boolean(release.retryAt),
	);
	if (!waiting?.retryAt) return null;
	return {
		attempt: waiting.retryAttempt,
		max: MAX_REGISTRY_RETRIES,
		retryAt: waiting.retryAt,
		statusText: describeRegistryRetry(
			{ attempt: waiting.retryAttempt, retryAt: waiting.retryAt },
			now,
		),
	};
};
