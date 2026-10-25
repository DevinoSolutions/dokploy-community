import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertCanUpdateGitProvider, validateRequest } from "@dokploy/server";
import {
	betterAuthSecret,
	HARDCODED_LEGACY_SECRET,
} from "@dokploy/server/lib/auth-secret";
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

export interface VerifiedGitProviderOAuthState extends GitProviderOAuthState {
	/** Also stored in the browser's nonce cookie by the authorize route. */
	nonce: string;
}

export const GIT_PROVIDER_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

const STATE_VERSION = "v1";
const MAX_STATE_LENGTH = 2048;

// Used instead of the auth secret when that one is empty or the public legacy
// default, which would let anyone compute a valid signature. States signed
// with it do not survive a restart.
const processLocalStateKey = randomBytes(32);

// A key derived for this purpose only, so a state signature is never valid as
// any other value signed with the auth secret.
const stateKey = (secret: string) =>
	!secret || secret === HARDCODED_LEGACY_SECRET
		? processLocalStateKey
		: createHmac("sha256", secret)
				.update("dokploy:git-provider-oauth-state:v1")
				.digest();

const sign = (message: string, secret: string) =>
	createHmac("sha256", stateKey(secret)).update(message).digest("base64url");

export const createGitProviderOAuthNonce = () =>
	randomBytes(16).toString("base64url");

/** `v1.<base64url JSON payload>.<base64url HMAC-SHA256 of "v1.<payload>">` */
export const createGitProviderOAuthState = (
	state: GitProviderOAuthState,
	{
		secret = betterAuthSecret,
		now = Date.now(),
		nonce = createGitProviderOAuthNonce(),
	}: { secret?: string; now?: number; nonce?: string } = {},
): string => {
	const payload = Buffer.from(
		JSON.stringify({
			p: state.provider,
			i: state.providerId,
			u: state.userId,
			o: state.organizationId,
			e: now + GIT_PROVIDER_OAUTH_STATE_TTL_MS,
			n: nonce,
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
): VerifiedGitProviderOAuthState | null => {
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

	const { p, i, u, o, e, n } = claims;
	if (
		p !== provider ||
		!isNonEmptyString(i) ||
		!isNonEmptyString(u) ||
		!isNonEmptyString(o) ||
		!isNonEmptyString(n) ||
		typeof e !== "number" ||
		!Number.isFinite(e) ||
		e <= now
	) {
		return null;
	}

	return { provider, providerId: i, userId: u, organizationId: o, nonce: n };
};

// The nonce cookie ties a state to the browser that started the flow. Lax is
// still sent on the provider's top-level redirect back to the callback.
const nonceCookieName = (provider: OAuthGitProviderType) =>
	`dokploy_${provider}_oauth_nonce`;
const NONCE_COOKIE_PATH = "/api/providers";

const isHttpsRequest = (req: IncomingMessage) => {
	const forwarded = req.headers["x-forwarded-proto"];
	const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
		?.split(",")[0]
		?.trim()
		.toLowerCase();
	if (proto) return proto === "https";
	return Boolean(
		(req.socket as { encrypted?: boolean } | undefined)?.encrypted,
	);
};

const appendSetCookie = (res: ServerResponse, cookie: string) => {
	const existing = res.getHeader("Set-Cookie");
	const cookies = Array.isArray(existing)
		? existing
		: existing === undefined
			? []
			: [String(existing)];
	res.setHeader("Set-Cookie", [...cookies, cookie]);
};

const nonceCookie = (
	req: IncomingMessage,
	provider: OAuthGitProviderType,
	value: string,
	maxAgeSeconds: number,
) =>
	[
		`${nonceCookieName(provider)}=${value}`,
		`Path=${NONCE_COOKIE_PATH}`,
		`Max-Age=${maxAgeSeconds}`,
		"HttpOnly",
		"SameSite=Lax",
		...(isHttpsRequest(req) ? ["Secure"] : []),
	].join("; ");

export const setGitProviderOAuthNonceCookie = (
	req: IncomingMessage,
	res: ServerResponse,
	provider: OAuthGitProviderType,
	nonce: string,
) =>
	appendSetCookie(
		res,
		nonceCookie(
			req,
			provider,
			nonce,
			Math.floor(GIT_PROVIDER_OAUTH_STATE_TTL_MS / 1000),
		),
	);

export const clearGitProviderOAuthNonceCookie = (
	req: IncomingMessage,
	res: ServerResponse,
	provider: OAuthGitProviderType,
) => appendSetCookie(res, nonceCookie(req, provider, "", 0));

export const readGitProviderOAuthNonceCookie = (
	req: IncomingMessage,
	provider: OAuthGitProviderType,
): string | null => {
	const name = nonceCookieName(provider);
	for (const part of (req.headers.cookie ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === name) {
			const value = part.slice(eq + 1).trim();
			return value || null;
		}
	}
	return null;
};

export const gitProviderOAuthNonceMatches = (
	cookieNonce: string | null,
	stateNonce: string,
) => {
	if (!cookieNonce) return false;
	const given = Buffer.from(cookieNonce);
	const wanted = Buffer.from(stateNonce);
	return given.length === wanted.length && timingSafeEqual(given, wanted);
};

/**
 * The connect flow is only started from the dashboard, so a navigation from
 * another site is refused. Browsers that send no Sec-Fetch-Site are allowed.
 */
export const isCrossSiteRequest = (req: IncomingMessage) => {
	const value = req.headers["sec-fetch-site"];
	return (Array.isArray(value) ? value[0] : value) === "cross-site";
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
