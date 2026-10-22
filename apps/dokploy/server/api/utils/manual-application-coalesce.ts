import { buildPolicyDeployGate } from "@dokploy/server";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { coalesceQueuedApplicationDeploys } from "@/server/queues/queueSetup";
import {
	type CancelAuditActorCtx,
	cancelAuditCaller,
} from "./cancel-audit-actor";

/**
 * Queue coalescing for a manual application deploy or redeploy: the application
 * twin of `coalesceManualComposeDeploy`, and the same gate the application
 * webhooks go through. It folds `job` into the oldest waiting job of the same
 * application, type and flags, drops the other waiting duplicates (never PR
 * previews, never the other type), and writes the same audit rows under `ctx`'s
 * user. With the build policy off it does nothing.
 *
 * `merged` means a waiting job took the request over and the caller must not
 * enqueue it.
 */
export const coalesceManualApplicationDeploy = async (
	application: {
		applicationId: string;
		name: string;
		environmentId: string;
		watchPaths?: string[] | null;
	},
	job: DeploymentJob,
	ctx: CancelAuditActorCtx,
): Promise<{ merged: boolean }> => {
	const gate = await buildPolicyDeployGate({
		unitType: "application",
		unit: {
			unitId: application.applicationId,
			unitName: application.name,
			environmentId: application.environmentId,
			watchPaths: application.watchPaths,
		},
		removeWaiting: () =>
			coalesceQueuedApplicationDeploys(application.applicationId, job),
		caller: cancelAuditCaller(ctx),
	});
	return { merged: gate.deploy && gate.merged === true };
};
