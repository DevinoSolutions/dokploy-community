import {
	cleanPatchRepos,
	createPatch,
	deletePatch,
	ensurePatchRepo,
	findApplicationById,
	findComposeById,
	findPatchByFilePath,
	findPatchById,
	findPatchesByEntityId,
	isPatchOnSeveralServices,
	markPatchForDeletion,
	readPatchRepoDirectory,
	readPatchRepoFile,
	updatePatch,
} from "@dokploy/server";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { patchFilePathSchema } from "@dokploy/server/utils/patch-path";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import { assertServerInOrganization } from "@/server/api/utils/server-org-scope";
import {
	apiCreatePatch,
	apiDeletePatch,
	apiFindPatch,
	apiTogglePatchEnabled,
	apiUpdatePatch,
} from "@/server/db/schema";

type PatchServices = { applicationId: string | null; composeId: string | null };

/**
 * Checks `permissions` on the patch's service. A row attached to both an
 * application and a compose passes on either of them, so either owner can
 * reach it (and delete it).
 */
const checkPatchServiceAccess = async (
	ctx: Parameters<typeof checkServicePermissionAndAccess>[0],
	patch: PatchServices,
	permissions: Parameters<typeof checkServicePermissionAndAccess>[2],
) => {
	const serviceIds = [patch.applicationId, patch.composeId].filter(
		(id): id is string => !!id,
	);
	if (serviceIds.length === 0) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Patch has no associated service",
		});
	}
	let firstError: unknown;
	for (const serviceId of serviceIds) {
		try {
			await checkServicePermissionAndAccess(ctx, serviceId, permissions);
			return;
		} catch (error) {
			firstError ??= error;
		}
	}
	throw firstError;
};

