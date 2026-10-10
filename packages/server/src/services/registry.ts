import { db } from "@dokploy/server/db";
import {
	type apiCreateRegistry,
	type RegistryLoginData,
	registry,
	server,
} from "@dokploy/server/db/schema";
import { getRegistryConfigDir } from "@dokploy/server/utils/process/dockerConfig";
import { runDockerLogin } from "@dokploy/server/utils/process/dockerLogin";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { IS_CLOUD } from "../constants";
import { getECRAuthToken } from "../utils/aws/ecr";

export type Registry = typeof registry.$inferSelect;

function shEscape(s: string | undefined): string {
	if (!s) return "''";
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sanitizeRegistryError(
	error: unknown,
	password: string | null | undefined,
): string {
	const message =
		error instanceof Error ? error.message : "Error with registry login";
	if (!password) return message;
	return message.split(password).join("***");
}

export const createRegistry = async (
	input: z.infer<typeof apiCreateRegistry>,
	organizationId: string,
) => {
	return await db.transaction(async (tx) => {
		const newRegistry = await tx
			.insert(registry)
			.values({
				...input,
				username: input.username ?? "",
				password: input.password ?? "",
				organizationId: organizationId,
			})
			.returning()
			.then((value) => value[0]);

		if (!newRegistry) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input:  Inserting registry",
			});
		}

		if (IS_CLOUD && !input.serverId && input.serverId !== "none") {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Select a server to add the registry",
			});
		}
		let ecrAuthPassword: string | undefined;
		if (newRegistry.registryType === "awsEcr") {
			const token = await getECRAuthToken({
				awsAccessKeyId: input.awsAccessKeyId || "",
				awsSecretAccessKey: input.awsSecretAccessKey || "",
				awsRegion: input.awsRegion || "",
			});
			ecrAuthPassword = token.password;
		}
		const login: RegistryLoginData = {
			registryType: newRegistry.registryType,
			registryUrl: input.registryUrl,
			username: input.username,
			password: input.password,
			ecrAuthPassword,
		};
		try {
			if (input.serverId && input.serverId !== "none") {
				await runDockerLogin(login, input.serverId);
			} else if (
				newRegistry.registryType === "cloud" ||
				newRegistry.registryType === "awsEcr"
			) {
				await runDockerLogin(login);
			}
		} catch (error) {
			const sanitized = sanitizeRegistryError(error, input.password);
			throw new TRPCError({ code: "BAD_REQUEST", message: sanitized });
		}

		return newRegistry;
	});
};

/**
 * The command that deletes one registry's own docker config dir, or null when
 * the computed path is not exactly `<base>/docker-config/<registryId>`: an odd
 * id must never turn into an `rm -rf` of the parent directory.
 */
export const getRegistryConfigDirRemovalCommand = (
	registryId: string,
	isRemote: boolean,
): string | null => {
	let dir: string;
	try {
		dir = getRegistryConfigDir(registryId, isRemote);
	} catch {
		return null;
	}
	if (
		!registryId ||
		!dir.startsWith("/") ||
		!dir.endsWith(`/docker-config/${registryId}`)
	) {
		return null;
	}
	return `rm -rf -- ${shEscape(dir)}`;
};

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/**
 * Deletes the per-registry docker config dir (it holds that registry's login)
 * from this host and from every server of the organization. Best effort: a
 * host that cannot be reached is logged and skipped.
 */
const removeRegistryConfigDirs = async (
	registryId: string,
	organizationId: string,
) => {
	const local = getRegistryConfigDirRemovalCommand(registryId, false);
	const remote = getRegistryConfigDirRemovalCommand(registryId, true);
	if (!local || !remote) {
		console.error(`Skipping docker config cleanup for registry ${registryId}`);
		return;
	}

	const tasks: Promise<unknown>[] = [];
	if (!IS_CLOUD) {
		tasks.push(
			execAsync(local).catch((error) => {
				console.error(
					`Failed to remove the docker config dir of registry ${registryId}:`,
					errorText(error),
				);
			}),
		);
	}
	try {
		const servers = await db.query.server.findMany({
			where: eq(server.organizationId, organizationId),
			columns: { serverId: true },
		});
		for (const { serverId } of servers) {
			tasks.push(
				execAsyncRemote(serverId, remote).catch((error) => {
					console.error(
						`Failed to remove the docker config dir of registry ${registryId} on server ${serverId}:`,
						errorText(error),
					);
				}),
			);
		}
	} catch (error) {
		console.error(
			`Failed to list servers for the docker config cleanup of registry ${registryId}:`,
			errorText(error),
		);
	}
	await Promise.all(tasks);
};

