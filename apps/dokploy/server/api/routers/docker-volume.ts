import {
	deleteVolumeFile,
	findServerById,
	getVolumeConfig,
	getVolumes,
	getVolumesSize,
	listVolumeFiles,
	readVolumeFile,
	removeVolume,
	writeVolumeFile,
} from "@dokploy/server";
import { isPrivilegedVolumeRole } from "@dokploy/server/utils/volume-backups/binding";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { createTRPCRouter, withPermission } from "../trpc";

export const volumeNameRegex = /^[a-zA-Z0-9.\-_]+$/;

const volumePathSchema = z
	.string()
	.min(1)
	.max(4096)
	.refine(
		(path) => path.startsWith("/") && !path.includes("\0"),
		"Path must be absolute.",
	);

// A Docker volume name is global to the host: this router lists, reads,
// writes, deletes and removes ANY volume of the server by name, including other
// tenants' volumes and Dokploy's own. docker:read is a plain "may open the
// Docker page" grant that members can hold, so it is not a boundary for that.
// Scoping each call to the caller's own service namespaces would need a
// per-call service lookup, hide every volume no service records (orphans,
// shared infrastructure) and still leave the list itself host-wide, so the
// whole router is owner/admin only instead. The Docker page hides its Volumes
// tab for everybody else.
export const volumeAdminProcedure = withPermission("docker", "read").use(
	({ ctx, next }) => {
		if (!isPrivilegedVolumeRole(ctx.user.role)) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message:
					"Only an organization owner or admin can manage Docker volumes.",
			});
		}
		return next();
	},
);

export const dockerVolumeRouter = createTRPCRouter({
	getVolumes: volumeAdminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			return await getVolumes(input.serverId);
		}),

	getVolumesSize: volumeAdminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			return await getVolumesSize(input.serverId);
		}),

	listVolumeFiles: volumeAdminProcedure
		.input(
			z.object({
				volumeName: z
					.string()
					.min(1)
					.regex(volumeNameRegex, "Invalid volume name."),
				path: volumePathSchema,
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			return await listVolumeFiles(
				input.volumeName,
				input.path,
				input.serverId,
			);
		}),

	readVolumeFile: volumeAdminProcedure
		.input(
			z.object({
				volumeName: z
					.string()
					.min(1)
					.regex(volumeNameRegex, "Invalid volume name."),
				path: volumePathSchema,
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			return await readVolumeFile(input.volumeName, input.path, input.serverId);
		}),

	writeVolumeFile: volumeAdminProcedure
		.input(
			z.object({
				volumeName: z
					.string()
					.min(1)
					.regex(volumeNameRegex, "Invalid volume name."),
				path: volumePathSchema,
				content: z.string(),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			await writeVolumeFile(
				input.volumeName,
				input.path,
				input.content,
				input.serverId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "docker",
				resourceId: input.volumeName,
				resourceName: `${input.volumeName}:${input.path}`,
			});
		}),

	deleteVolumeFile: volumeAdminProcedure
		.input(
			z.object({
				volumeName: z
					.string()
					.min(1)
					.regex(volumeNameRegex, "Invalid volume name."),
				path: volumePathSchema.refine(
					(path) => path !== "/",
					"Cannot delete the volume root.",
				),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			await deleteVolumeFile(input.volumeName, input.path, input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: input.volumeName,
				resourceName: `${input.volumeName}:${input.path}`,
			});
		}),

	getVolumeConfig: volumeAdminProcedure
		.input(
			z.object({
				volumeName: z
					.string()
					.min(1)
					.regex(volumeNameRegex, "Invalid volume name."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			return await getVolumeConfig(input.volumeName, input.serverId);
		}),

	removeVolume: volumeAdminProcedure
		.input(
			z.object({
				volumeName: z
					.string()
					.min(1)
					.regex(volumeNameRegex, "Invalid volume name."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			await removeVolume(input.volumeName, input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: input.volumeName,
				resourceName: input.volumeName,
			});
		}),
});
