import {
	createNetwork,
	findNetworkById,
	findNetworksByOrganizationId,
	findResourcesUsingNetwork,
	removeNetworkById,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateNetwork,
	apiFindOneNetwork,
	apiRemoveNetwork,
} from "@/server/db/schema";

export const networkRouter = createTRPCRouter({
	all: withPermission("network", "read").query(async ({ ctx }) =>
		findNetworksByOrganizationId(ctx.session.activeOrganizationId),
	),

	one: withPermission("network", "read")
		.input(apiFindOneNetwork)
		.query(async ({ ctx, input }) =>
			findNetworkById(input.networkId, ctx.session.activeOrganizationId),
		),

	create: withPermission("network", "create")
		.input(apiCreateNetwork)
		.mutation(async ({ ctx, input }) => {
			try {
				const created = await createNetwork(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "network",
					resourceId: created.networkId,
					resourceName: created.name,
				});
				return created;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				if (
					/unique|duplicate|already exists|is already in use|network_name_serverId_idx/i.test(
						message,
					)
				) {
					throw new TRPCError({
						code: "CONFLICT",
						message: `A network named "${input.name}" already exists on this server`,
						cause: error,
					});
				}
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the network",
					cause: error,
				});
			}
		}),

	usage: withPermission("network", "read")
		.input(apiFindOneNetwork)
		.query(async ({ ctx, input }) =>
			findResourcesUsingNetwork(
				input.networkId,
				ctx.session.activeOrganizationId,
			),
		),

	remove: withPermission("network", "delete")
		.input(apiRemoveNetwork)
		.mutation(async ({ ctx, input }) => {
			const deleted = await removeNetworkById(
				input.networkId,
				ctx.session.activeOrganizationId,
			);
			if (deleted) {
				await audit(ctx, {
					action: "delete",
					resourceType: "network",
					resourceId: deleted.networkId,
					resourceName: deleted.name,
				});
			}
			return deleted;
		}),
});
