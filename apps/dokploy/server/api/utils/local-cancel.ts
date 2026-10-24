import { TRPCError } from "@trpc/server";
import { audit } from "@/server/api/utils/audit";
import { auditCancel } from "@/server/api/utils/cancel-audit";
import type { ServiceRef } from "@/server/utils/cancel-active-deployment";

type CancelCtx = Parameters<typeof auditCancel>[0] &
	Parameters<typeof audit>[0];

/**
 * `application.cancelDeployment` / `compose.cancelDeployment` on a self-hosted
 * instance: stops the running deployment of the service (see
 * cancel-active-deployment.ts), then writes the same two trail entries as the
 * Cloud path, one cancel-trail entry per deployment that was stopped. The
 * caller has already checked the `deployment:cancel` permission.
 */
export const cancelRunningDeploymentLocally = async (
	ctx: CancelCtx,
	service: ServiceRef & { appName: string; name: string },
) => {
	// Loaded here so a Cloud build never pulls the queue in with the routers.
	const [{ cancelActiveServiceDeployment }, { createDefaultCancelDeps }] =
		await Promise.all([
			import("@/server/utils/cancel-active-deployment"),
			import("@/server/queues/deployment-control"),
		]);
	const result = await cancelActiveServiceDeployment(
		service,
		createDefaultCancelDeps(),
	);

	if (result.status === "nothing-running") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "No deployment is running for this service",
		});
	}
	if (result.status === "starting") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The deployment is still starting, try again in a moment",
		});
	}
	if (result.status === "not-stopped") {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `The deployment could not be stopped: ${result.warnings.join(" ")}`,
		});
	}

	const isCompose = service.type === "compose";
	const serviceId = isCompose ? service.composeId : service.applicationId;
	for (const deploymentId of result.deploymentIds) {
		await auditCancel(ctx, {
			action: "cancel_deployment",
			targetType: service.type,
			targetId: serviceId,
			targetName: service.appName,
			applicationId: isCompose ? undefined : serviceId,
			composeId: isCompose ? serviceId : undefined,
			deploymentId,
		});
	}
	try {
		await audit(ctx, {
			action: "cancel",
			resourceType: service.type,
			resourceId: serviceId,
			resourceName: isCompose ? service.name : service.appName,
		});
	} catch (error) {
		// The deployment is already stopped: a failing audit must not hide that.
		console.error("cancelDeployment audit failed:", error);
	}
	return {
		success: true,
		message: result.slotFree
			? "Deployment cancelled"
			: "Deployment cancellation requested: the job is still ending and frees its queue slot when it has",
		slotFree: result.slotFree,
		...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
	};
};
