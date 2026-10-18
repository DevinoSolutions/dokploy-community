import { listDeploymentCancelAudit } from "@dokploy/server";
import { z } from "zod";
import { adminProcedure, createTRPCRouter } from "../trpc";

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
});
