import { db } from "@dokploy/server/db";
import {
	invitation,
	member,
	organization,
	user,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { IS_CLOUD } from "../constants";
import { sendDockerCleanupNotifications } from "../utils/notifications/docker-cleanup";
import { scrubDeploymentCancelAuditActorEmail } from "./deployment-cancel-audit";
import { removeOrganizationNotifications } from "./notification-channels";
import { getWebServerSettings } from "./web-server-settings";

export const findUserById = async (userId: string) => {
	const userResult = await db.query.user.findFirst({
		where: eq(user.id, userId),
		// with: {
		// 	account: true,
		// },
	});
	if (!userResult) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "User not found",
		});
	}
	return userResult;
};

export const findOrganizationById = async (organizationId: string) => {
	const organizationResult = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		with: {
			owner: true,
		},
	});
	return organizationResult;
};

export const isAdminPresent = async () => {
	const admin = await db.query.member.findFirst({
		where: eq(member.role, "owner"),
	});

	if (!admin) {
		return false;
	}
	return true;
};

// The organization that owns a self-hosted instance: the one named by
// DOKPLOY_ROOT_ORGANIZATION_ID when that is set, otherwise the first one
// created, which is the one made at the first signup. findOwner can't say,
// since every organization has an owner. A pinned id that matches no
// organization gives no root at all rather than the oldest one, so the
// host-level guards refuse everyone until it is fixed.
const pinnedRootOrganizationId = () =>
	process.env.DOKPLOY_ROOT_ORGANIZATION_ID?.trim() || undefined;

let missingPinnedLogged = false;

export const findRootOrganization = async () => {
	const pinned = pinnedRootOrganizationId();
	if (pinned) {
		const found = await db.query.organization.findFirst({
			columns: { id: true, name: true },
			where: eq(organization.id, pinned),
		});
		if (!found && !missingPinnedLogged) {
			missingPinnedLogged = true;
			console.error(
				`root organization: ${pinned} not found (source: env), host-level settings are refused`,
			);
		}
		return found ?? null;
	}
	return db.query.organization.findFirst({
		columns: { id: true, name: true },
		orderBy: (organization, { asc }) => [
			asc(organization.createdAt),
			asc(organization.id),
		],
	});
};

// Once at server start: which organization the host-level guards will accept.
export const logRootOrganization = async () => {
	if (IS_CLOUD) {
		return;
	}
	const root = await findRootOrganization();
	if (root) {
		console.log(
			`root organization: ${root.id} ${JSON.stringify(root.name)} (source: ${pinnedRootOrganizationId() ? "env" : "first-created"})`,
		);
	}
};

export const isRootOrganization = async (organizationId: string) => {
	const root = await findRootOrganization();
	return !!root && !!organizationId && root.id === organizationId;
};

// A row that belongs to no organization can only be attributed to the owner of
// the instance when the instance has just the one organization, and that
// organization is the root one (a pinned id that matches nothing leaves none).
export const isSingleOrganizationInstance = async () =>
	(await db.query.organization.findMany({ columns: { id: true }, limit: 2 }))
		.length === 1 && !!(await findRootOrganization());

export const PINNED_ROOT_ORGANIZATION_MISSING_HOST_MESSAGE =
	"DOKPLOY_ROOT_ORGANIZATION_ID names an organization that doesn't exist, so host-level settings are turned off. Set it to an existing organization's id on the Dokploy service, or remove it.";

// The message for a refused host-level request: a pinned id that matches no
// organization is what refuses everyone then, so say that rather than blaming
// the caller. Only a refusal pays for the lookup, and an instance without a
// pinned id never does.
export const describeHostAccessRefusal = async (message: string) =>
	pinnedRootOrganizationId() && !(await findRootOrganization())
		? PINNED_ROOT_ORGANIZATION_MISSING_HOST_MESSAGE
		: message;

export const ROOT_ORGANIZATION_DELETE_MESSAGE =
	"This organization owns the Dokploy instance and can't be deleted";

export const PINNED_ROOT_ORGANIZATION_MISSING_DELETE_MESSAGE =
	"DOKPLOY_ROOT_ORGANIZATION_ID names no organization, so organizations can't be deleted until it is fixed";

// Deleting the root organization would hand the instance's own Traefik and
// settings to the next-oldest one. While a pinned id matches no organization
// there is no root to protect, so no organization can be deleted: otherwise
// the one that owned the instance before the pin could be. Dokploy Cloud has
// no such organization.
export const assertOrganizationDeletable = async (organizationId: string) => {
	if (IS_CLOUD) {
		return;
	}
	const root = await findRootOrganization();
	if (!root && pinnedRootOrganizationId()) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: PINNED_ROOT_ORGANIZATION_MISSING_DELETE_MESSAGE,
		});
	}
	if (root && root.id === organizationId) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: ROOT_ORGANIZATION_DELETE_MESSAGE,
		});
	}
};

