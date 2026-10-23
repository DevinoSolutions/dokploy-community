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
	filterReadableContainers,
	resolveContainerForRoute,
} from "@/server/api/utils/container-service-access";
import { uploadFileToContainerSchema } from "@/utils/schema";
import { createTRPCRouter, protectedProcedure, withPermission } from "../trpc";

export const containerIdRegex = /^[a-zA-Z0-9.\-_]+$/;

const containerPathSchema = z
	.string()
	.min(1)
	.max(4096)
	.refine(
		(path) => path.startsWith("/") && !path.includes("\0"),
		"Path must be absolute.",
	);

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

	// Host-level diagnostics, so this requires docker.read AND server.read.
	getServerHealth: protectedProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
				sinceHours: z.number().int().min(1).max(168).optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkPermission(ctx, { docker: ["read"], server: ["read"] });
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
			return await getConfig(containerId, input.serverId);
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
			return await getContainersByAppNameMatch(
				input.appName,
				input.appType,
				input.serverId,
			);
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
			return await getContainersByAppLabel(
				input.appName,
				input.type,
				input.serverId,
			);
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
			return await getStackContainersByAppName(input.appName, input.serverId);
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
			return await getServiceContainersByAppName(input.appName, input.serverId);
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
			return await getDockerEvents(input.serverId, input.minutes);
		}),
});
