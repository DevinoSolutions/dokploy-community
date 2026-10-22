const tails = new Map<string, Promise<void>>();

/**
 * Runs `task` after every earlier task for the same key has finished, one at a
 * time per key, in call order. A rejected task does not hold up the next one.
 *
 * A manual deploy coalesces the waiting jobs and then queues itself, with audit
 * writes awaited in between. Two clicks on one service interleaving there could
 * both find nothing to merge into and queue twice. Running gate and add as one
 * task per service closes that window for requests handled by this process,
 * which is the only process that owns the in-memory queue.
 */
export const serializeManualDeploy = async <T>(
	key: string,
	task: () => Promise<T>,
): Promise<T> => {
	const previous = tails.get(key) ?? Promise.resolve();
	const result = previous.then(task);
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
