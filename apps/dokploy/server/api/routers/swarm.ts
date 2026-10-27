import {
	getAllContainerStats,
	getApplicationInfo,
	getNodeApplications,
	getNodeInfo,
	getSwarmNodes,
} from "@dokploy/server";
import { z } from "zod";
import {
	assertAppNameReadable,
	assertServerReachable,
	canUseHostOwnContainers,
	filterReadableServiceRows,
	filterReadableStats,
} from "@/server/api/utils/container-service-access";
import { assertLocalHostAccess } from "@/server/api/utils/local-host-access";
import { adminProcedure, createTRPCRouter, withPermission } from "../trpc";
import { containerIdRegex } from "./docker";

// "<service>.<slot>" (a global service has the node id in place of the slot)
const taskService = (row: { Name: string }) =>
	row.Name.split(".").slice(0, -1).join(".");

// Nodes belong to the cluster, not to a service: their hostnames, addresses and
// labels are the same for every tenant, so there is nothing to scope a member
// to. The node routes are owner/admin only (adminProcedure; owners and admins
// always hold docker:read) and the Docker page hides the Overview and Nodes
// tabs for everybody else. On the local host they are also limited to the
// organization that owns the instance. The service, task and stats routes name
// services, so a member gets the rows of the services they can read on the
// server, and so does an owner or admin of another organization on the local
// host (the host's own rows are the instance's).
export const swarmRouter = createTRPCRouter({
	getNodes: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertLocalHostAccess(
				input.serverId,
				ctx.session.activeOrganizationId,
			);
			await assertServerReachable(ctx, input.serverId);
			return await getSwarmNodes(input.serverId);
		}),
	getNodeInfo: adminProcedure
		.input(z.object({ nodeId: z.string(), serverId: z.string().optional() }))
		.query(async ({ input, ctx }) => {
			await assertLocalHostAccess(
				input.serverId,
				ctx.session.activeOrganizationId,
			);
			await assertServerReachable(ctx, input.serverId);
			return await getNodeInfo(input.nodeId, input.serverId);
		}),
	getNodeApps: withPermission("docker", "read")
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertServerReachable(ctx, input.serverId);
			const services = await getNodeApplications(input.serverId);
			return services
				? await filterReadableServiceRows(
						ctx,
						services,
						(service) => service.Name,
						input.serverId,
					)
				: services;
		}),
	getAppInfos: withPermission("docker", "read")
		.meta({
			openapi: {
				path: "/drop-deployment",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(
			z.object({
				appName: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid app name.")
					// the names go to `docker service ps`, which takes flags
					.refine((name) => !name.startsWith("-"), "Invalid app name.")
					.array()
					.max(500),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertServerReachable(ctx, input.serverId);
			if (await canUseHostOwnContainers(ctx, input.serverId))
				return await getApplicationInfo(input.appName, input.serverId);

			// a member, or an owner or admin of an organization that does not own
			// the instance on the local host, is asked about the services they can
			// read; the rest are left out of the command instead of failing the
			// whole page
			const readable: string[] = [];
			for (const appName of new Set(input.appName)) {
				try {
					await assertAppNameReadable(ctx, appName, input.serverId);
					readable.push(appName);
				} catch {
					// not a service of theirs
				}
			}
			const tasks = await getApplicationInfo(readable, input.serverId);
			return tasks
				? await filterReadableServiceRows(
						ctx,
						tasks,
						taskService,
						input.serverId,
					)
				: tasks;
		}),
	getContainerStats: withPermission("docker", "read")
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertServerReachable(ctx, input.serverId);
			const stats = await getAllContainerStats(input.serverId);
			// `docker stats` lists every container on the host, which several
			// organizations can share: owners and admins are checked too, so they
			// keep their organization's containers and the host's own, and lose
			// the containers of every other organization.
			return stats
				? await filterReadableStats(ctx, stats, input.serverId)
				: stats;
		}),
});
