import {
	createNetwork,
	findNetworkById,
	findNetworksToSync,
	importDockerNetworks,
	inspectNetwork,
	recreateNetwork,
	removeNetwork,
	resyncNetwork,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
	adminProcedure,
	createTRPCRouter,
	withPermission,
} from "@/server/api/trpc";
import { db } from "@/server/db";
import {
	apiCreateNetwork,
	apiFindOneNetwork,
	apiRemoveNetwork,
	network as networkTable,
} from "@/server/db/schema";
import { audit } from "../utils/audit";
import {
	assertServerReachable,
	canReachServer,
} from "../utils/container-service-access";
import {
	assertLocalHostAccess,
	canAccessLocalHost,
} from "../utils/local-host-access";

// The row of the caller's organization, on a server the caller can reach (an
// organization's networks live on its servers, and a member only gets the ones
// they were granted). Every other answer is the same NOT_FOUND, so it says
// nothing about which networks exist.
const findOwnNetwork = async (
	ctx: { user: { id: string }; session: { activeOrganizationId: string } },
	networkId: string,
) => {
	const row = await findNetworkById(networkId);
	if (
		row.organizationId !== ctx.session.activeOrganizationId ||
		!(await canReachServer(ctx, row.serverId ?? undefined))
	) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Network not found",
		});
	}
	return row;
};

export const networkRouter = createTRPCRouter({
	all: withPermission("network", "read")
		.input(z.object({ serverId: z.string().optional() }))
		.query(async ({ ctx, input }) => {
			await assertServerReachable(ctx, input.serverId);
			const rows = await db.query.network.findMany({
				where: and(
					eq(networkTable.organizationId, ctx.session.activeOrganizationId),
					input.serverId
						? eq(networkTable.serverId, input.serverId)
						: isNull(networkTable.serverId),
				),
				orderBy: desc(networkTable.createdAt),
			});
			return rows;
		}),

	one: withPermission("network", "read")
		.input(apiFindOneNetwork)
		.query(async ({ ctx, input }) => {
			return await findOwnNetwork(ctx, input.networkId);
		}),
	create: withPermission("network", "create")
		.input(apiCreateNetwork)
		.mutation(async ({ ctx, input }) => {
			await assertServerReachable(ctx, input.serverId ?? undefined);
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
		}),
	// The sync and import routes list and adopt the networks that exist on the
	// host, every tenant's included, and an imported row can then be recreated or
	// removed through this router. A host network is not owned by an
	// organization, so there is nothing to scope a member to: owner/admin only
	// (they always hold the network statement). On the local host only those of
	// the organization that owns the instance may adopt a network: the others
	// still see which of their own networks went missing or changed, but not the
	// importable ones.
	networksToSync: adminProcedure
		.input(z.object({ serverId: z.string().optional() }))
		.query(async ({ ctx, input }) => {
			await assertServerReachable(ctx, input.serverId);
			const result = await findNetworksToSync(
				ctx.session.activeOrganizationId,
				input.serverId ?? null,
			);
			return (await canAccessLocalHost(
				input.serverId,
				ctx.session?.activeOrganizationId,
			))
				? result
				: { ...result, importable: [] as typeof result.importable };
		}),

	import: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
				names: z.array(z.string().min(1)).min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertLocalHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			await assertServerReachable(ctx, input.serverId);
			const result = await importDockerNetworks(
				ctx.session.activeOrganizationId,
				input.serverId ?? null,
				input.names,
			);
			if (result.imported.length > 0) {
				await audit(ctx, {
					action: "create",
					resourceType: "network",
					resourceName: result.imported.join(", "),
					metadata: { imported: result.imported },
				});
			}
			return result;
		}),

	inspect: withPermission("network", "read")
		.input(apiFindOneNetwork)
		.query(async ({ ctx, input }) => {
			await findOwnNetwork(ctx, input.networkId);
			return inspectNetwork(input.networkId);
		}),

	recreate: withPermission("network", "delete")
		.input(apiFindOneNetwork)
		.mutation(async ({ ctx, input }) => {
			await findOwnNetwork(ctx, input.networkId);
			const recreated = await recreateNetwork(input.networkId);
			await audit(ctx, {
				action: "reload",
				resourceType: "network",
				resourceId: recreated.networkId,
				resourceName: recreated.name,
			});
			return recreated;
		}),

	resync: withPermission("network", "delete")
		.input(apiFindOneNetwork)
		.mutation(async ({ ctx, input }) => {
			await findOwnNetwork(ctx, input.networkId);
			const resynced = await resyncNetwork(
				input.networkId,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "network",
				resourceId: resynced.networkId,
				resourceName: resynced.name,
			});
			return resynced;
		}),

	remove: withPermission("network", "delete")
		.input(apiRemoveNetwork)
		.mutation(async ({ ctx, input }) => {
			await findOwnNetwork(ctx, input.networkId);
			const removed = await removeNetwork(input.networkId);
			await audit(ctx, {
				action: "delete",
				resourceType: "network",
				resourceId: removed.networkId,
				resourceName: removed.name,
			});
			return removed;
		}),
});
