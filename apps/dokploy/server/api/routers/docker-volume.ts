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
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { assertLocalHostAccess } from "@/server/api/utils/local-host-access";
import { adminProcedure, createTRPCRouter } from "../trpc";

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
// whole router is owner/admin only instead (adminProcedure; owners and admins
// always hold docker:read). Owners and admins still reach host-global volumes
// here. The Docker page hides its Volumes tab for everybody else.
//
// With no serverId the volumes are the Dokploy host's own, Dokploy's database
// among them, so they belong to the organization that owns the instance. A
// remote server needs to belong to the caller's organization.
const assertVolumeHostAccess = async (
	serverId: string | undefined,
	organizationId: string | undefined,
) => {
	if (!serverId) {
		await assertLocalHostAccess(undefined, organizationId);
		return;
	}
	const server = await findServerById(serverId);
	if (server.organizationId !== organizationId) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
};

export const dockerVolumeRouter = createTRPCRouter({
	getVolumes: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertVolumeHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			return await getVolumes(input.serverId);
		}),

	getVolumesSize: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertVolumeHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			return await getVolumesSize(input.serverId);
		}),

	listVolumeFiles: adminProcedure
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
			await assertVolumeHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			return await listVolumeFiles(
				input.volumeName,
				input.path,
				input.serverId,
			);
		}),

	readVolumeFile: adminProcedure
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
			await assertVolumeHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			return await readVolumeFile(input.volumeName, input.path, input.serverId);
		}),

	writeVolumeFile: adminProcedure
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
			await assertVolumeHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
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

	deleteVolumeFile: adminProcedure
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
			await assertVolumeHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			await deleteVolumeFile(input.volumeName, input.path, input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: input.volumeName,
				resourceName: `${input.volumeName}:${input.path}`,
			});
		}),

	getVolumeConfig: adminProcedure
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
			await assertVolumeHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			return await getVolumeConfig(input.volumeName, input.serverId);
		}),

	removeVolume: adminProcedure
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
			await assertVolumeHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			await removeVolume(input.volumeName, input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: input.volumeName,
				resourceName: input.volumeName,
			});
		}),
});
