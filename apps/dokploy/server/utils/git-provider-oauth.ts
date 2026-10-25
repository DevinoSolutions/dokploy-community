import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { assertCanUpdateGitProvider, validateRequest } from "@dokploy/server";
import { betterAuthSecret } from "@dokploy/server/lib/auth-secret";
import { hasPermission } from "@dokploy/server/services/permission";

// OAuth `state` for the GitLab and Gitea connect flows. The callback writes the
// returned tokens to a provider row, so the flow is bound to the provider and to
// the user (and organization) that started it, and only lives for a short time.

export type OAuthGitProviderType = "gitlab" | "gitea";

export interface GitProviderOAuthState {
	provider: OAuthGitProviderType;
	providerId: string;
	userId: string;
	organizationId: string;
}

export const GIT_PROVIDER_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

const STATE_VERSION = "v1";
const MAX_STATE_LENGTH = 2048;

// A key derived for this purpose only, so a state signature is never valid as
// any other value signed with the auth secret.
const stateKey = (secret: string) =>
	createHmac("sha256", secret)
		.update("dokploy:git-provider-oauth-state:v1")
		.digest();

const sign = (message: string, secret: string) =>
	createHmac("sha256", stateKey(secret)).update(message).digest("base64url");

/** `v1.<base64url JSON payload>.<base64url HMAC-SHA256 of "v1.<payload>">` */
export const createGitProviderOAuthState = (
	state: GitProviderOAuthState,
	{
		secret = betterAuthSecret,
		now = Date.now(),
	}: { secret?: string; now?: number } = {},
): string => {
	const payload = Buffer.from(
		JSON.stringify({
			p: state.provider,
			i: state.providerId,
			u: state.userId,
			o: state.organizationId,
			e: now + GIT_PROVIDER_OAUTH_STATE_TTL_MS,
			n: randomBytes(12).toString("base64url"),
		}),
	).toString("base64url");
	const message = `${STATE_VERSION}.${payload}`;
	return `${message}.${sign(message, secret)}`;
};

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0;

/**
 * Returns the state's claims when the signature matches, it has not expired
 * and it was issued for `provider`; null otherwise.
 */
export const verifyGitProviderOAuthState = (
	state: unknown,
	provider: OAuthGitProviderType,
	{
		secret = betterAuthSecret,
		now = Date.now(),
	}: { secret?: string; now?: number } = {},
): GitProviderOAuthState | null => {
	if (typeof state !== "string" || state.length > MAX_STATE_LENGTH) {
		return null;
	}
	const parts = state.split(".");
	if (parts.length !== 3 || parts[0] !== STATE_VERSION || !parts[1]) {
		return null;
	}

	const given = Buffer.from(parts[2] ?? "");
	const wanted = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret));
	if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
		return null;
	}

	let claims: Record<string, unknown>;
	try {
		claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (!claims || typeof claims !== "object") return null;

	const { p, i, u, o, e } = claims;
	if (
		p !== provider ||
		!isNonEmptyString(i) ||
		!isNonEmptyString(u) ||
		!isNonEmptyString(o) ||
		typeof e !== "number" ||
		!Number.isFinite(e) ||
		e <= now
	) {
		return null;
	}

	return { provider, providerId: i, userId: u, organizationId: o };
};

export type GitProviderOAuthAccess =
	| { ok: true; userId: string; organizationId: string }
	| { ok: false; status: 401 | 403 | 404; error: string };

/**
 * Checks that the signed-in user may connect the provider: it belongs to their
 * active organization and they hold the rights the provider update routes
 * require (`gitProviders:create`, and being its creator or an org owner/admin).
 * With `expected`, the session also has to be the user and organization the
 * OAuth state was issued to.
 */
export const checkGitProviderOAuthAccess = async (
	req: IncomingMessage,
	gitProvider: { userId: string; organizationId: string },
	expected?: Pick<GitProviderOAuthState, "userId" | "organizationId">,
): Promise<GitProviderOAuthAccess> => {
	const { user, session } = await validateRequest(req);
	if (!user || !session?.activeOrganizationId) {
		return { ok: false, status: 401, error: "Unauthorized" };
	}
	const organizationId = session.activeOrganizationId;

	if (
		expected &&
		(expected.userId !== user.id || expected.organizationId !== organizationId)
	) {
		return {
			ok: false,
			status: 403,
			error: "OAuth state was issued to a different session",
		};
	}

	if (gitProvider.organizationId !== organizationId) {
		return { ok: false, status: 404, error: "Git provider not found" };
	}

	const canUpdate =
		(await hasPermission(
			{
				user: { id: user.id },
				session: { activeOrganizationId: organizationId },
			},
			{ gitProviders: ["create"] },
		)) &&
		(await assertCanUpdateGitProvider(
			{ userId: user.id, activeOrganizationId: organizationId },
			gitProvider,
		).then(
			() => true,
			() => false,
		));
	if (!canUpdate) {
		return { ok: false, status: 403, error: "Forbidden" };
	}

	return { ok: true, userId: user.id, organizationId };
};
