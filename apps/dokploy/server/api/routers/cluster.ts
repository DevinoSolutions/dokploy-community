import {
	type DockerNode,
	execAsync,
	execAsyncRemote,
	findServerById,
	getRemoteDocker,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { assertServerReachable } from "@/server/api/utils/container-service-access";
import { assertLocalHostAccess } from "@/server/api/utils/local-host-access";
import { getLocalServerIp } from "@/server/wss/terminal";
import { adminProcedure, createTRPCRouter } from "../trpc";

export const clusterRouter = createTRPCRouter({
	// The swarm nodes belong to the cluster, not to a service: owner/admin only,
	// like swarm.getNodes. With no serverId they are the local swarm's, which
	// belongs to the organization that owns the instance.
	getNodes: adminProcedure
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
			const docker = await getRemoteDocker(input.serverId);
			const workers: DockerNode[] = await docker.listNodes();
			return workers;
		}),

	// The join tokens (addWorker, addManager) and node removal are the cluster's,
	// not a service's: with no serverId they act on the local swarm, whose manager
	// token is a host-wide secret. Owner/admin only (who hold server:create and
	// server:delete), and a server the caller can reach.
	removeWorker: adminProcedure
		.input(
			z.object({
				nodeId: z.string(),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertLocalHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			await assertServerReachable(ctx, input.serverId);
			try {
				const drainCommand = `docker node update --availability drain ${quote([input.nodeId])}`;
				const removeCommand = `docker node rm ${quote([input.nodeId])} --force`;

				if (input.serverId) {
					await execAsyncRemote(input.serverId, drainCommand);
					await execAsyncRemote(input.serverId, removeCommand);
				} else {
					await execAsync(drainCommand);
					await execAsync(removeCommand);
				}
				await audit(ctx, {
					action: "delete",
					resourceType: "cluster",
					resourceId: input.nodeId,
					resourceName: input.nodeId,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Error removing the node",
					cause: error,
				});
			}
		}),

	addWorker: adminProcedure
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
			const docker = await getRemoteDocker(input.serverId);
			const result = await docker.swarmInspect();
			const docker_version = await docker.version();
			const info = await docker.info();

			const swarmNodeAddr = info?.Swarm?.NodeAddr;
			let ip = swarmNodeAddr || (await getLocalServerIp());
			if (!swarmNodeAddr && input.serverId) {
				const server = await findServerById(input.serverId);
				ip = server?.ipAddress;
			}

			return {
				command: `docker swarm join --token ${result.JoinTokens.Worker} ${ip}:2377`,
				version: docker_version.Version,
			};
		}),

	addManager: adminProcedure
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
			const docker = await getRemoteDocker(input.serverId);
			const result = await docker.swarmInspect();
			const docker_version = await docker.version();
			const info = await docker.info();

			const swarmNodeAddr = info?.Swarm?.NodeAddr;
			let ip = swarmNodeAddr || (await getLocalServerIp());
			if (!swarmNodeAddr && input.serverId) {
				const server = await findServerById(input.serverId);
				ip = server?.ipAddress;
			}
			return {
				command: `docker swarm join --token ${result.JoinTokens.Manager} ${ip}:2377`,
				version: docker_version.Version,
			};
		}),
});
