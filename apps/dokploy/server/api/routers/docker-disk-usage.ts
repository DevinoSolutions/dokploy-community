import {
	cleanupBuilders,
	getBuildCache,
	getDockerDiskUsage,
} from "@dokploy/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { assertServerReachable } from "@/server/api/utils/container-service-access";
import { adminProcedure, createTRPCRouter, withPermission } from "../trpc";

export const dockerDiskUsageRouter = createTRPCRouter({
	// Sizes and counts per resource type, nothing that names a service.
	getDiskUsage: withPermission("docker", "read")
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertServerReachable(ctx, input.serverId);
			return await getDockerDiskUsage(input.serverId);
		}),

	// The build cache is the host's, shared by every build: its entries name the
	// build steps of every tenant, and pruning it slows their builds down. No
	// service owns it, so both routes are owner/admin only.
	getBuildCache: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertServerReachable(ctx, input.serverId);
			return await getBuildCache(input.serverId);
		}),

	pruneBuildCache: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertServerReachable(ctx, input.serverId);
			await cleanupBuilders(input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: "build-cache",
				resourceName: "Docker build cache",
			});
		}),
});
