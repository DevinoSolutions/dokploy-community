import { IS_CLOUD, listLatestDeploysOf } from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { getGroup, getPartition } from "@/server/queues/in-memory-queue";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";

export const COMPOSE_FETCH_BUSY_MESSAGE =
	"A deployment of this compose is queued or running; try Fetch again when it finishes";

export const COMPOSE_FETCH_HELD_MESSAGE =
	"Another Fetch of this compose is running; try again when it finishes";

/**
 * How long a Fetch may keep the compose's queue lock. A clone that hangs past
 * it gives the lock back (and logs a warning), so one stuck Fetch cannot hold
 * the compose's deploys back forever.
 */
const MAX_HOLD_MS = 10 * 60_000;

/**
 * Runs `work`, a Fetch (a clone of the compose's source outside a deploy), under
 * the compose's group lock in the deployment queue: the lock a deploy, rebuild
 * or preview of the compose holds while it runs. A Fetch rewrites the code dir
 * the deploy reads, so it is refused while a job of the compose waits or runs,
 * and no job of the compose starts until it is done. Refused before `work`
 * runs, so nothing is cloned.
 *
 * Cloud deploys do not go through the queue: there the compose's running
 * deployment rows are checked instead, which is a check, not a lock.
 */
export const withComposeFetchLock = async <T>(
	compose: { composeId: string; serverId?: string | null },
	work: () => Promise<T>,
	maxHoldMs = MAX_HOLD_MS,
): Promise<T> => {
	if (IS_CLOUD) {
		const latest = await listLatestDeploysOf({ composeId: compose.composeId });
		if (latest.some((row) => row.status === "running")) {
			throw new TRPCError({
				code: "CONFLICT",
				message: COMPOSE_FETCH_BUSY_MESSAGE,
			});
		}
	}
	const job: DeploymentJob = {
		composeId: compose.composeId,
		titleLog: "Fetch",
		descriptionLog: "",
		type: "deploy",
		applicationType: "compose",
		serverId: compose.serverId ?? undefined,
	};
	const hold = myQueue.holdIdleGroup(getPartition(job), getGroup(job));
	if ("busy" in hold) {
		throw new TRPCError({
			code: "CONFLICT",
			message:
				hold.busy === "held"
					? COMPOSE_FETCH_HELD_MESSAGE
					: COMPOSE_FETCH_BUSY_MESSAGE,
		});
	}
	const timer = setTimeout(() => {
		console.warn(
			`[compose-fetch] compose ${compose.composeId}: the Fetch has not finished after ${maxHoldMs} ms, releasing its deploy lock`,
		);
		hold.release();
	}, maxHoldMs);
	timer.unref?.();
	try {
		return await work();
	} finally {
		clearTimeout(timer);
		hold.release();
	}
};