// The web server's Docker cleanup is reported to the organization that owns
// the instance, and to nobody when none does.
export const sendWebServerDockerCleanupNotifications = async () => {
	if (IS_CLOUD) {
		return;
	}
	const root = await findRootOrganization();
	if (root) {
		await sendDockerCleanupNotifications(root.id);
	}
};

// The owner of the instance: the owner of the root organization, or the
// oldest owner when there is none. Several organizations each have an owner,
// so an unordered lookup could answer with any of them.
export const findOwner = async () => {
	const root = await findRootOrganization();
	const rootOwner = root
		? await db.query.member.findFirst({
				where: and(
					eq(member.role, "owner"),
					eq(member.organizationId, root.id),
				),
				orderBy: (member, { asc }) => [asc(member.createdAt), asc(member.id)],
				with: {
					user: true,
				},
			})
		: undefined;

	const admin =
		rootOwner ??
		(await db.query.member.findFirst({
			where: eq(member.role, "owner"),
			orderBy: (member, { asc }) => [asc(member.createdAt), asc(member.id)],
			with: {
				user: true,
			},
		}));

	if (!admin) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Admin not found",
		});
	}
	return admin;
};

export const getUserByToken = async (token: string) => {
	const userResult = await db.query.invitation.findFirst({
		where: eq(invitation.id, token),
		columns: {
			id: true,
			email: true,
			status: true,
			expiresAt: true,
			role: true,
			inviterId: true,
		},
	});

	if (!userResult) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Invitation not found",
		});
	}

	const userAlreadyExists = await db.query.user.findFirst({
		where: eq(user.email, userResult?.email || ""),
	});

	const { expiresAt, ...rest } = userResult;
	return {
		...rest,
		isExpired: userResult.expiresAt < new Date(),
		userAlreadyExists: !!userAlreadyExists,
	};
};

export const removeUserById = async (userId: string) => {
	await db.transaction(async (tx) => {
		// The organizations the user owns are deleted with them, and so is
		// everything the notification provider rows keep (API keys, webhooks).
		const owned = await tx
			.select({ id: organization.id })
			.from(organization)
			.where(eq(organization.ownerId, userId));
		// Checked before anything is removed, for every organization the user
		// owns: deleting the user cascades into them.
		for (const { id } of owned) {
			await assertOrganizationDeletable(id);
		}
		for (const { id } of owned) {
			await removeOrganizationNotifications(id, tx);
		}
		// The trail keeps the user id but not the email of a deleted user.
		await scrubDeploymentCancelAuditActorEmail(userId, tx);
		await tx
			.delete(user)
			.where(eq(user.id, userId))
			.returning()
			.then((res) => res[0]);
	});
};

export const getDokployUrl = async () => {
	if (IS_CLOUD) {
		return "https://app.dokploy.com";
	}
	const settings = await getWebServerSettings();

	if (settings?.host) {
		const protocol = settings?.https ? "https" : "http";
		return `${protocol}://${settings?.host}`;
	}
	return `http://${settings?.serverIp}:${process.env.PORT}`;
};

const TRUSTED_ORIGINS_CACHE_TTL_MS = 30 * 60_000;
let trustedOriginsCache: { data: string[]; expiresAt: number } | null = null;

export const invalidateTrustedOriginsCache = () => {
	trustedOriginsCache = null;
};

export const getTrustedOrigins = async () => {
	const runQuery = async () => {
		const rows = await db
			.select({ trustedOrigins: user.trustedOrigins })
			.from(member)
			.innerJoin(user, eq(member.userId, user.id))
			.where(eq(member.role, "owner"));
		return Array.from(new Set(rows.flatMap((r) => r.trustedOrigins ?? [])));
	};

	if (IS_CLOUD) {
		const now = Date.now();
		if (trustedOriginsCache && now < trustedOriginsCache.expiresAt) {
			return trustedOriginsCache.data;
		}
		try {
			const trustedOrigins = await runQuery();
			trustedOriginsCache = {
				data: trustedOrigins,
				expiresAt: now + TRUSTED_ORIGINS_CACHE_TTL_MS,
			};
			return trustedOrigins;
		} catch (error) {
			console.error("Failed to fetch trusted origins:", error);
			return trustedOriginsCache?.data ?? [];
		}
	}

	try {
		return await runQuery();
	} catch (error) {
		console.error("Failed to fetch trusted origins:", error);
		return [];
	}
};

export const getTrustedProviders = async () => {
	try {
		const providers = await db.query.ssoProvider.findMany();
		return providers.map((provider) => provider.providerId);
	} catch (error) {
		return [];
	}
};
