import {
	createNetwork,
	findNetworkById,
	findNetworksByOrganizationId,
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
		.query(async ({ ctx, input }) => {
			const row = await findNetworkById(input.networkId);
			if (row.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Network not found",
				});
			}
			return row;
		}),

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
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the network",
					cause: error,
				});
			}
		}),

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
