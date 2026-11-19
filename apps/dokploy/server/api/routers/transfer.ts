import {
	getAccessibleServerIds,
	IS_CLOUD,
	previewTransfer,
	transferService,
} from "@dokploy/server";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { isPrivilegedVolumeRole } from "@dokploy/server/utils/volume-backups/binding";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import { canAccessLocalHost } from "@/server/api/utils/local-host-access";
import { apiTransferPreflight, apiTransferService } from "@/server/db/schema";

type TransferContext = Parameters<typeof checkServicePermissionAndAccess>[0] & {
	user: { role?: string | null };
};

// Who may start a transfer, and what the caller may do on the hosts it
// touches. The pre-flight asks the same questions as the transfer: it reads the
// target server and what the service holds, so it is as restricted.
const authorizeTransfer = async (
	ctx: TransferContext,
	input: { serviceId: string; targetServerId: string | null },
) => {
	await checkServicePermissionAndAccess(ctx, input.serviceId, {
		service: ["create"],
		deployment: ["create"],
	});
	if (input.targetServerId) {
		const accessibleIds = await getAccessibleServerIds(ctx.session);
		if (!accessibleIds.has(input.targetServerId)) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You don't have access to the target server",
			});
		}
	} else if (IS_CLOUD) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The Dokploy server is not available as a target",
		});
	}
	const privilegedRole = isPrivilegedVolumeRole(ctx.user.role);
	return {
		privilegedRole,
		localHostReach: await canAccessLocalHost(
			undefined,
			ctx.session.activeOrganizationId,
		),
	};
};

export const transferRouter = createTRPCRouter({
	preflight: protectedProcedure
		.meta({
			openapi: {
				path: "/transfer/preflight",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(apiTransferPreflight)
		.query(async ({ input, ctx }) => {
			const caller = await authorizeTransfer(ctx, input);
			return await previewTransfer({
				...input,
				organizationId: ctx.session.activeOrganizationId,
				caller,
			});
		}),
	start: protectedProcedure
		.meta({
			openapi: {
				path: "/transfer/start",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(apiTransferService)
		.subscription(async function* ({ input, ctx, signal }) {
			const caller = await authorizeTransfer(ctx, input);

			const queue: string[] = [];
			let done = false;
			const log = (line: string) => queue.push(line);

			const run = async () => {
				const result = await transferService(
					{
						...input,
						organizationId: ctx.session.activeOrganizationId,
						caller,
					},
					log,
				);
				await audit(ctx, {
					action: "move",
					resourceType: "service",
					resourceId: input.serviceId,
					resourceName: result.appName,
					metadata: { targetServerId: input.targetServerId },
				});
			};

			run()
				.then(() => log("Transfer completed successfully!"))
				.catch((error) => {
					log(
						`Transfer failed ❌ ${error instanceof Error ? error.message : String(error)}`,
					);
				})
				.finally(() => {
					done = true;
				});

			while (!done || queue.length > 0) {
				if (queue.length > 0) {
					yield queue.shift()!;
				} else {
					await new Promise((r) => setTimeout(r, 50));
				}

				if (signal?.aborted) {
					return;
				}
			}
		}),
});
