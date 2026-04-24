import { db } from "@dokploy/server/db";
import {
	type apiCreateNetwork,
	network,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { IS_CLOUD } from "../constants";
import { getRemoteDocker } from "../utils/servers/remote-docker";

export const findNetworkById = async (networkId: string) => {
	const row = await db.query.network.findFirst({
		where: eq(network.networkId, networkId),
	});
	if (!row) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Network not found",
		});
	}
	return row;
};

export const findNetworksByOrganizationId = async (organizationId: string) =>
	db
		.select()
		.from(network)
		.where(eq(network.organizationId, organizationId))
		.orderBy(desc(network.createdAt));

/**
 * Resolve a list of networkIds to Docker network names for use in a Swarm
 * service spec. Silently drops any id that no longer exists — a deploy should
 * not hard-fail on a stale reference (e.g. the network was deleted after the
 * user attached it). Organization scoping is enforced at write time (the
 * mutation that saves networkIds on a resource verifies ownership), so this
 * read path stays simple.
 *
 * When the resource has a `serverId`, only networks scoped to that same
 * server (or unscoped/local networks) are returned — a network belonging to
 * a different server can't be attached to a service running on this one.
 */
export const resolveNetworkNamesForResource = async (
	networkIds: string[] | null | undefined,
	serverId?: string | null,
): Promise<string[]> => {
	if (!networkIds || networkIds.length === 0) return [];
	const rows = await db
		.select({
			name: network.name,
			serverId: network.serverId,
		})
		.from(network)
		.where(inArray(network.networkId, networkIds));
	const target = serverId ?? null;
	return rows
		.filter((row) => (row.serverId ?? null) === target)
		.map((row) => row.name);
};

export const createNetwork = async (
	input: z.infer<typeof apiCreateNetwork>,
	organizationId: string,
) => {
	if (IS_CLOUD && !input.serverId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Server is required in cloud mode",
		});
	}

	// Transactional: insert DB row, then create Docker network. If Docker fails,
	// the transaction rolls back the DB row so we never persist a ghost record.
	return db.transaction(async (tx) => {
		const [row] = await tx
			.insert(network)
			.values({ ...input, organizationId })
			.returning();

		if (!row) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Failed to insert network",
			});
		}

		const ipam = row.ipam ?? {};
		const ipamConfig = (ipam.config ?? [])
			.map((c) => {
				const entry: Record<string, string> = {};
				if (c.subnet) entry.Subnet = c.subnet;
				if (c.gateway) entry.Gateway = c.gateway;
				if (c.ipRange) entry.IPRange = c.ipRange;
				return entry;
			})
			.filter((entry) => Object.keys(entry).length > 0);

		const docker = await getRemoteDocker(row.serverId ?? null);
		try {
			await docker.createNetwork({
				Name: row.name,
				Driver: row.driver,
				Internal: row.internal,
				Attachable: row.attachable,
				Ingress: row.ingress,
				EnableIPv6: row.enableIPv6,
				IPAM: {
					Driver: ipam.driver ?? "default",
					Config: ipamConfig.length > 0 ? ipamConfig : undefined,
				},
			});
		} catch (error) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					error instanceof Error
						? `Docker rejected network creation: ${error.message}`
						: "Docker rejected network creation",
				cause: error,
			});
		}

		return row;
	});
};

/**
 * Remove a network. Attempts Docker removal first; only deletes the DB row on
 * Docker success (or when the network is already absent on the daemon).
 * Surfaces "network in use" as a structured error so the UI can explain.
 */
export const removeNetworkById = async (
	networkId: string,
	organizationId: string,
) => {
	const target = await db.query.network.findFirst({
		where: and(
			eq(network.networkId, networkId),
			eq(network.organizationId, organizationId),
		),
	});
	if (!target) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Network not found",
		});
	}

	const docker = await getRemoteDocker(target.serverId ?? null);
	try {
		// Look up the Docker network by name. We don't persist Docker's network
		// ID to stay resilient against drift (e.g. manual `docker network rm`).
		const dockerNetworks = await docker.listNetworks();
		const match = dockerNetworks.find((n) => n.Name === target.name);
		if (match) {
			await docker.getNetwork(match.Id).remove();
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/has active endpoints|is in use/i.test(message)) {
			throw new TRPCError({
				code: "CONFLICT",
				message: `Network "${target.name}" is in use by running containers. Disconnect or stop them first.`,
				cause: error,
			});
		}
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Failed to remove Docker network: ${message}`,
			cause: error,
		});
	}

	const [deleted] = await db
		.delete(network)
		.where(
			and(
				eq(network.networkId, networkId),
				eq(network.organizationId, organizationId),
			),
		)
		.returning();

	return deleted;
};
