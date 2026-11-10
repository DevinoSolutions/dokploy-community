import { posix } from "node:path";
import {
	containerKill,
	containerRemove,
	containerRestart,
	containerStart,
	containerStop,
	deleteContainerFile,
	getConfig,
	getContainers,
	getContainersByAppLabel,
	getContainersByAppNameMatch,
	getDockerEvents,
	getServerHealth as getServerHealthData,
	getServiceContainersByAppName,
	getStackContainersByAppName,
	listContainerFiles,
	readContainerFile,
	uploadFileToContainer,
	writeContainerFile,
} from "@dokploy/server";
import { checkPermission } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	assertAppNameReadable,
	assertServerReachable,
	canReadContainerEnv,
	filterReadableContainers,
	filterReadableEvents,
	filterReadableTasks,
	redactContainerEnv,
	resolveContainerForRoute,
} from "@/server/api/utils/container-service-access";
import { assertLocalHostAccess } from "@/server/api/utils/local-host-access";
import { uploadFileToContainerSchema } from "@/utils/schema";
import { adminProcedure, createTRPCRouter, withPermission } from "../trpc";

export const containerIdRegex = /^[a-zA-Z0-9.\-_]+$/;

const containerPathSchema = z
	.string()
	.min(1)
	.max(4096)
	.refine(
		(path) => path.startsWith("/") && !path.includes("\0"),
		"Path must be absolute.",
	);

// "<service>.<slot>" (a global service has the node id in place of the slot)
const taskService = (row: { name: string }) =>
	row.name.split(".").slice(0, -1).join(".");

const isProcPath = (path: string) => {
	const normalized = posix.normalize(path);
	return normalized === "/proc" || normalized.startsWith("/proc/");
};

