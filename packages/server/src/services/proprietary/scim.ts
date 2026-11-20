import { createHmac } from "node:crypto";
import type {
	SCIMIdentityState,
	SCIMOptions,
	SCIMProjectedUserState,
	SCIMScope,
	SCIMTransactionContext,
} from "@better-auth/scim";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { member, user } from "../../db/schema";
import { betterAuthSecret } from "../../lib/auth-secret";
import { resolveOrganizationDefaultRole } from "./license-key";

/**
 * SCIM provisioning on better-auth 1.7.
 *
 * Each SCIM connection is a plugin-managed connection (`managedConnections`)
 * whose provisioning domain is a Dokploy organization id. An organization
 * owner or admin creates it from Settings → SSO → Manage SCIM; the tRPC router
 * (apps/dokploy/server/api/routers/proprietary/scim.ts) authorizes the caller
 * against the organization before calling the plugin's server-only APIs, which
 * have no HTTP route.
 *
 * The plugin keeps directory state in its own tables and calls back here:
 * - `projection.reconcileUser` makes an active provisioned user a member of
 *   the connection's organization, with the organization's default role (the
 *   role SCIM users received on 1.6). SCIM never grants or changes `owner`,
 *   and never demotes a role an admin assigned by hand.
 * - `identity.reconcileUser` bans a user once every SCIM source deactivated or
 *   deleted them, and lifts that ban (only that ban) when one is active again.
 *   The plugin itself only deletes the user's sessions, which would not stop a
 *   new sign-in.
 */

export const SCIM_ALL_SCOPES: readonly SCIMScope[] = [
	"scim.users.read",
	"scim.users.write",
	"scim.groups.read",
	"scim.groups.write",
];

/** Ban reason that marks a ban as owned by SCIM lifecycle reconciliation. */
export const SCIM_DEPROVISIONED_BAN_REASON =
	"Deactivated by SCIM provisioning";

/**
 * HMAC key for the plugin's stored credential digests. An explicit
 * DOKPLOY_SCIM_CREDENTIAL_HASH_SECRET wins; otherwise it is derived from the
 * auth secret, so rotating that secret (scripts/migrate-auth-secret) requires
 * re-issuing SCIM tokens.
 */
export const getScimCredentialHashSecret = (
	env: Record<string, string | undefined> = process.env,
) => {
	const explicit = env.DOKPLOY_SCIM_CREDENTIAL_HASH_SECRET;
	if (explicit && explicit.length >= 32) return explicit;
	return createHmac("sha256", betterAuthSecret)
		.update("dokploy:scim-credential-hash:v1")
		.digest("hex");
};

/**
 * Organization membership for an active provisioned user. Idempotent: an
 * existing membership keeps its role.
 */
export const reconcileScimMembership = async (
	state: Pick<SCIMProjectedUserState, "provisioningDomainId" | "userId" | "active">,
	{ database }: SCIMTransactionContext,
) => {
	if (!state.active) return;
	const organizationId = state.provisioningDomainId;
	const existing = await database.findOne<{ id: string }>({
		model: "member",
		where: [
			{ field: "userId", value: state.userId },
			{ field: "organizationId", value: organizationId },
		],
	});
	if (existing) return;
	const role = await resolveOrganizationDefaultRole(organizationId);
	const hasDefault = await database.findOne<{ id: string }>({
		model: "member",
		where: [
			{ field: "userId", value: state.userId },
			{ field: "isDefault", value: true },
		],
	});
	await database.create({
		model: "member",
		data: {
			organizationId,
			userId: state.userId,
			role,
			createdAt: new Date(),
			isDefault: !hasDefault,
		},
	});
};

/** Global sign-in state of a provisioned user. */
export const reconcileScimLifecycle = async (
	state: Pick<SCIMIdentityState, "userId" | "active">,
	{ database }: SCIMTransactionContext,
) => {
	const current = await database.findOne<{
		banned: boolean | null;
		banReason: string | null;
	}>({
		model: "user",
		where: [{ field: "id", value: state.userId }],
	});
	if (!current) return;
	if (!state.active && !current.banned) {
		await database.update({
			model: "user",
			where: [{ field: "id", value: state.userId }],
			update: { banned: true, banReason: SCIM_DEPROVISIONED_BAN_REASON },
		});
		return;
	}
	if (
		state.active &&
		current.banned &&
		current.banReason === SCIM_DEPROVISIONED_BAN_REASON
	) {
		await database.update({
			model: "user",
			where: [{ field: "id", value: state.userId }],
			update: { banned: false, banReason: null },
		});
	}
};

export const scimOptions = (): SCIMOptions => ({
	connections: [],
	managedConnections: {
		credentialHashSecret: getScimCredentialHashSecret(),
	},
	identity: {
		reconcileUser: reconcileScimLifecycle,
	},
	projection: {
		reconcileUser: reconcileScimMembership,
	},
});

/**
 * Who may manage SCIM connections for an organization: an owner or admin of
 * that exact organization whose account has enterprise features enabled. The
 * equivalent of the 1.6 `beforeSCIMTokenGenerated` guard, checked against the
 * database rather than the session so a stale session role cannot pass.
 */
export const canManageScimConnections = async (
	userId: string,
	organizationId: string,
) => {
	if (!userId || !organizationId) return false;
	const membership = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, organizationId),
		),
		columns: { role: true },
	});
	if (!membership) return false;
	if (membership.role !== "owner" && membership.role !== "admin") return false;
	const account = await db.query.user.findFirst({
		where: eq(user.id, userId),
		columns: { enableEnterpriseFeatures: true },
	});
	return !!account?.enableEnterpriseFeatures;
};
