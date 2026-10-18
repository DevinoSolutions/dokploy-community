import {
	findDeploymentCancelledByService,
	listDeploymentCancelAudit,
} from "@dokploy/server";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { z } from "zod";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";

/**
 * Fork router: the trail of who cancelled, killed or dropped a deployment or
 * queued job. The organization comes from the session only, never from input.
 */
export const deploymentCancelAuditRouter = createTRPCRouter({
	all: adminProcedure
		.input(
			z.object({
				targetId: z.string().min(1).optional(),
				limit: z.number().int().min(1).max(200).default(50),
				offset: z.number().int().min(0).default(0),
			}),
		)
		.query(async ({ ctx, input }) =>
			listDeploymentCancelAudit({
				organizationId: ctx.session.activeOrganizationId,
				targetId: input.targetId,
				limit: input.limit,
				offset: input.offset,
			}),
		),

	// Who cancelled the deployments listed on a service page. Open to whoever
	// can read that service's deployments (`deployment.all`): the same service
	// permission, member allow-list and organization checks.
	byApplication: protectedProcedure
		.input(z.object({ applicationId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["read"],
			});
			return findDeploymentCancelledByService({
				organizationId: ctx.session.activeOrganizationId,
				applicationId: input.applicationId,
			});
		}),

	byCompose: protectedProcedure
		.input(z.object({ composeId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["read"],
			});
			return findDeploymentCancelledByService({
				organizationId: ctx.session.activeOrganizationId,
				composeId: input.composeId,
			});
		}),
});
