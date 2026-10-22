import { buildPolicyDeployGate } from "@dokploy/server";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { coalesceQueuedComposeDeploys } from "@/server/queues/queueSetup";
import {
	type CancelAuditActorCtx,
	cancelAuditCaller,
} from "./cancel-audit-actor";

/**
 * Queue coalescing for a manual compose deploy or redeploy, the same gate the
 * compose webhooks go through (`buildPolicyDeployGate`): it folds `job` into the
 * oldest waiting job of the same compose, type and flags, drops the other
 * waiting duplicates, and writes the same audit rows. With the build policy off
 * it does nothing, exactly as on the webhook paths.
 *
 * The drop is written to the cancel trail under `ctx`'s user, since this click
 * can replace another user's waiting job.
 *
 * `merged` means a waiting job took the request over and the caller must not
 * enqueue it. The queue only ever takes out jobs that are still waiting, so the
 * job being added can never be coalesced away itself: when nothing waits, the
 * caller enqueues as usual.
 */
export const coalesceManualComposeDeploy = async (
	compose: {
		composeId: string;
		name: string;
		environmentId: string;
		watchPaths?: string[] | null;
		composePath?: string | null;
	},
	job: DeploymentJob,
	ctx: CancelAuditActorCtx,
): Promise<{ merged: boolean }> => {
	const gate = await buildPolicyDeployGate({
		unitType: "compose",
		unit: {
			unitId: compose.composeId,
			unitName: compose.name,
			environmentId: compose.environmentId,
			watchPaths: compose.watchPaths,
			composePath: compose.composePath,
		},
		removeWaiting: () => coalesceQueuedComposeDeploys(compose.composeId, job),
		caller: cancelAuditCaller(ctx),
	});
	return { merged: gate.deploy && gate.merged === true };
};
