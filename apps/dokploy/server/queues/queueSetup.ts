import { IS_CLOUD } from "@dokploy/server";
import { findApplicationById } from "@dokploy/server/services/application";
import { findComposeById } from "@dokploy/server/services/compose";
import { findServerById } from "@dokploy/server/services/server";
import { killDockerBuild } from "./kill-docker-build";
import { DeploymentQueueManager } from "./queue-manager";
import {
	isJobForApplication,
	isJobForCompose,
	LOCAL_TARGET,
} from "./queue-router";
import type { DeploymentJob } from "./queue-types";

/**
 * Single process-wide facade over the deployment queue. Public surface is
 * backward-compatible with the BullMQ era:
 *   - `myQueue.add("deployments", jobData, opts?)` — enqueue (opts ignored).
 *   - `getJobsByApplicationId`, `getJobsByComposeId` — read jobs for UI.
 *   - `cleanAllDeploymentQueue`, `cleanQueuesByApplication`,
 *     `cleanQueuesByCompose` — cancel paths.
 *   - `killDockerBuild` — the SIGINT escape hatch (re-exported).
 *
 * Implementation: a `DeploymentQueueManager` that keeps one in-memory grouped
 * queue per deployment target (local + each remote server). Redis is not
 * required for deployments.
 */

const DEFAULT_CONCURRENCY = Number.parseInt(
	process.env.DEPLOYMENT_QUEUE_CONCURRENCY ?? "1",
	10,
);

const concurrencyProvider = async (
	targetKey: string,
): Promise<number | undefined> => {
	if (targetKey === LOCAL_TARGET) return undefined;
	try {
		const server = await findServerById(targetKey);
		return server.deploymentConcurrency ?? undefined;
	} catch {
		return undefined;
	}
};

const noopProvider = () => undefined;

export const deploymentQueueManager = new DeploymentQueueManager({
	defaultConcurrency: Number.isFinite(DEFAULT_CONCURRENCY)
		? Math.max(1, DEFAULT_CONCURRENCY)
		: 1,
	concurrencyProvider: IS_CLOUD ? noopProvider : concurrencyProvider,
});

/**
 * Populate `serverId` + `buildServerId` on a job from the underlying entity.
 * Existing enqueue call sites set only a `server: boolean` flag and leave the
 * ids off the payload; the router needs them to pick the right target pool,
 * so we enrich here — one DB hit per enqueue, trivial vs. the build itself.
 *
 * Failure mode is strict: if the entity can't be loaded we throw, because a
 * silent fallback to the local pool could run a build targeted at remote
 * server X on the Dokploy host — a security/isolation violation. Callers
 * (webhooks, tRPC) will surface this to the user as a failed enqueue.
 */
async function enrichJob(job: DeploymentJob): Promise<DeploymentJob> {
	if (
		job.applicationType === "application" ||
		job.applicationType === "application-preview"
	) {
		if (job.buildServerId && job.serverId) return job;
		const app = await findApplicationById(job.applicationId);
		return {
			...job,
			serverId: job.serverId ?? app.serverId ?? undefined,
			buildServerId: job.buildServerId ?? app.buildServerId ?? undefined,
		};
	}
	if (job.serverId) return job;
	const compose = await findComposeById(job.composeId);
	return {
		...job,
		serverId: job.serverId ?? compose.serverId ?? undefined,
	};
}

type LegacyAddReturn = { id: string; remove: () => Promise<void> };

/**
 * Backward-compatible view of a queued job. Exists only to feed the legacy
 * BullMQ-shaped consumer in `server/api/routers/deployment.ts`, which awaits
 * `job.getState()`, and various `.timestamp`, `.data` accessors. Fields we
 * don't track in-memory (`processedOn`, `finishedOn`, `failedReason`) are
 * left undefined — the UI handles undefined gracefully.
 */
export interface LegacyQueueJob {
	id: string;
	name: string;
	data: DeploymentJob;
	timestamp?: number;
	processedOn?: number;
	finishedOn?: number;
	failedReason?: string;
	getState: () => Promise<string>;
}

const toLegacyJob = (snapshot: {
	jobId: string;
	data: DeploymentJob;
	enqueuedAt: number;
	startedAt?: number;
	state: "active" | "pending";
}): LegacyQueueJob => ({
	id: snapshot.jobId,
	name: "deployments",
	data: snapshot.data,
	timestamp: snapshot.enqueuedAt,
	processedOn: snapshot.startedAt,
	getState: async () => (snapshot.state === "active" ? "active" : "waiting"),
});

/**
 * Backward-compatible wrapper around the queue manager. The first positional
 * parameter (`name`) and third (`opts`) exist only to match the old BullMQ
 * signature still used throughout the app; in the in-memory implementation
 * neither carries semantics.
 */
export const myQueue = {
	async add(
		_name: string,
		data: DeploymentJob,
		_opts?: unknown,
	): Promise<LegacyAddReturn> {
		if (IS_CLOUD) {
			return { id: "cloud-noop", remove: async () => {} };
		}
		const enriched = await enrichJob(data);
		const job = await deploymentQueueManager.add(enriched);
		// Avoid unhandled rejection on the done promise — the handler logs
		// errors, and the UI surfaces status via the deployments table.
		job.done.catch(() => {});
		return {
			id: job.jobId,
			remove: async () => {
				deploymentQueueManager.cancelJob(job.jobId, "User removed queued job");
			},
		};
	},

	async getJobs(): Promise<LegacyQueueJob[]> {
		return deploymentQueueManager.listSnapshots().map(toLegacyJob);
	},
};

export const getJobsByApplicationId = async (
	applicationId: string,
): Promise<LegacyQueueJob[]> => {
	return deploymentQueueManager
		.listSnapshots()
		.filter((snapshot) => isJobForApplication(snapshot.data, applicationId))
		.map(toLegacyJob);
};

export const getJobsByComposeId = async (
	composeId: string,
): Promise<LegacyQueueJob[]> => {
	return deploymentQueueManager
		.listSnapshots()
		.filter((snapshot) => isJobForCompose(snapshot.data, composeId))
		.map(toLegacyJob);
};

export const cleanAllDeploymentQueue = async (): Promise<boolean> => {
	deploymentQueueManager.cancelAllJobs("User requested cancellation");
	return true;
};

export const cleanQueuesByApplication = async (
	applicationId: string,
): Promise<void> => {
	const removed = deploymentQueueManager.cancelWhere(
		(job) => isJobForApplication(job, applicationId),
		"User requested cancellation",
	);
	if (removed > 0) {
		console.log(
			`Cancelled ${removed} deployment job(s) for application ${applicationId}`,
		);
	}
};

export const cleanQueuesByCompose = async (
	composeId: string,
): Promise<void> => {
	const removed = deploymentQueueManager.cancelWhere(
		(job) => isJobForCompose(job, composeId),
		"User requested cancellation",
	);
	if (removed > 0) {
		console.log(
			`Cancelled ${removed} deployment job(s) for compose ${composeId}`,
		);
	}
};

export { killDockerBuild };
