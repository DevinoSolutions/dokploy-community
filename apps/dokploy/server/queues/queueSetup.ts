import { IS_CLOUD } from "@dokploy/server";
import { findApplicationById } from "@dokploy/server/services/application";
import { findComposeById } from "@dokploy/server/services/compose";
import { findServerById } from "@dokploy/server/services/server";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import { killDockerBuild } from "./kill-docker-build";
import { DeploymentQueueManager } from "./queue-manager";
import {
	isJobForApplication,
	isJobForCompose,
	LOCAL_TARGET,
} from "./queue-router";
import type { DeploymentJob } from "./queue-types";

const DEFAULT_CONCURRENCY = Number.parseInt(
	process.env.DEPLOYMENT_QUEUE_CONCURRENCY ?? "1",
	10,
);

const concurrencyProvider = async (
	targetKey: string,
): Promise<number | undefined> => {
	if (targetKey === LOCAL_TARGET) {
		try {
			const settings = await getWebServerSettings();
			return settings?.deploymentConcurrency ?? undefined;
		} catch {
			return undefined;
		}
	}
	try {
		const server = await findServerById(targetKey);
		return server.deploymentConcurrency ?? undefined;
	} catch {
		return undefined;
	}
};

const noopProvider = () => undefined;

// Two bundles (server + Next.js) share this module; Symbol.for pins a single instance across both.
const SINGLETON_KEY = Symbol.for("dokploy.deploymentQueueManager");
type WithSingleton = {
	[SINGLETON_KEY]?: DeploymentQueueManager;
};
const globalRef = globalThis as WithSingleton;

function resolveSingleton(): DeploymentQueueManager {
	const existing = globalRef[SINGLETON_KEY];
	if (existing) return existing;
	const created = new DeploymentQueueManager({
		defaultConcurrency: Number.isFinite(DEFAULT_CONCURRENCY)
			? Math.max(1, DEFAULT_CONCURRENCY)
			: 1,
		concurrencyProvider: IS_CLOUD ? noopProvider : concurrencyProvider,
	});
	globalRef[SINGLETON_KEY] = created;
	return created;
}

export const deploymentQueueManager = resolveSingleton();

// Routing requires real serverIds; missing entity must fail loudly to avoid running a remote-targeted build on the local host.
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

// BullMQ-shaped view; consumer in deployment router relies on getState/timestamp.
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

// `_name` and `_opts` are unused; kept to match the old BullMQ call sites.
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
