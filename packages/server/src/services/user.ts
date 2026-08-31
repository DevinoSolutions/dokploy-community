import { db } from "@dokploy/server/db";
import {
	account,
	apikey,
	invitation,
	member,
	passkey,
	user,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import * as bcrypt from "bcrypt";
import { and, desc, eq } from "drizzle-orm";
import { auth } from "../lib/auth";

export type User = typeof user.$inferSelect;

export const canPerformCreationService = async (
	userId: string,
	projectId: string,
	organizationId: string,
) => {
	const { accessedProjects, canCreateServices } = await findMemberById(
		userId,
		organizationId,
	);
	const haveAccessToProject = accessedProjects.includes(projectId);

	if (canCreateServices && haveAccessToProject) {
		return true;
	}

	return false;
};

export const canPerformAccessService = async (
	userId: string,
	serviceId: string,
	organizationId: string,
) => {
	const { accessedServices } = await findMemberById(userId, organizationId);
	const haveAccessToService = accessedServices.includes(serviceId);

	if (haveAccessToService) {
		return true;
	}

	return false;
};

export const canPerformDeleteService = async (
	userId: string,
	serviceId: string,
	organizationId: string,
) => {
	const { accessedServices, canDeleteServices } = await findMemberById(
		userId,
		organizationId,
	);
	const haveAccessToService = accessedServices.includes(serviceId);

	if (canDeleteServices && haveAccessToService) {
		return true;
	}

	return false;
};

export const canPerformCreationProject = async (
	userId: string,
	organizationId: string,
) => {
	const { canCreateProjects } = await findMemberById(userId, organizationId);

	if (canCreateProjects) {
		return true;
	}

	return false;
};

export const canPerformDeleteProject = async (
	userId: string,
	organizationId: string,
) => {
	const { canDeleteProjects } = await findMemberById(userId, organizationId);

	if (canDeleteProjects) {
		return true;
	}

	return false;
};

export const canPerformAccessProject = async (
	userId: string,
	projectId: string,
	organizationId: string,
) => {
	const { accessedProjects } = await findMemberById(userId, organizationId);

	const haveAccessToProject = accessedProjects.includes(projectId);

	if (haveAccessToProject) {
		return true;
	}
	return false;
};

export const canPerformAccessEnvironment = async (
	userId: string,
	environmentId: string,
	organizationId: string,
) => {
	const { accessedEnvironments } = await findMemberById(userId, organizationId);
	const haveAccessToEnvironment = accessedEnvironments.includes(environmentId);

	if (haveAccessToEnvironment) {
		return true;
	}

	return false;
};

export const canPerformDeleteEnvironment = async (
	userId: string,
	projectId: string,
	organizationId: string,
) => {
	const { accessedProjects, canDeleteEnvironments } = await findMemberById(
		userId,
		organizationId,
	);
	const haveAccessToProject = accessedProjects.includes(projectId);

	if (canDeleteEnvironments && haveAccessToProject) {
		return true;
	}

	return false;
};

export const canAccessToTraefikFiles = async (
	userId: string,
	organizationId: string,
) => {
	const { canAccessToTraefikFiles } = await findMemberById(
		userId,
		organizationId,
	);
	return canAccessToTraefikFiles;
};

export const findMemberById = async (
	userId: string,
	organizationId: string,
) => {
	const result = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, organizationId),
		),
		with: {
			user: true,
		},
	});

	if (!result) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Permission denied",
		});
	}
	return result;
};

export const findPasskeysByUserId = async (userId: string) => {
	return db.query.passkey.findMany({
		where: eq(passkey.userId, userId),
		columns: {
			id: true,
			name: true,
			deviceType: true,
			backedUp: true,
			createdAt: true,
			aaguid: true,
		},
		orderBy: [desc(passkey.createdAt)],
	});
};

export const createOrganizationUserWithCredentials = async ({
	organizationId,
	email,
	password,
	role,
}: {
	organizationId: string;
	email: string;
	password: string;
	role: string;
}) => {
	const normalizedEmail = email.trim().toLowerCase();
	const now = new Date();

	return await db.transaction(async (tx) => {
		const existingUser = await tx.query.user.findFirst({
			where: eq(user.email, normalizedEmail),
			columns: {
				id: true,
			},
		});

		if (existingUser) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"This email already has an account. Use the invitation link flow for existing users.",
			});
		}

		const createdUser = await tx
			.insert(user)
			.values({
				email: normalizedEmail,
				emailVerified: true,
				updatedAt: now,
			})
			.returning({
				id: user.id,
				email: user.email,
			})
			.then((res) => res[0]);

		if (!createdUser) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Failed to create user",
			});
		}

		await tx.insert(account).values({
			userId: createdUser.id,
			providerId: "credential",
			password: bcrypt.hashSync(password, 10),
			createdAt: now,
			updatedAt: now,
		});

		await tx.insert(member).values({
			organizationId,
			userId: createdUser.id,
			role,
			createdAt: now,
			isDefault: true,
		});

		await tx
			.update(invitation)
			.set({
				status: "canceled",
			})
			.where(
				and(
					eq(invitation.organizationId, organizationId),
					eq(invitation.email, normalizedEmail),
					eq(invitation.status, "pending"),
				),
			);

		return {
			userId: createdUser.id,
			email: createdUser.email,
			role,
		};
	});
};

export const updateUser = async (userId: string, userData: Partial<User>) => {
	// Validate email if it's being updated
	if (userData.email !== undefined) {
		if (!userData.email || userData.email.trim() === "") {
			throw new Error("Email is required and cannot be empty");
		}

		// Basic email format validation
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(userData.email)) {
			throw new Error("Please enter a valid email address");
		}
	}

	const userResult = await db
		.update(user)
		.set({
			...userData,
		})
		.where(eq(user.id, userId))
		.returning()
		.then((res) => res[0]);

	return userResult;
};

const apiKeyPrefixRegex = /^[A-Za-z0-9_-]+$/;
const apiKeyPrefixErrorMessage =
	"Prefix can only contain ASCII letters, numbers, underscores, and hyphens";

const normalizeApiKeyPrefix = (prefix?: string) => {
	if (prefix === undefined) {
		return undefined;
	}

	const trimmedPrefix = prefix.trim();
	if (trimmedPrefix === "") {
		return undefined;
	}

	if (!apiKeyPrefixRegex.test(trimmedPrefix)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: apiKeyPrefixErrorMessage,
		});
	}

	return trimmedPrefix;
};

export const createApiKey = async (
	userId: string,
	input: {
		name: string;
		prefix?: string;
		expiresIn?: number;
		metadata: {
			organizationId: string;
		};
		rateLimitEnabled?: boolean;
		rateLimitTimeWindow?: number;
		rateLimitMax?: number;
		remaining?: number;
		refillAmount?: number;
		refillInterval?: number;
	},
) => {
	const prefix = normalizeApiKeyPrefix(input.prefix);

	const result = await auth.createApiKey({
		body: {
			name: input.name,
			expiresIn: input.expiresIn,
			prefix,
			rateLimitEnabled: input.rateLimitEnabled,
			rateLimitTimeWindow: input.rateLimitTimeWindow,
			rateLimitMax: input.rateLimitMax,
			remaining: input.remaining,
			refillAmount: input.refillAmount,
			refillInterval: input.refillInterval,
			userId,
		},
	});

	if (input.metadata) {
		await db
			.update(apikey)
			.set({ metadata: JSON.stringify(input.metadata) })
			.where(eq(apikey.id, result.id));
	}

	return result;
};
