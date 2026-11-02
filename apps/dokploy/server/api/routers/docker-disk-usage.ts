import {
	cleanupBuilders,
	getBuildCache,
	getDockerDiskUsage,
} from "@dokploy/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	assertBuilderPruneAllowed,
	auditBuilderPrune,
	builderPruneInput,
} from "@/server/api/utils/builder-prune";
import { assertServerReachable } from "@/server/api/utils/container-service-access";
import { assertLocalHostAccess } from "@/server/api/utils/local-host-access";
import { adminProcedure, createTRPCRouter, withPermission } from "../trpc";

export const dockerDiskUsageRouter = createTRPCRouter({
	// Sizes and counts per resource type, nothing that names a service. On the
	// local host they cover every organization's, so only the organization that
	// owns the instance reads them.
	getDiskUsage: withPermission("docker", "read")
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertLocalHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			await assertServerReachable(ctx, input.serverId);
			return await getDockerDiskUsage(input.serverId);
		}),

	// The build cache is the host's, shared by every build: its entries name the
	// build steps of every tenant, and pruning it slows their builds down. No
	// service owns it, so both routes are owner/admin only, and on the local host
	// only those of the organization that owns the instance.
	getBuildCache: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertLocalHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			await assertServerReachable(ctx, input.serverId);
			return await getBuildCache(input.serverId);
		}),

	pruneBuildCache: adminProcedure
		.input(builderPruneInput)
		.mutation(async ({ input, ctx }) => {
			await assertLocalHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			await assertServerReachable(ctx, input.serverId);
			const { hostName, activeBuilds } = await assertBuilderPruneAllowed({
				serverId: input.serverId,
				force: input.force,
			});
			// Before the prune: it can run for hours and the request may never return.
			await auditBuilderPrune(
				ctx,
				{
					operation: "dockerDiskUsage.pruneBuildCache",
					serverId: input.serverId,
					hostName,
					force: input.force,
					all: input.all,
					activeBuilds,
				},
				audit,
			);
			await cleanupBuilders(input.serverId, { all: input.all });
		}),
});
