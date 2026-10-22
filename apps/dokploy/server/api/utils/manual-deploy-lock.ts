/** How long a click waits for the one ahead of it before it goes on without it. */
const MAX_WAIT_MS = 60_000;

const tails = new Map<string, Promise<void>>();

const waitFor = (previous: Promise<void>, key: string, maxWaitMs: number) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			console.warn(
				`[manual-deploy] ${key}: the previous request has not finished after ${maxWaitMs} ms, going on without it`,
			);
			resolve();
		}, maxWaitMs);
		// `previous` is a tail and never rejects.
		previous.then(() => {
			clearTimeout(timer);
			resolve();
		});
	});

/**
 * Runs `task` after the earlier tasks for the same key have finished, one at a
 * time per key, in the order they reach this function. That is arrival order
 * at the lock, which is after the caller's permission check and lookups, not
 * the order the clicks were sent. A rejected task does not hold up the next
 * one. A task that has not settled after `maxWaitMs` is not waited for any
 * longer: the next one goes on without it (and logs a warning), so one stuck
 * request cannot freeze a service's deploy button.
 *
 * A manual deploy coalesces the waiting jobs and then queues itself, with audit
 * writes awaited in between. Two clicks on one service interleaving there could
 * both find nothing to merge into and queue twice. Running gate and add as one
 * task per service closes that window for manual clicks handled by this
 * process, which is the only process that owns the in-memory queue. It does
 * not cover a webhook push racing a click: webhooks do not take this lock.
 */
export const serializeManualDeploy = async <T>(
	key: string,
	task: () => Promise<T>,
	maxWaitMs = MAX_WAIT_MS,
): Promise<T> => {
	const previous = tails.get(key) ?? Promise.resolve();
	const result = waitFor(previous, key, maxWaitMs).then(task);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	tails.set(key, tail);
	try {
		return await result;
	} finally {
		if (tails.get(key) === tail) tails.delete(key);
	}
};
