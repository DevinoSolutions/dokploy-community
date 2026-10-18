import {
	IS_CLOUD,
	updateApplicationStatus,
	updateCompose,
	updatePreviewDeployment,
} from "@dokploy/server";
import { isCoalescableDeployJob } from "@dokploy/server/services/build-policy/coalesce";
import { isCoalescingEnforcedForUnit } from "@dokploy/server/services/build-policy/webhook";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { resolveBuildsConcurrency } from "./concurrency";
import { processDeploymentJob } from "./deployments-queue";
import {
	type CoalesceWaitingOutcome,
	type InMemoryJob,
	InMemoryQueue,
	type KeepOldestOutcome,
	type KeptWaitingJob,
	type PriorityOutcome,
} from "./in-memory-queue";
import { gateWorkerUntilRestored, registerShutdownHandler } from "./lifecycle";
import {
	createQueueJournal,
	dbJournalStore,
	type RestoreResult,
} from "./queue-journal";
import type { DeploymentJob } from "./queue-types";

/**
 * Deployment queue.
 *
 * Self-hosted uses an in-memory, per-group FIFO queue with configurable
 * concurrency per server. Cloud does not use the queue at all — deployments
 * run directly in the background — so we expose a no-op.
 *
 * The in-memory queue is the executor; every job is also journaled in Postgres
 * (table `deployment_queue_job`, see queue-journal.ts) so a restart of the
 * Dokploy service re-enqueues what was waiting or running instead of silently
 * dropping it. Remote-server jobs (`serverId`) share the same queue and journal.
 */

/**
 * Public result of a keep-oldest pass. `kept` holds the surviving job of each
 * job type (an array, because `deploy` and `redeploy` are kept independently);
 * it is empty when nothing of the service was waiting.
 */
export interface KeepOldestResult {
	kept: KeptWaitingJob[];
	removed: KeptWaitingJob[];
}

interface DeploymentQueue {
	add: (
		name: string,
		data: DeploymentJob,
		opts?: Record<string, unknown>,
	) => Promise<{ id: string; priority?: PriorityOutcome }>;
	/** Flag a waiting job for priority; null when it is not waiting. */
	prioritize: (id: string, by?: string) => PriorityOutcome | null;
	getJobs: (states?: Array<"waiting" | "active">) => Promise<InMemoryJob[]>;
	close: () => Promise<void>;
	on: (...args: unknown[]) => void;
	run: () => Promise<void>;
	removeWaiting: (predicate: (data: DeploymentJob) => boolean) => number;
	keepOldestWaiting: (
		predicate: (data: DeploymentJob) => boolean,
	) => KeepOldestOutcome;
	coalesceWaiting: (
		incoming: DeploymentJob,
		predicate: (data: DeploymentJob) => boolean,
	) => CoalesceWaitingOutcome;
	clearWaiting: () => number;
	/** Re-enqueue the jobs the previous process left unfinished. Never throws. */
	restore: () => Promise<RestoreResult>;
	/** Stop taking jobs, give running ones `graceMs` to finish, flush the journal. */
	shutdown: (graceMs: number, flushMs: number) => Promise<void>;
}

const createNoopQueue = (): DeploymentQueue => ({
	add: () => Promise.resolve({ id: "noop" }),
	prioritize: () => null,
	getJobs: () => Promise.resolve([]),
	close: () => Promise.resolve(),
	on: () => {},
	run: () => Promise.resolve(),
	removeWaiting: () => 0,
	keepOldestWaiting: () => ({ kept: [], removed: [] }),
	coalesceWaiting: () => ({ merged: null, removed: [], titles: [] }),
	clearWaiting: () => 0,
	restore: () => Promise.resolve({ restored: 0, interrupted: 0, dropped: 0 }),
	shutdown: () => Promise.resolve(),
});

const idOf = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

/**
 * A dropped job must not leave its service showing "running". Works from
 * whatever ids the payload carries, so a job dropped for an unreadable payload
 * is still handled.
 */
const failDroppedJob = async (payload: Record<string, unknown>) => {
	const previewDeploymentId = idOf(payload.previewDeploymentId);
	const composeId = idOf(payload.composeId);
	const applicationId = idOf(payload.applicationId);
	if (previewDeploymentId) {
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "error",
		});
	} else if (payload.applicationType === "compose" && composeId) {
		await updateCompose(composeId, { composeStatus: "error" });
	} else if (applicationId) {
		await updateApplicationStatus(applicationId, "error");
	}
};

