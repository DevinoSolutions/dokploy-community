import type { RemoteBuildKillResult } from "@dokploy/server/utils/builders/remote-build-cancel";
import { stopBuildOnBuildServer } from "./deployment-cancel";

/**
 * A build that runs on a build server is a process tree over there. When
 * Dokploy restarts, that tree keeps building although nothing reads its result
 * any more, and the replayed job starts a second build next to it (T-12684).
 *
 * At boot, before any replayed job can start, this stops the recorded build of
 * each deployment the restart interrupted. It is the same stop a user's "Kill
 * Build" performs: the per-deployment pid file on the build server names the
 * process group, and the kill script signals it only when the recorded start
 * time and boot id still match, so nothing else on the build server is touched.
 * A replay creates a deployment of its own (new id, new pid file), so the old
 * id can only ever match the orphan.
 */

/**
 * Longest the boot waits for all the build servers together. Each kill already
 * has its own 30 s ceiling (an unreachable host included); this bounds the sum
 * when several are slow, so boot and the replay are never held for long.
 */
export const ORPHAN_KILL_BUDGET_MS = 25_000;

/**
 * The boot has one budget for every orphan-kill phase, not one per call: the
 * deadline starts with the first call that has something to stop, and a later
 * call only gets what is left of it. Kept on globalThis because this module can
 * be loaded twice (server bundle and Next chunks).
 */
const DEADLINE_SLOT = Symbol.for("dokploy.orphanKillDeadline");
const PENDING_SLOT = Symbol.for("dokploy.orphanKillPending");
type Slots = Record<symbol, unknown>;

/** Test hook: forget the shared deadline and the pending kills. */
export const resetOrphanKillBoot = () => {
	const registry = globalThis as unknown as Slots;
	registry[DEADLINE_SLOT] = undefined;
	registry[PENDING_SLOT] = undefined;
};

const remainingBudget = (budgetMs: number): number => {
	const registry = globalThis as unknown as Slots;
	const deadline = registry[DEADLINE_SLOT];
	if (typeof deadline !== "number") {
		registry[DEADLINE_SLOT] = Date.now() + budgetMs;
		return budgetMs;
	}
	return Math.max(0, deadline - Date.now());
};

/**
 * Resolves once every orphan kill started so far has finished or run out of
 * budget. Never rejects. The queue holds its worker on this, so a replayed
 * job of a build server cannot start next to the build it replaces, while the
 * restore itself (and the rest of the boot) does not wait for the kill.
 */
export const whenOrphanKillsSettled = (): Promise<void> => {
	const pending = (globalThis as unknown as Slots)[PENDING_SLOT];
	return pending instanceof Promise ? pending : Promise.resolve();
};

export interface OrphanedBuild {
	deploymentId: string;
	/** The build server the deployment built on; null when it built elsewhere. */
	buildServerId: string | null | undefined;
}

type StopBuild = (
	buildServerId: string,
	deploymentId: string,
) => Promise<{
	result: RemoteBuildKillResult | "UNREACHABLE";
	warning?: string;
}>;

export interface OrphanKillSummary {
	/** Builds a kill was attempted for. */
	attempted: number;
	/** Of those, builds that were really running and are now stopped. */
	stopped: number;
	/** Builds that could not be confirmed stopped (unreachable, survived, timed out). */
	unconfirmed: number;
}

/**
 * Stops the remote build of every given deployment that has a build server, in
 * parallel. Never throws and never waits past `budgetMs`: a build server that
 * cannot be reached is logged and the boot, and the replay, carry on. Only the
 * deployment and server ids and the kill outcome are logged, never a command.
 */
export const killOrphanedBuilds = async (
	builds: OrphanedBuild[],
	{
		stop = stopBuildOnBuildServer,
		budgetMs = ORPHAN_KILL_BUDGET_MS,
	}: { stop?: StopBuild; budgetMs?: number } = {},
): Promise<OrphanKillSummary> => {
	const run = killWithinBudget(builds, stop, budgetMs);
	if (builds.some((build) => build.buildServerId)) {
		const registry = globalThis as unknown as Slots;
		const before = registry[PENDING_SLOT];
		const mine = run.then(() => undefined);
		registry[PENDING_SLOT] =
			before instanceof Promise
				? Promise.all([before, mine]).then(() => undefined)
				: mine;
	}
	return run;
};

const killWithinBudget = async (
	builds: OrphanedBuild[],
	stop: StopBuild,
	budgetMs: number,
): Promise<OrphanKillSummary> => {
	const targets = new Map<string, { deploymentId: string; serverId: string }>();
	for (const build of builds) {
		if (build.buildServerId && !targets.has(build.deploymentId)) {
			targets.set(build.deploymentId, {
				deploymentId: build.deploymentId,
				serverId: build.buildServerId,
			});
		}
	}
	const summary: OrphanKillSummary = {
		attempted: targets.size,
		stopped: 0,
		unconfirmed: 0,
	};
	if (targets.size === 0) return summary;

	const remaining = remainingBudget(budgetMs);
	const settled = new Set<string>();
	const work = Promise.all(
		[...targets.values()].map(async ({ deploymentId, serverId }) => {
			try {
				const { result, warning } = await stop(serverId, deploymentId);
				settled.add(deploymentId);
				if (result === "KILLED") summary.stopped++;
				else if (
					result === "FAILED" ||
					result === "UNREACHABLE" ||
					result === "UNVERIFIED"
				) {
					summary.unconfirmed++;
				}
				console.log(
					`Orphaned build of interrupted deployment ${deploymentId} on build server ${serverId}: ${result}${warning ? ` (${warning})` : ""}`,
				);
			} catch (error) {
				settled.add(deploymentId);
				summary.unconfirmed++;
				console.error(
					`Could not stop the build of interrupted deployment ${deploymentId} on build server ${serverId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}),
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = await Promise.race([
		work.then(() => false),
		new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(true), remaining);
		}),
	]);
	clearTimeout(timer);
	if (timedOut) {
		const pending = [...targets.keys()].filter((id) => !settled.has(id));
		summary.unconfirmed += pending.length;
		console.error(
			`Stopping orphaned builds did not finish within the ${budgetMs / 1000}s boot budget; continuing the boot (still pending: ${pending.join(", ")})`,
		);
	}
	return summary;
};
