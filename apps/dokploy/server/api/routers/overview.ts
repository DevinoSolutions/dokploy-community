import {
	BUILD_ORIGIN_DESCRIPTION,
	BUILD_ORIGINS,
	BUILD_RUN_URL_DESCRIPTION,
	getAllBackupsForOrganization,
	getAllDomainsForOrganization,
	getAllServicesForOrganization,
} from "@dokploy/server";
import {
	findMemberByUserId,
	hasPermission,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure, withPermission } from "../trpc";

export const overviewRouter = createTRPCRouter({
	services: withPermission("service", "read")
		.meta({
			openapi: {
				method: "GET",
				path: "/overview.services",
				description: `List every service of the organization (applications, composes and databases) with its project, environment, status and last deploy time. For applications and composes it also returns buildOrigin and buildRunUrl, so you can see which services are built where. buildOrigin: ${BUILD_ORIGIN_DESCRIPTION} It is the value of the service's latest deployment with status done (else its latest deployment of any status); databases return null. buildRunUrl: ${BUILD_RUN_URL_DESCRIPTION} Pass buildOrigin to list only the services built that way.`,
			},
		})
		.input(
			z
				.object({
					buildOrigin: z
						.enum(BUILD_ORIGINS)
						.optional()
						.describe(
							"Only return applications and composes built this way. Omit to list every service.",
						),
				})
				.optional(),
		)
		.query(async ({ ctx, input }) => {
			const orgId = ctx.session.activeOrganizationId;
			const accessedServices =
				ctx.user.role !== "owner" && ctx.user.role !== "admin"
					? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
					: null;
			return getAllServicesForOrganization(orgId, accessedServices, {
				buildOrigin: input?.buildOrigin,
			});
		}),

	// Reads backup and/or volumeBackup run history depending on which the user can see.
	backups: protectedProcedure.query(async ({ ctx }) => {
		const [canReadBackups, canReadVolumeBackups] = await Promise.all([
			hasPermission(ctx, { backup: ["read"] }),
			hasPermission(ctx, { volumeBackup: ["read"] }),
		]);
		if (!canReadBackups && !canReadVolumeBackups) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You don't have access to backups or volume backups",
			});
		}
		const orgId = ctx.session.activeOrganizationId;
		const accessedServices =
			ctx.user.role !== "owner" && ctx.user.role !== "admin"
				? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
				: null;
		return getAllBackupsForOrganization(orgId, accessedServices, {
			backup: canReadBackups,
			volumeBackup: canReadVolumeBackups,
		});
	}),

	domains: withPermission("domain", "read").query(async ({ ctx }) => {
		const orgId = ctx.session.activeOrganizationId;
		const accessedServices =
			ctx.user.role !== "owner" && ctx.user.role !== "admin"
				? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
				: null;
		return getAllDomainsForOrganization(orgId, accessedServices);
	}),
});
