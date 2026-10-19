import {
	type DeploymentCancelledBy,
	findDeploymentCancelledByService,
	listDeploymentCancelAudit,
} from "@dokploy/server";
import {
	checkServicePermissionAndAccess,
	hasPermission,
	type PermissionCtx,
} from "@dokploy/server/services/permission";
import { z } from "zod";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";

/**
 * Who is behind a cancellation is member information: the same gate as the
 * member list (`member:read`, held by owners and admins). Anyone else who can
 * read the service's deployments only learns whether a user or an API key did
 * it, never the email, the key's name or the OAuth client.
 */
const withActorVisibility = async (
	ctx: PermissionCtx,
	entries: DeploymentCancelledBy[],
): Promise<DeploymentCancelledBy[]> => {
	if (await hasPermission(ctx, { member: ["read"] })) return entries;
	return entries.map((entry) => ({
		...entry,
		actorEmail: null,
		apiKeyName: null,
		apiKeyShortId: null,
		oauthClientName: null,
		oauthClientShortId: null,
	}));
};

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
	// permission, member allow-list and organization checks. The actor's email
	// and API key or OAuth client name come back only with `member:read`.
	byApplication: protectedProcedure
		.input(z.object({ applicationId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["read"],
			});
			return withActorVisibility(
				ctx,
				await findDeploymentCancelledByService({
					organizationId: ctx.session.activeOrganizationId,
					applicationId: input.applicationId,
				}),
			);
		}),

	byCompose: protectedProcedure
		.input(z.object({ composeId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["read"],
			});
			return withActorVisibility(
				ctx,
				await findDeploymentCancelledByService({
					organizationId: ctx.session.activeOrganizationId,
					composeId: input.composeId,
				}),
			);
		}),
});
