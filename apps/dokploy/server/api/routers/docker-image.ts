import { getImageConfig, getImages, removeImage } from "@dokploy/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { assertServerReachable } from "@/server/api/utils/container-service-access";
import { assertLocalHostAccess } from "@/server/api/utils/local-host-access";
import { adminProcedure, createTRPCRouter } from "../trpc";

// An image is not owned by a service: the list, the inspect output (the
// environment and history baked into the image) and `docker rmi` all act on
// every image of the host, other tenants' and Dokploy's own included. docker:read
// is a plain "may open the Docker page" grant that members can hold, so it is
// not a boundary for that and there is no service to check a member against.
// The whole router is owner/admin only instead (adminProcedure; owners and
// admins always hold docker:read), and the Docker page hides its Images tab for
// everybody else. On the local host the router is also limited to the
// organization that owns the instance.
export const dockerImageRouter = createTRPCRouter({
	getImages: adminProcedure
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
			return await getImages(input.serverId);
		}),

	getImageConfig: adminProcedure
		.input(
			z.object({
				imageRef: z.string().min(1),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertLocalHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			await assertServerReachable(ctx, input.serverId);
			return await getImageConfig(input.imageRef, input.serverId);
		}),

	removeImage: adminProcedure
		.input(
			z.object({
				repository: z.string(),
				tag: z.string(),
				id: z.string().min(1),
				force: z.boolean().optional(),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertLocalHostAccess(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			await assertServerReachable(ctx, input.serverId);
			await removeImage(
				{
					repository: input.repository,
					tag: input.tag,
					id: input.id,
					force: input.force,
				},
				input.serverId,
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: input.id,
				resourceName:
					input.repository !== "<none>" && input.tag !== "<none>"
						? `${input.repository}:${input.tag}`
						: input.id,
			});
		}),
});