const createInMemoryQueue = (): DeploymentQueue => {
	const durable = createQueueJournal(dbJournalStore, {
		onDropped: failDroppedJob,
	});
	const queue = new InMemoryQueue({
		resolveConcurrency: resolveBuildsConcurrency,
		journal: durable.journal,
	});
	// Held until the boot replay is done (or 30s pass), so a webhook arriving
	// first cannot start ahead of the same job restored from the journal.
	const gate = gateWorkerUntilRestored(queue);
	queue.process(processDeploymentJob);

	let shuttingDown: Promise<void> | null = null;

	return {
		add: (_name, data) => queue.add(data),
		prioritize: (id, by) => queue.prioritize(id, by),
		getJobs: (states) => queue.getJobs(states),
		close: () => queue.close(),
		on: () => {},
		run: () => queue.run(),
		removeWaiting: (predicate) => queue.removeWaiting(predicate),
		keepOldestWaiting: (predicate) => queue.keepOldestWaiting(predicate),
		coalesceWaiting: (incoming, predicate) =>
			queue.coalesceWaiting(incoming, predicate),
		clearWaiting: () => queue.clearWaiting(),
		restore: async () => {
			try {
				const result = await durable.restore(queue);
				// Before the gate opens, so the worker starts on the deduped queue.
				// If the gate's timer already fired this is still safe: the pass is
				// synchronous per unit and only ever removes waiting jobs.
				if (result.restored > 0) await dedupeRestoredUnits(queue);
				return result;
			} finally {
				gate.open();
			}
		},
		shutdown: (graceMs, flushMs) => {
			shuttingDown ??= (async () => {
				// Nothing new starts; anything still running when the grace period
				// ends stays in the journal as `active` and is re-run on the next boot.
				await queue.close();
				await queue.waitForIdle(graceMs);
				await durable.flush(flushMs);
			})();
			return shuttingDown;
		},
	};
};

// Use a global singleton so the deployment queue is shared across every module
// instance. In dev (tsx/Next) the same file can be evaluated more than once
// (relative import in server.ts vs `@/` alias in the routers); without this the
// worker and the `add()` calls would land on different queue instances.
const globalForQueue = globalThis as unknown as {
	__dokployDeploymentQueue?: DeploymentQueue;
};

if (!globalForQueue.__dokployDeploymentQueue) {
	if (IS_CLOUD) {
		globalForQueue.__dokployDeploymentQueue = createNoopQueue();
	} else {
		const queue = createInMemoryQueue();
		globalForQueue.__dokployDeploymentQueue = queue;
		// Inside the singleton guard so a second evaluation of this module
		// cannot register a second SIGTERM handler.
		registerShutdownHandler(queue);
	}
}

const myQueue: DeploymentQueue = globalForQueue.__dokployDeploymentQueue;

/** Start processing jobs. Called once on server startup (self-hosted). */
export const startDeploymentWorker = () => myQueue.run();

/**
 * Re-enqueue the jobs the previous process left unfinished (self-hosted).
 * Called once on startup after the worker is running; safe to call again.
 */
export const restoreQueuedDeployments = () => myQueue.restore();

export const getJobsByApplicationId = async (applicationId: string) => {
	const jobs = await myQueue.getJobs();
	return jobs.filter(
		(job) => (job.data as any)?.applicationId === applicationId,
	);
};

export const getJobsByComposeId = async (composeId: string) => {
	const jobs = await myQueue.getJobs();
	return jobs.filter((job) => (job.data as any)?.composeId === composeId);
};

// build-policy hook: these two now return how many waiting jobs they dropped,
// so the enqueue-time coalescing gate can audit it. Existing callers ignore the
// returned value. See packages/server/src/services/build-policy/README.md.
export const cleanQueuesByApplication = async (applicationId: string) => {
	const removed = myQueue.removeWaiting(
		(data) => (data as any)?.applicationId === applicationId,
	);
	if (removed > 0) {
		console.log(
			`Removed ${removed} waiting job(s) for application ${applicationId}`,
		);
	}
	return removed;
};

export const cleanQueuesByCompose = async (composeId: string) => {
	const removed = myQueue.removeWaiting(
		(data) => (data as any)?.composeId === composeId,
	);
	if (removed > 0) {
		console.log(`Removed ${removed} waiting job(s) for compose ${composeId}`);
	}
	return removed;
};

/**
 * "keepOldest" mode of the clean-queues actions: of each group of duplicate
 * waiting jobs of the service (same type, freshVolumes, pinnedImage and
 * priority), keep the one earliest in the queue and drop the later ones. Active
 * jobs and other services are untouched, and the kept job keeps its place.
 * Only the unit's own plain deploy/redeploy jobs count, like coalescing: a
 * queued PR preview is not a duplicate of the service's deploy.
 */
const keepOldestForUnit = (
	queue: Pick<DeploymentQueue, "keepOldestWaiting">,
	unitType: "application" | "compose",
	unitId: string,
): KeepOldestResult => {
	const { kept, removed } = queue.keepOldestWaiting((data) =>
		isCoalescableDeployJob(unitType, unitId, data),
	);
	if (removed.length > 0) {
		console.log(
			`Removed ${removed.length} newer waiting job(s) for ${unitType} ${unitId}, kept ${kept.length}`,
		);
	}
	return { kept, removed };
};

