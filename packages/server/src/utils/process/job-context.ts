import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which deployment-queue job the running code belongs to, so a job whose queue
 * slot the stuck-deployment watchdog released by force cannot write its late
 * results.
 *
 * A job that hangs and is released keeps running in the background. If it wakes
 * up hours later it would set its deployment to `done` over the `error` the
 * watchdog recorded, and its service to `done` over a newer deploy. The queue
 * runs every job inside `runInJobContext`; the status writes call
 * `isReleasedJobContext` and do nothing when it says the job was released.
 * Code outside a job (a request, a cron, the watchdog itself) has no context
 * and is never affected.
 *
 * The store is process-wide because the app can load a second copy of this
 * module (see utils/process/background.ts).
 */

export interface JobContext {
	/** True once the queue released the job's slot. Read live. */
	isReleased: () => boolean;
}

const SLOT = Symbol.for("dokploy.deploymentJobContext");

const store = (): AsyncLocalStorage<JobContext> => {
	const registry = globalThis as unknown as Record<
		symbol,
		AsyncLocalStorage<JobContext> | undefined
	>;
	let slot = registry[SLOT];
	if (!slot) {
		slot = new AsyncLocalStorage<JobContext>();
		registry[SLOT] = slot;
	}
	return slot;
};

export const runInJobContext = <T>(context: JobContext, run: () => T): T =>
	store().run(context, run);

/** True when the calling code runs inside a job whose slot was released. */
export const isReleasedJobContext = (): boolean =>
	store().getStore()?.isReleased() === true;

/**
 * The deployments whose job was released by force. The context above is lost
 * when code runs outside the job's async chain (a detached callback, a timer),
 * so a deployment write is also refused by the id of the deployment: the
 * watchdog already settled that row, and nothing may change it again.
 */
const RELEASED_SLOT = Symbol.for("dokploy.releasedDeployments");
const MAX_RELEASED_DEPLOYMENTS = 500;

const releasedDeployments = (): Set<string> => {
	const registry = globalThis as unknown as Record<
		symbol,
		Set<string> | undefined
	>;
	let slot = registry[RELEASED_SLOT];
	if (!slot) {
		slot = new Set<string>();
		registry[RELEASED_SLOT] = slot;
	}
	return slot;
};

export const markDeploymentReleased = (deploymentId: string): void => {
	const released = releasedDeployments();
	released.add(deploymentId);
	// Bounded: the oldest ids go first (a Set keeps insertion order).
	while (released.size > MAX_RELEASED_DEPLOYMENTS) {
		const oldest = released.values().next().value;
		if (oldest === undefined) break;
		released.delete(oldest);
	}
};

export const isDeploymentReleased = (deploymentId: string): boolean =>
	releasedDeployments().has(deploymentId);

/**
 * Logs and returns true when a write should be skipped because the job that
 * makes it was released by the watchdog: it runs in a released job's context,
 * or it is for a deployment the watchdog released.
 */
export const skipWriteOfReleasedJob = (
	what: string,
	deploymentId?: string,
): boolean => {
	if (
		!isReleasedJobContext() &&
		!(deploymentId && isDeploymentReleased(deploymentId))
	) {
		return false;
	}
	console.warn(
		`Ignored ${what}: the deployment job was released by the watchdog`,
	);
	return true;
};
