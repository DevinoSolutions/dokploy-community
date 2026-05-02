import {
	deployApplication,
	deployCompose,
	deployPreviewApplication,
	IS_CLOUD,
	rebuildApplication,
	rebuildCompose,
	rebuildPreviewApplication,
	updateApplicationStatus,
	updateCompose,
	updatePreviewDeployment,
} from "@dokploy/server";
import { type Job, Worker } from "bullmq";
import {
	CANCEL_CHANNEL,
	getQueueName,
	getTargetKey,
	LOCAL_TARGET,
} from "./queue-routing";
import type { DeploymentJob } from "./queue-types";
import { redisConfig } from "./redis-connection";

export { CANCEL_CHANNEL, getQueueName, getTargetKey, LOCAL_TARGET };

const MAX_CONCURRENCY = 32;
const DEFAULT_CONCURRENCY = 1;

const clampConcurrency = (n: number): number =>
	Math.max(1, Math.min(Math.floor(n) || DEFAULT_CONCURRENCY, MAX_CONCURRENCY));

const workers = new Map<string, Worker<DeploymentJob>>();
const inflight = new Map<string, AbortController>();
let cancelSubscriber: { quit: () => Promise<unknown> } | null = null;
let started = false;

const handleJob = async (
	job: Job<DeploymentJob>,
	signal: AbortSignal,
): Promise<void> => {
	const data = job.data;
	if (data.applicationType === "application") {
		await updateApplicationStatus(data.applicationId, "running");
		if (data.type === "redeploy") {
			await rebuildApplication({
				applicationId: data.applicationId,
				titleLog: data.titleLog,
				descriptionLog: data.descriptionLog,
			});
		} else if (data.type === "deploy") {
			await deployApplication({
				applicationId: data.applicationId,
				titleLog: data.titleLog,
				descriptionLog: data.descriptionLog,
			});
		}
	} else if (data.applicationType === "compose") {
		await updateCompose(data.composeId, { composeStatus: "running" });
		if (data.type === "deploy") {
			await deployCompose({
				composeId: data.composeId,
				titleLog: data.titleLog,
				descriptionLog: data.descriptionLog,
			});
		} else if (data.type === "redeploy") {
			await rebuildCompose({
				composeId: data.composeId,
				titleLog: data.titleLog,
				descriptionLog: data.descriptionLog,
			});
		}
	} else if (data.applicationType === "application-preview") {
		await updatePreviewDeployment(data.previewDeploymentId, {
			previewStatus: "running",
		});
		if (data.type === "redeploy") {
			await rebuildPreviewApplication({
				applicationId: data.applicationId,
				titleLog: data.titleLog,
				descriptionLog: data.descriptionLog,
				previewDeploymentId: data.previewDeploymentId,
			});
		} else if (data.type === "deploy") {
			await deployPreviewApplication({
				applicationId: data.applicationId,
				titleLog: data.titleLog,
				descriptionLog: data.descriptionLog,
				previewDeploymentId: data.previewDeploymentId,
			});
		}
	}
	if (signal.aborted) {
		throw new Error("Deployment aborted by user");
	}
};

const createWorker = (
	targetKey: string,
	concurrency: number,
): Worker<DeploymentJob> => {
	const worker = new Worker<DeploymentJob>(
		getQueueName(targetKey),
		async (job) => {
			const ac = new AbortController();
			const key = job.id ?? `${job.queueQualifiedName}:${job.timestamp}`;
			inflight.set(key, ac);
			try {
				await handleJob(job, ac.signal);
			} finally {
				inflight.delete(key);
			}
		},
		{
			autorun: false,
			concurrency: clampConcurrency(concurrency),
			connection: redisConfig,
		},
	);
	worker.on("error", (err) => {
		if ((err as { code?: string })?.code === "ECONNREFUSED") {
			console.error(
				"Make sure you have installed Redis and it is running.",
				err,
			);
		}
	});
	workers.set(targetKey, worker);
	return worker;
};

