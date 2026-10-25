import { IS_CLOUD, listLatestDeploysOf } from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { getGroup, getPartition } from "@/server/queues/in-memory-queue";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";
import { captureError } from "@/server/sentry";

export const COMPOSE_FETCH_BUSY_MESSAGE =
	"A deployment of this compose is running; try Fetch again when it finishes";

export const COMPOSE_FETCH_REBUILD_QUEUED_MESSAGE =
	"A rebuild of this compose is queued; try Fetch again when it finishes";

export const COMPOSE_FETCH_HELD_MESSAGE =
	"Another Fetch of this compose is running; try again when it finishes";

/**
 * Last resort: how long a Fetch may keep the compose's queue lock. The clone
 * itself is stopped well before (`FETCH_CLONE_TIMEOUT_SECONDS`, see
 * `boundFetchCommand`), so the lock is normally given back once the clone has
 * exited. Reaching this means it did not exit (a host without `timeout`, a
 * dropped connection that never closed): the lock is given back anyway, so the
 * compose's deploys are not held back forever, and it is reported.
 */
const MAX_HOLD_MS = 10 * 60_000;

/**
 * A queued Rebuild clones nothing: it builds the checkout it finds on disk
 * (see compose-rebuild-pin.ts), so a Fetch before it would make it build the
 * fetched commit instead of the deployed one. A queued deploy clones again
 * and may wait behind a Fetch; a preview builds in its own directory.
 */
const isComposeRebuild = (data: DeploymentJob) =>
	data.applicationType === "compose" && data.type === "redeploy";

/**
 * Runs `work`, a Fetch (a clone of the compose's source outside a deploy), under
 * the compose's group lock in the deployment queue: the lock a deploy, rebuild
 * or preview of the compose holds while it runs. A Fetch rewrites the code dir
 * the deploy reads, so it is refused while a job of the compose runs, and no job
 * of the compose starts until it is done; a job that waits keeps its place and
 * starts after it, except a Rebuild, which refuses the Fetch. Refused before
 * `work` runs, so nothing is cloned.
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
	const hold = myQueue.holdIdleGroup(
		getPartition(job),
		getGroup(job),
		isComposeRebuild,
	);
	if ("busy" in hold) {
		throw new TRPCError({
			code: "CONFLICT",
			message:
				hold.busy === "held"
					? COMPOSE_FETCH_HELD_MESSAGE
					: hold.busy === "waiting"
						? COMPOSE_FETCH_REBUILD_QUEUED_MESSAGE
						: COMPOSE_FETCH_BUSY_MESSAGE,
		});
	}
	const timer = setTimeout(() => {
		const message = `[compose-fetch] compose ${compose.composeId}: the Fetch has not finished after ${maxHoldMs} ms, releasing its deploy lock while it may still run`;
		console.error(message);
		captureError(new Error(message), { handler: "composeFetchLock" });
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
