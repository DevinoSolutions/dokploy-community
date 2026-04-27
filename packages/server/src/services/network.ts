import { db } from "@dokploy/server/db";
import {
	type apiCreateNetwork,
	applications,
	libsql,
	mariadb,
	mongo,
	mysql,
	network,
	postgres,
	redis,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, arrayContains, desc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { IS_CLOUD } from "../constants";
import { getRemoteDocker } from "../utils/servers/remote-docker";

export type NetworkUsage = {
	type: "application" | "libsql" | "mariadb" | "mongo" | "mysql" | "postgres" | "redis";
	id: string;
	name: string;
}[];

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

export const resolveNetworkNamesForResource = async (
	networkIds: string[] | null | undefined,
	serverId: string | null | undefined,
	organizationId: string,
): Promise<string[]> => {
	if (!networkIds || networkIds.length === 0) return [];
	const rows = await db
		.select({
			name: network.name,
			serverId: network.serverId,
		})
		.from(network)
		.where(
			and(
				inArray(network.networkId, networkIds),
				eq(network.organizationId, organizationId),
			),
		);
	const target = serverId ?? null;
	return rows
		.filter((row) => (row.serverId ?? null) === target)
		.map((row) => row.name);
};

export const assertNetworkIdsBelongToOrg = async (
	networkIds: string[] | null | undefined,
	organizationId: string,
): Promise<void> => {
	if (!networkIds || networkIds.length === 0) return;
	const unique = Array.from(new Set(networkIds));
	const rows = await db
		.select({ id: network.networkId })
		.from(network)
		.where(
			and(
				inArray(network.networkId, unique),
				eq(network.organizationId, organizationId),
			),
		);
	if (rows.length !== unique.length) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "One or more networks do not belong to this organization",
		});
	}
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

	// Docker failure rolls back the row so we never persist a ghost record.
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

export const findResourcesUsingNetwork = async (
	networkId: string,
	organizationId: string,
): Promise<NetworkUsage> => {
	const target = await db.query.network.findFirst({
		where: and(
			eq(network.networkId, networkId),
			eq(network.organizationId, organizationId),
		),
	});
	if (!target) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Network not found" });
	}
	const probes = [
		{ type: "application" as const, table: applications, idCol: applications.applicationId },
		{ type: "libsql" as const, table: libsql, idCol: libsql.libsqlId },
		{ type: "mariadb" as const, table: mariadb, idCol: mariadb.mariadbId },
		{ type: "mongo" as const, table: mongo, idCol: mongo.mongoId },
		{ type: "mysql" as const, table: mysql, idCol: mysql.mysqlId },
		{ type: "postgres" as const, table: postgres, idCol: postgres.postgresId },
		{ type: "redis" as const, table: redis, idCol: redis.redisId },
	];
	const results: NetworkUsage = [];
	for (const { type, table, idCol } of probes) {
		const rows = await db
			.select({ id: idCol, name: table.name })
			.from(table)
			.where(arrayContains(table.networkIds, [networkId]));
		for (const r of rows) results.push({ type, id: r.id, name: r.name });
	}
	return results;
};

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
		// Match by name; Docker's network ID is not persisted (resilient to manual `docker network rm`).
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