export const removeRegistry = async (registryId: string) => {
	let response: Registry;
	try {
		const deleted = await db
			.delete(registry)
			.where(eq(registry.registryId, registryId))
			.returning()
			.then((res) => res[0]);

		if (!deleted) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Registry not found",
			});
		}
		response = deleted;
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error removing this registry",
			cause: error,
		});
	}

	// The row is gone: nothing below may turn that into a failure.
	if (!IS_CLOUD) {
		try {
			// The default config still feeds swarm --with-registry-auth.
			await execAsync(`docker logout ${shEscape(response.registryUrl)}`);
		} catch (error) {
			console.error(
				`Failed to log out of ${response.registryUrl}:`,
				errorText(error),
			);
		}
	}
	await removeRegistryConfigDirs(response.registryId, response.organizationId);

	return response;
};

export const updateRegistry = async (
	registryId: string,
	registryData: Partial<Registry> & { serverId?: string | null },
) => {
	try {
		const response = await db
			.update(registry)
			.set({
				...registryData,
			})
			.where(eq(registry.registryId, registryId))
			.returning()
			.then((res) => res[0]);

		let ecrAuthPassword: string | undefined;
		if (response?.registryType === "awsEcr") {
			const token = await getECRAuthToken({
				awsAccessKeyId: response.awsAccessKeyId || "",
				awsSecretAccessKey: response.awsSecretAccessKey || "",
				awsRegion: response.awsRegion || "",
			});
			ecrAuthPassword = token.password;
		}
		const login: RegistryLoginData = {
			registryType: response?.registryType || "cloud",
			registryUrl: response?.registryUrl || undefined,
			username: response?.username || undefined,
			password: response?.password || undefined,
			ecrAuthPassword,
		};

		if (
			IS_CLOUD &&
			!registryData?.serverId &&
			registryData?.serverId !== "none"
		) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Select a server to add the registry",
			});
		}

		try {
			if (registryData?.serverId && registryData?.serverId !== "none") {
				await runDockerLogin(login, registryData.serverId);
			} else if (
				response?.registryType === "cloud" ||
				response?.registryType === "awsEcr"
			) {
				await runDockerLogin(login);
			}
		} catch (execError) {
			throw new Error(sanitizeRegistryError(execError, response?.password));
		}

		return response;
	} catch (error) {
		const message =
			error instanceof TRPCError
				? error.message
				: error instanceof Error
					? error.message
					: "Error updating this registry";
		throw new TRPCError({
			code: "BAD_REQUEST",
			message,
		});
	}
};

/**
 * Finds a registry by ID, intentionally excluding secrets (password, awsSecretAccessKey).
 * Used for API responses and authorization checks where secrets are not needed.
 * Code that needs secrets (login, deploy) should query the DB directly or
 * use application relations which include all fields.
 */
export const findRegistryById = async (registryId: string) => {
	const registryResponse = await db.query.registry.findFirst({
		where: eq(registry.registryId, registryId),
		columns: {
			password: false,
			awsSecretAccessKey: false,
		},
	});
	if (!registryResponse) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Registry not found",
		});
	}
	return registryResponse;
};

export const findRegistryByIdWithCredentials = async (registryId: string) => {
	const registryResponse = await db.query.registry.findFirst({
		where: eq(registry.registryId, registryId),
	});
	if (!registryResponse) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Registry not found",
		});
	}
	return registryResponse;
};

export const findAllRegistryByOrganizationId = async (
	organizationId: string,
) => {
	const registryResponse = await db.query.registry.findMany({
		where: eq(registry.organizationId, organizationId),
		columns: {
			password: false,
			awsSecretAccessKey: false,
		},
	});
	return registryResponse;
};