export const dockerRouter = createTRPCRouter({
	getContainers: withPermission("docker", "read")
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertServerReachable(ctx, input.serverId);
			const containers = await getContainers(input.serverId);
			return containers
				? await filterReadableContainers(ctx, containers, input.serverId)
				: containers;
		}),

	// Host-level diagnostics of the whole server (every tenant's containers and
	// their restarts), so this requires docker.read AND server.read and is
	// owner/admin only: no service owns it to check a member against. On the
	// local host it is also limited to the organization that owns the instance.
	getServerHealth: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
				sinceHours: z.number().int().min(1).max(168).optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkPermission(ctx, { docker: ["read"], server: ["read"] });
			await assertLocalHostAccess(
				input.serverId,
				ctx.session.activeOrganizationId,
			);
			await assertServerReachable(ctx, input.serverId);
			return await getServerHealthData(
				ctx.session.activeOrganizationId,
				input.serverId,
				input.sinceHours,
			);
		}),

	restartContainer: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const containerId = await resolveContainerForRoute(
				ctx,
				input.containerId,
				input.serverId,
				"write",
			);
			await containerRestart(containerId, input.serverId);
			await audit(ctx, {
				action: "start",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	startContainer: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const containerId = await resolveContainerForRoute(
				ctx,
				input.containerId,
				input.serverId,
				"write",
			);
			await containerStart(containerId, input.serverId);
			await audit(ctx, {
				action: "start",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	stopContainer: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const containerId = await resolveContainerForRoute(
				ctx,
				input.containerId,
				input.serverId,
				"write",
			);
			await containerStop(containerId, input.serverId);
			await audit(ctx, {
				action: "stop",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	killContainer: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const containerId = await resolveContainerForRoute(
				ctx,
				input.containerId,
				input.serverId,
				"write",
			);
			await containerKill(containerId, input.serverId);
			await audit(ctx, {
				action: "stop",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	removeContainer: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const containerId = await resolveContainerForRoute(
				ctx,
				input.containerId,
				input.serverId,
				"write",
			);
			await containerRemove(containerId, input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	getConfig: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const containerId = await resolveContainerForRoute(
				ctx,
				input.containerId,
				input.serverId,
			);
			const config = await getConfig(containerId, input.serverId);
			// the inspect output carries Config.Env, secrets included
			return (await canReadContainerEnv(ctx))
				? config
				: redactContainerEnv(config);
		}),

	getContainersByAppNameMatch: withPermission("service", "read")
		.input(
			z.object({
				appType: z.enum(["stack", "docker-compose"]).optional(),
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertAppNameReadable(ctx, input.appName, input.serverId);
			// the commands behind these routes match more than the appName (a prefix,
			// a substring, an id prefix), so the rows are checked one by one
			const rows = await getContainersByAppNameMatch(
				input.appName,
				input.appType,
				input.serverId,
			);
			return input.appType === "stack"
				? await filterReadableTasks(
						ctx,
						rows,
						// "<service>.<slot>.<task id>"
						(row) => row.name.split(".").slice(0, -2).join("."),
						input.serverId,
					)
				: await filterReadableContainers(ctx, rows, input.serverId, {
						strict: true,
					});
		}),

	getContainersByAppLabel: withPermission("docker", "read")
		.input(
			z.object({
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
				type: z.enum(["standalone", "swarm"]),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertAppNameReadable(ctx, input.appName, input.serverId);
			const rows = await getContainersByAppLabel(
				input.appName,
				input.type,
				input.serverId,
			);
			return rows
				? await filterReadableContainers(ctx, rows, input.serverId, {
						strict: true,
					})
				: rows;
		}),

	getStackContainersByAppName: withPermission("docker", "read")
		.input(
			z.object({
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertAppNameReadable(ctx, input.appName, input.serverId);
			return await filterReadableTasks(
				ctx,
				await getStackContainersByAppName(input.appName, input.serverId),
				taskService,
				input.serverId,
			);
		}),

	getServiceContainersByAppName: withPermission("docker", "read")
		.input(
			z.object({
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertAppNameReadable(ctx, input.appName, input.serverId);
			return await filterReadableTasks(
				ctx,
				await getServiceContainersByAppName(input.appName, input.serverId),
				taskService,
				input.serverId,
			);
		}),

	uploadFileToContainer: withPermission("docker", "read")
		.input(uploadFileToContainerSchema)
		.mutation(async ({ input, ctx }) => {
			const containerId = await resolveContainerForRoute(
				ctx,
				input.containerId,
				input.serverId,
				"write",
			);

			const file = input.file;
			if (!(file instanceof File)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid file provided",
				});
			}

			// Convert File to Buffer
			const arrayBuffer = await file.arrayBuffer();
			const fileBuffer = Buffer.from(arrayBuffer);

			await uploadFileToContainer(
				containerId,
				fileBuffer,
				file.name,
				input.destinationPath,
				input.serverId || null,
			);

			return { success: true, message: "File uploaded successfully" };
		}),

	listContainerFiles: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				path: containerPathSchema,
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const containerId = await resolveContainerForRoute(
				ctx,
				input.containerId,
				input.serverId,
			);
			return await listContainerFiles(containerId, input.path, input.serverId);
		}),

	readContainerFile: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				path: containerPathSchema,
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const containerId = await resolveContainerForRoute(
				ctx,
				input.containerId,
				input.serverId,
			);
			// /proc/<pid>/environ is the process environment, secrets included
			if (isProcPath(input.path) && !(await canReadContainerEnv(ctx))) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message:
						"Reading /proc needs permission to read environment variables.",
				});
			}
			return await readContainerFile(containerId, input.path, input.serverId);
		}),

	writeContainerFile: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				path: containerPathSchema,
				content: z.string(),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const containerId = await resolveContainerForRoute(
				ctx,
				input.containerId,
				input.serverId,
				"write",
			);
			await writeContainerFile(
				containerId,
				input.path,
				input.content,
				input.serverId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: `${input.containerId}:${input.path}`,
			});
		}),

	deleteContainerFile: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				path: containerPathSchema.refine(
					(path) => path !== "/",
					"Cannot delete the container root.",
				),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const containerId = await resolveContainerForRoute(
				ctx,
				input.containerId,
				input.serverId,
				"write",
			);
			await deleteContainerFile(containerId, input.path, input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: `${input.containerId}:${input.path}`,
			});
		}),

	getEvents: withPermission("docker", "read")
		.input(
			z.object({
				serverId: z.string().optional(),
				minutes: z.number().min(1).max(1440).default(15),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertServerReachable(ctx, input.serverId);
			const result = await getDockerEvents(input.serverId, input.minutes);
			// the host's events name every tenant's containers: a member gets the
			// events of the services they can read
			return {
				...result,
				events: await filterReadableEvents(ctx, result.events, input.serverId),
			};
		}),
});
