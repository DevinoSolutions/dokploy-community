/**
 * Process-wide registry of the build-server commands this process is waiting
 * on, keyed by deployment id.
 *
 * A cancel kills the build on the build server first. This registry is the
 * other half: it lets the cancel also drop the local ssh connection that is
 * waiting for that command, so the deployment job (and with it its queue slot
 * and its group lock) ends even when the build server never answers.
 *
 * The app can end up with more than one copy of this module (the dist build
 * behind the `@dokploy/server` barrel and a bundled deep import), so the map
 * lives in a slot on `globalThis` that every copy shares.
 */

export type RemoteBuildAbort = (reason: string) => void;

const SLOT = Symbol.for("dokploy.remoteBuildAbortRegistry");

const registry = (): Map<string, Set<RemoteBuildAbort>> => {
	const holder = globalThis as unknown as Record<
		symbol,
		Map<string, Set<RemoteBuildAbort>> | undefined
	>;
	let map = holder[SLOT];
	if (!map) {
		map = new Map();
		holder[SLOT] = map;
	}
	return map;
};

/** Registers a running command; returns the function that unregisters it. */
export const registerRemoteBuild = (
	deploymentId: string,
	abort: RemoteBuildAbort,
): (() => void) => {
	const map = registry();
	let aborts = map.get(deploymentId);
	if (!aborts) {
		aborts = new Set();
		map.set(deploymentId, aborts);
	}
	aborts.add(abort);
	return () => {
		const current = registry().get(deploymentId);
		if (!current) return;
		current.delete(abort);
		if (current.size === 0) registry().delete(deploymentId);
	};
};

/** True while a command of this deployment is running in this process. */
export const hasRunningRemoteBuild = (deploymentId: string) =>
	(registry().get(deploymentId)?.size ?? 0) > 0;

/**
 * Drops the local connection of every command of this deployment that is still
 * running in this process. Returns how many were aborted.
 */
export const abortRemoteBuild = (deploymentId: string, reason: string) => {
	const aborts = registry().get(deploymentId);
	if (!aborts) return 0;
	let count = 0;
	for (const abort of [...aborts]) {
		try {
			abort(reason);
			count++;
		} catch (error) {
			console.error("Could not abort a remote build connection", error);
		}
	}
	return count;
};

/**
 * What the cancel side saw while it stopped a deployment's release step. The
 * deploy side cannot tell from the shell's exit status whether the step had to
 * be SIGKILLed: under a plain `sh` (no `$SHELL`, as in the Dokploy container)
 * the launcher dies of the TERM itself and reports 143 either way. So the
 * cancel announces itself before it signals, and the deploy side, once its
 * command has ended, waits for the outcome. Same `globalThis` slot as above.
 */
export interface ReleaseCancelOutcome {
	/** The step did not finish its cancel cleanup in time and was SIGKILLed. */
	hardKilled: boolean;
}

interface ReleaseCancelEntry {
	outcome: Promise<ReleaseCancelOutcome>;
	settle: (outcome: ReleaseCancelOutcome) => void;
}

const CANCEL_SLOT = Symbol.for("dokploy.releaseCancelOutcomes");

const cancels = (): Map<string, ReleaseCancelEntry> => {
	const holder = globalThis as unknown as Record<
		symbol,
		Map<string, ReleaseCancelEntry> | undefined
	>;
	let map = holder[CANCEL_SLOT];
	if (!map) {
		map = new Map();
		holder[CANCEL_SLOT] = map;
	}
	return map;
};

/** An outcome nobody collected is dropped after this long. */
const RELEASE_CANCEL_TTL_MS = 120_000;

/**
 * Called by the cancel before it signals the release step of `key`. Returns
 * the function that records the outcome; call it exactly once, on every path.
 */
export const beginReleaseCancel = (
	key: string,
): ((outcome: ReleaseCancelOutcome) => void) => {
	let settle: (outcome: ReleaseCancelOutcome) => void = () => {};
	const outcome = new Promise<ReleaseCancelOutcome>((resolve) => {
		settle = resolve;
	});
	const entry: ReleaseCancelEntry = { outcome, settle };
	cancels().set(key, entry);
	const timer = setTimeout(() => {
		if (cancels().get(key) === entry) cancels().delete(key);
	}, RELEASE_CANCEL_TTL_MS);
	timer.unref?.();
	return settle;
};

/**
 * Called by the deploy side once its release command has ended: the outcome of
 * the cancel that is stopping it, waiting at most `timeoutMs` for it, or
 * undefined when no cancel announced itself. Always removes the entry.
 */
export const takeReleaseCancel = async (
	key: string,
	timeoutMs: number,
): Promise<ReleaseCancelOutcome | undefined> => {
	const entry = cancels().get(key);
	if (!entry) return undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			entry.outcome,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (cancels().get(key) === entry) cancels().delete(key);
	}
};

/** Drops an outcome nobody needs (the release command ended on its own). */
export const discardReleaseCancel = (key: string) => {
	cancels().delete(key);
};
