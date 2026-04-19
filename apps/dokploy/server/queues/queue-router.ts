import type { DeploymentJob } from "./queue-types";

/**
 * Sentinel target key used when a job has no remote server configured — it
 * runs on the Dokploy host itself. Kept as a stable string so the queue
 * manager can keep one dedicated pool for it across the lifetime of the
 * process.
 */
export const LOCAL_TARGET = "local";

/**
 * Pick the deployment pool a job belongs to. Jobs sharing a target share a
 * concurrency pool; jobs on different targets never block each other.
 *
 * Rule:
 *   application / application-preview → buildServerId ?? serverId ?? "local"
 *   compose                           → serverId ?? "local"
 *
 * Pure: reads only the payload, no DB or I/O. Exported for unit tests.
 */
export function resolveTargetKey(job: DeploymentJob): string {
	switch (job.applicationType) {
		case "application":
		case "application-preview":
			return job.buildServerId ?? job.serverId ?? LOCAL_TARGET;
		case "compose":
			return job.serverId ?? LOCAL_TARGET;
	}
}

/**
 * Pick the per-service FIFO key. Two jobs with the same service key never run
 * concurrently even when their pool has headroom — this prevents a redeploy
 * of the same app from racing an in-flight deploy of that app.
 */
export function resolveServiceKey(job: DeploymentJob): string {
	switch (job.applicationType) {
		case "application":
			return `application:${job.applicationId}`;
		case "compose":
			return `compose:${job.composeId}`;
		case "application-preview":
			return `preview:${job.previewDeploymentId}`;
	}
}

/**
 * Does this job belong to the application identified by `applicationId`?
 * Matches both `application` and `application-preview` variants — the queue
 * summary in the UI lumps them together under the owning app.
 */
export function isJobForApplication(
	job: DeploymentJob,
	applicationId: string,
): boolean {
	return (
		(job.applicationType === "application" ||
			job.applicationType === "application-preview") &&
		job.applicationId === applicationId
	);
}

/** Does this job belong to the compose identified by `composeId`? */
export function isJobForCompose(
	job: DeploymentJob,
	composeId: string,
): boolean {
	return job.applicationType === "compose" && job.composeId === composeId;
}