/**
 * BullMQ's `Worker.run()` only resolves when the worker is closed (it awaits
 * the internal main loop). We can't `await` it during boot or every subsequent
 * step (bootstrap, shutdown handlers) hangs forever. Fire-and-forget here.
 */
const startIfStopped = (w: Worker<DeploymentJob>): void => {
	const running = (w as { isRunning?: () => boolean }).isRunning?.();
	if (running) return;
	void w.run().catch((err) => {
		console.error("[deployments] worker.run() error", err);
	});
};

const ensureWorker = (
	targetKey: string,
	concurrency: number = DEFAULT_CONCURRENCY,
): Worker<DeploymentJob> => {
	const existing = workers.get(targetKey);
	if (existing) return existing;
	const worker = createWorker(targetKey, concurrency);
	if (started) startIfStopped(worker);
	return worker;
};

const startCancelSubscriber = async (): Promise<void> => {
	if (cancelSubscriber) return;
	const seedWorker = workers.get(LOCAL_TARGET) ?? createWorker(LOCAL_TARGET, 1);
	const client = await seedWorker.client;
	const sub = (client as unknown as { duplicate: () => unknown }).duplicate() as {
		subscribe: (channel: string) => Promise<unknown>;
		on: (event: "message", cb: (channel: string, payload: string) => void) => void;
		quit: () => Promise<unknown>;
	};
	await sub.subscribe(CANCEL_CHANNEL);
	sub.on("message", (_chan, payload) => {
		try {
			const { jobId } = JSON.parse(payload) as { jobId: string };
			const ac = inflight.get(jobId);
			if (ac) ac.abort();
		} catch (err) {
			console.error("Cancel subscriber: bad payload", err);
		}
	});
	cancelSubscriber = sub;
};

const realDeploymentWorker = {
	run: async (): Promise<void> => {
		started = true;
		ensureWorker(LOCAL_TARGET);
		for (const w of workers.values()) startIfStopped(w);
		void startCancelSubscriber().catch((err) => {
			console.error("[deployments] cancel subscriber failed to start", err);
		});
	},
	close: async (_reason?: string): Promise<void> => {
		started = false;
		for (const ac of inflight.values()) ac.abort();
		await Promise.all(Array.from(workers.values()).map((w) => w.close()));
		workers.clear();
		if (cancelSubscriber) {
			await cancelSubscriber.quit().catch(() => {});
			cancelSubscriber = null;
		}
	},
	cancelJob: async (jobId: string, _reason?: string): Promise<void> => {
		const ac = inflight.get(jobId);
		if (ac) ac.abort();
	},
	cancelAllJobs: async (_reason?: string): Promise<void> => {
		for (const ac of inflight.values()) ac.abort();
	},
	setConcurrency: (targetKey: string, concurrency: number): void => {
		const safe = clampConcurrency(concurrency);
		const worker = ensureWorker(targetKey, safe);
		worker.concurrency = safe;
	},
	ensureWorker: (
		targetKey: string,
		concurrency: number = DEFAULT_CONCURRENCY,
	): void => {
		ensureWorker(targetKey, concurrency);
	},
	hasInflight: (jobId: string): boolean => inflight.has(jobId),
};

const noopDeploymentWorker = {
	run: () => Promise.resolve(),
	close: (_reason?: string) => Promise.resolve(),
	cancelJob: (_jobId: string, _reason?: string) => Promise.resolve(),
	cancelAllJobs: (_reason?: string) => Promise.resolve(),
	setConcurrency: (_targetKey: string, _concurrency: number) => {},
	ensureWorker: (_targetKey: string, _concurrency?: number) => {},
	hasInflight: (_jobId: string) => false,
};

export const deploymentWorker = !IS_CLOUD
	? realDeploymentWorker
	: noopDeploymentWorker;