/**
 * A push that lands before the boot replay finishes is enqueued normally, and
 * then the restored copy of the same deploy goes in front of it, leaving two
 * equivalent waiting jobs until the next push. Run once after a replay that
 * restored something: for every unit with two or more waiting jobs whose
 * organization coalesces pushes (the same condition as the enqueue-time gate),
 * keep the oldest of each group of duplicates, which is the restored one. This
 * is keep-oldest, so it keeps the older job's payload, unlike push coalescing.
 * Units of an organization that does not coalesce are left alone, and so are
 * running jobs. Best-effort per unit: a failing lookup skips only that unit.
 */
const dedupeRestoredUnits = async (
	queue: Pick<DeploymentQueue, "getJobs" | "keepOldestWaiting">,
) => {
	const units = new Map<
		string,
		{ unitType: "application" | "compose"; unitId: string; waiting: number }
	>();
	try {
		for (const { data } of await queue.getJobs(["waiting"])) {
			const unit =
				data.applicationType === "application"
					? { unitType: "application" as const, unitId: data.applicationId }
					: data.applicationType === "compose"
						? { unitType: "compose" as const, unitId: data.composeId }
						: null;
			if (!unit) continue;
			const key = `${unit.unitType}:${unit.unitId}`;
			const seen = units.get(key);
			if (seen) seen.waiting++;
			else units.set(key, { ...unit, waiting: 1 });
		}
	} catch (error) {
		console.error("Deployment queue: post-restore dedupe failed", error);
		return;
	}
	for (const { unitType, unitId, waiting } of units.values()) {
		// A lone job has nothing to be a duplicate of; skip the lookup.
		if (waiting < 2) continue;
		try {
			if (!(await isCoalescingEnforcedForUnit(unitType, unitId))) continue;
			keepOldestForUnit(queue, unitType, unitId);
		} catch (error) {
			console.error(
				`Deployment queue: post-restore dedupe failed for ${unitType} ${unitId}`,
				error,
			);
		}
	}
};

export const keepOldestQueuesByApplication = async (applicationId: string) =>
	keepOldestForUnit(myQueue, "application", applicationId);

export const keepOldestQueuesByCompose = async (composeId: string) =>
	keepOldestForUnit(myQueue, "compose", composeId);

/**
 * build-policy hook: coalescing siblings of the two helpers above.
 *
 * The originals back explicit "clean queues" actions, where dropping every
 * waiting job for a unit — previews included — is the intent. Coalescing runs
 * automatically on every push, so it must touch ONLY the unit's own plain
 * deploys: a queued PR preview for the same application is a different job that
 * nobody asked to cancel, and a waiting manual redeploy is a different type.
 *
 * Both fold the incoming push into the oldest waiting deploy of the unit
 * (same flags), drop the other waiting duplicates, and report whether the push
 * was absorbed. When `merged` is true the caller must NOT enqueue the incoming
 * job: the waiting job now carries its title and pinned image. `removed` counts
 * only the jobs taken out of the queue; the job that was merged into stays
 * queued and is not in it. `titles` names what was replaced or dropped, so the
 * audit entry can show it.
 */
const coalesceWaiting = (
	incoming: DeploymentJob,
	matches: (data: any) => boolean,
): { removed: number; titles: string[]; merged: boolean } => {
	const { merged, removed, titles } = myQueue.coalesceWaiting(
		incoming,
		matches,
	);
	return {
		removed: removed.length,
		titles,
		merged: merged !== null,
	};
};

export const coalesceQueuedApplicationDeploys = async (
	applicationId: string,
	incoming: DeploymentJob,
) =>
	coalesceWaiting(incoming, (data) =>
		isCoalescableDeployJob("application", applicationId, data),
	);

export const coalesceQueuedComposeDeploys = async (
	composeId: string,
	incoming: DeploymentJob,
) =>
	coalesceWaiting(incoming, (data) =>
		isCoalescableDeployJob("compose", composeId, data),
	);

/** Drops every waiting job of the instance; returns how many were removed. */
export const cleanAllDeploymentQueue = async () => myQueue.clearWaiting();

/**
 * The generic stop for a build that has no cancel launcher of its own: it
 * matches by command line on the whole host. A build-server deployment and a
 * running rolling replace never come here (see `deployment-cancel.ts`).
 */
export const killDockerBuild = async (
	type: "application" | "compose",
	serverId: string | null,
) => {
	try {
		if (type === "application") {
			const command = `pkill -2 -f "docker build"`;

			if (serverId) {
				await execAsyncRemote(serverId, command);
			} else {
				await execAsync(command);
			}
		} else if (type === "compose") {
			const command = `pkill -2 -f "docker compose"`;

			if (serverId) {
				await execAsyncRemote(serverId, command);
			} else {
				await execAsync(command);
			}
		}
	} catch (error) {
		console.error(error);
	}
};

export { myQueue };
