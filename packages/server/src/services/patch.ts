import { dirname, join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { type apiCreatePatch, patch } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { quote } from "shell-quote";
import type { z } from "zod";
import {
	getInstallStagedFileCommand,
	getStagedFilePath,
	type StageOptions,
	stageFiles,
} from "../utils/docker/staging";
import { findApplicationById } from "./application";
import { findComposeById } from "./compose";

export type Patch = typeof patch.$inferSelect;

export const createPatch = async (input: z.infer<typeof apiCreatePatch>) => {
	if (!input.applicationId && !input.composeId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Either applicationId or composeId must be provided",
		});
	}

	const newPatch = await db
		.insert(patch)
		.values({
			...input,
			content: input.content,
			enabled: true,
		})
		.returning()
		.then((value) => value[0]);

	if (!newPatch) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the patch",
		});
	}

	return newPatch;
};

export const findPatchById = async (patchId: string) => {
	const result = await db.query.patch.findFirst({
		where: eq(patch.patchId, patchId),
	});

	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Patch not found",
		});
	}

	return result;
};

export const findPatchesByEntityId = async (
	id: string,
	type: "application" | "compose",
) => {
	return await db.query.patch.findMany({
		where: eq(
			type === "application" ? patch.applicationId : patch.composeId,
			id,
		),
		orderBy: (patch, { asc }) => [asc(patch.filePath)],
	});
};

export const findPatchByFilePath = async (
	filePath: string,
	id: string,
	type: "application" | "compose",
) => {
	return await db.query.patch.findFirst({
		where: and(
			eq(patch.filePath, filePath),
			eq(type === "application" ? patch.applicationId : patch.composeId, id),
		),
	});
};

export const updatePatch = async (patchId: string, data: Partial<Patch>) => {
	const result = await db
		.update(patch)
		.set({
			...data,
			...(data.content && {
				content: data.content.endsWith("\n")
					? data.content
					: `${data.content}\n`,
			}),
			updatedAt: new Date().toISOString(),
		})
		.where(eq(patch.patchId, patchId))
		.returning();

	return result[0];
};

export const deletePatch = async (patchId: string) => {
	const result = await db
		.delete(patch)
		.where(eq(patch.patchId, patchId))
		.returning();

	return result[0];
};

export const markPatchForDeletion = async (
	filePath: string,
	entityId: string,
	entityType: "application" | "compose",
) => {
	const existing = await findPatchByFilePath(filePath, entityId, entityType);

	if (existing) {
		return await updatePatch(existing.patchId, { type: "delete", content: "" });
	}

	return await createPatch({
		filePath,
		content: "",
		type: "delete",
		applicationId: entityType === "application" ? entityId : undefined,
		composeId: entityType === "compose" ? entityId : undefined,
	});
};

interface ApplyPatchesOptions {
	id: string;
	type: "application" | "compose";
	serverId: string | null;
}

/**
 * Shell commands that apply the enabled patches to the checkout. Each patch's
 * content is staged out of band (see `utils/docker/staging`) and copied into
 * place: a patch embedded in the script counts toward the 128 KB limit on a
 * single shell argument. The staged files sit next to `code/`, which a clone
 * wipes.
 */
export const generateApplyPatchesCommand = async (
	{ id, type, serverId }: ApplyPatchesOptions,
	options: StageOptions = {},
) => {
	const entity =
		type === "application"
			? await findApplicationById(id)
			: await findComposeById(id);
	const { COMPOSE_PATH, APPLICATIONS_PATH } = paths(!!serverId);
	const basePath = type === "compose" ? COMPOSE_PATH : APPLICATIONS_PATH;
	const codePath = join(basePath, entity.appName, "code");

	const resultPatches = await findPatchesByEntityId(id, type);
	const patches = resultPatches.filter((p) => p.enabled);

	if (patches.length === 0) {
		return "";
	}

	const stageDirectory = join(basePath, entity.appName);
	const written = patches.filter((p) => p.type !== "delete");
	const stagedPaths = written.map((_, index) =>
		getStagedFilePath({
			directory: stageDirectory,
			kind: "patch",
			deploymentId: options.deploymentId,
			index,
		}),
	);
	await stageFiles({
		serverId,
		directory: stageDirectory,
		files: written.map((p, index) => ({
			path: stagedPaths[index] as string,
			content: p.content,
		})),
	});
	if (stagedPaths.length > 0) options.onStaged?.(stagedPaths);

	let command = `echo "Applying ${patches.length} patch(es)...";`;

	let stagedIndex = 0;
	for (const p of patches) {
		const filePath = join(codePath, p.filePath);

		if (p.type === "delete") {
			command += `
			rm -f ${quote([filePath])};
			`;
		} else {
			command += `
${getInstallStagedFileCommand({
	staged: stagedPaths[stagedIndex] as string,
	destination: filePath,
	failureMessage: "❌ Error: Could not write a patch file",
	prepare: `mkdir -p ${quote([dirname(filePath)])}`,
	// A failed patch stops the script: the rest never get consumed.
	alsoRemove: stagedPaths,
})}
`;
			stagedIndex++;
		}
	}

	return command;
};