/** A row attached to more than one service can only be deleted. */
const assertPatchEditable = (patch: PatchServices & { patchId: string }) => {
	if (isPatchOnSeveralServices(patch)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Patch ${patch.patchId} is attached to more than one service and can only be deleted`,
		});
	}
};

export const patchRouter = createTRPCRouter({
	create: protectedProcedure
		.input(apiCreatePatch)
		.mutation(async ({ input, ctx }) => {
			// The schema already requires exactly one of the two.
			const serviceId = input.applicationId ?? input.composeId;
			if (!serviceId || (input.applicationId && input.composeId)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"A patch belongs to exactly one service: set applicationId or composeId",
				});
			}
			await checkServicePermissionAndAccess(ctx, serviceId, {
				service: ["create"],
			});
			const result = await createPatch(input);
			await audit(ctx, {
				action: "create",
				resourceType: "settings",
				resourceId: result.patchId,
				resourceName: result.filePath,
				metadata: { type: "patch" },
			});
			return result;
		}),

	one: protectedProcedure.input(apiFindPatch).query(async ({ input, ctx }) => {
		const patch = await findPatchById(input.patchId);
		await checkPatchServiceAccess(ctx, patch, { service: ["read"] });
		return patch;
	}),

	byEntityId: protectedProcedure
		.input(
			z.object({ id: z.string(), type: z.enum(["application", "compose"]) }),
		)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				service: ["read"],
			});
			return await findPatchesByEntityId(input.id, input.type);
		}),

	update: protectedProcedure
		.input(apiUpdatePatch)
		.mutation(async ({ input, ctx }) => {
			const patch = await findPatchById(input.patchId);
			await checkPatchServiceAccess(ctx, patch, { service: ["create"] });
			assertPatchEditable(patch);
			const { patchId, ...data } = input;
			const result = await updatePatch(patchId, data);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceId: patchId,
				resourceName: patch.filePath,
				metadata: { type: "patch" },
			});
			return result;
		}),

	delete: protectedProcedure
		.input(apiDeletePatch)
		.mutation(async ({ input, ctx }) => {
			const patch = await findPatchById(input.patchId);
			await checkPatchServiceAccess(ctx, patch, { service: ["delete"] });
			const result = await deletePatch(input.patchId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceId: input.patchId,
				resourceName: patch.filePath,
				metadata: { type: "patch" },
			});
			return result;
		}),

	toggleEnabled: protectedProcedure
		.input(apiTogglePatchEnabled)
		.mutation(async ({ input, ctx }) => {
			const patch = await findPatchById(input.patchId);
			await checkPatchServiceAccess(ctx, patch, { service: ["create"] });
			assertPatchEditable(patch);
			const result = await updatePatch(input.patchId, {
				enabled: input.enabled,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceId: input.patchId,
				resourceName: patch.filePath,
				metadata: { type: "patch", enabled: input.enabled },
			});
			return result;
		}),

	// Repository Operations
	ensureRepo: protectedProcedure
		.input(
			z.object({
				id: z.string(),
				type: z.enum(["application", "compose"]),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				service: ["create"],
			});
			const result = await ensurePatchRepo({
				type: input.type,
				id: input.id,
			});
			await audit(ctx, {
				action: "create",
				resourceType: "settings",
				resourceId: input.id,
				metadata: { type: "ensurePatchRepo", serviceType: input.type },
			});
			return result;
		}),

	readRepoDirectories: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				type: z.enum(["application", "compose"]),
				// Ignored: always the service's own patch repo, on the host
				// `ensureRepo` cloned it to. Kept for the UI.
				repoPath: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				service: ["read"],
			});
			return await readPatchRepoDirectory(input.id, input.type);
		}),

	readRepoFile: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				type: z.enum(["application", "compose"]),
				filePath: patchFilePathSchema,
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				service: ["read"],
			});
			let serverId: string | null = null;
			if (input.type === "application") {
				const app = await findApplicationById(input.id);
				serverId = app.serverId;
			} else {
				const compose = await findComposeById(input.id);
				serverId = compose.serverId;
			}
			const existingPatch = await findPatchByFilePath(
				input.filePath,
				input.id,
				input.type,
			);
			// For delete patches, show current file content from repo (what will be deleted)
			if (existingPatch?.type === "delete") {
				try {
					return await readPatchRepoFile(input.id, input.type, input.filePath);
				} catch {
					return "(File not found in repo - will be removed if it exists)";
				}
			}
			if (existingPatch?.content) {
				return existingPatch.content;
			}
			return await readPatchRepoFile(input.id, input.type, input.filePath);
		}),

	saveFileAsPatch: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				type: z.enum(["application", "compose"]),
				filePath: patchFilePathSchema,
				content: z.string(),
				patchType: z.enum(["create", "update"]).default("update"),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				service: ["create"],
			});
			const existingPatch = await findPatchByFilePath(
				input.filePath,
				input.id,
				input.type,
			);
			if (!existingPatch) {
				const result = await createPatch({
					filePath: input.filePath,
					content: input.content,
					type: input.patchType,
					applicationId: input.type === "application" ? input.id : undefined,
					composeId: input.type === "compose" ? input.id : undefined,
				});
				await audit(ctx, {
					action: "create",
					resourceType: "settings",
					resourceId: result.patchId,
					resourceName: input.filePath,
					metadata: { type: "saveFileAsPatch" },
				});
				return result;
			}
			assertPatchEditable(existingPatch);
			const result = await updatePatch(existingPatch.patchId, {
				content: input.content,
				type: input.patchType,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceId: existingPatch.patchId,
				resourceName: input.filePath,
				metadata: { type: "saveFileAsPatch" },
			});
			return result;
		}),

	markFileForDeletion: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				type: z.enum(["application", "compose"]),
				filePath: patchFilePathSchema,
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				service: ["create"],
			});
			const result = await markPatchForDeletion(
				input.filePath,
				input.id,
				input.type,
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceId: input.id,
				resourceName: input.filePath,
				metadata: { type: "markFileForDeletion" },
			});
			return result;
		}),

	cleanPatchRepos: adminProcedure
		.input(z.object({ serverId: z.string().optional() }))
		.mutation(async ({ input, ctx }) => {
			// Removes the patch repositories directory on `input.serverId` over
			// SSH; `adminProcedure` only proves a role in the caller's active
			// organization, not ownership of the target server.
			await assertServerInOrganization(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			await cleanPatchRepos(input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceId: input.serverId || "local",
				metadata: { type: "cleanPatchRepos" },
			});
			return true;
		}),
});
