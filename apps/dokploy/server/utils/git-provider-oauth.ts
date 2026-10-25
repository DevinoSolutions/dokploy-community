import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertCanUpdateGitProvider, validateRequest } from "@dokploy/server";
import {
	betterAuthSecret,
	HARDCODED_LEGACY_SECRET,
} from "@dokploy/server/lib/auth-secret";
import { hasPermission } from "@dokploy/server/services/permission";

// OAuth `state` for the GitLab and Gitea connect flows and for the two GitHub
// App steps (create the app from a manifest, bind an installation to it). The
// callback writes tokens or credentials to a provider row, so the flow is bound
// to the provider and to the user (and organization) that started it, and only
// lives for a short time.

// `github_init` and `github_setup` are separate types so a state issued for one
// step is never accepted by the other, and each step has its own nonce cookie.
export type OAuthGitProviderType =
	| "gitlab"
	| "gitea"
	| "github_init"
	| "github_setup";

export interface GitProviderOAuthState {
	provider: OAuthGitProviderType;
	/**
	 * The provider the flow writes to. For `github_init` no provider exists yet,
	 * so it carries the normalized GitHub base URL the app is created on.
	 */
	providerId: string;
	userId: string;
	organizationId: string;
}

export interface VerifiedGitProviderOAuthState extends GitProviderOAuthState {
	/**
	 * sha256 (base64url) of the nonce the authorize route stored in the
	 * browser's cookie. The state never carries the nonce itself, so a state
	 * seen in a URL or log does not reveal the cookie value.
	 */
	nonceHash: string;
}

export const GIT_PROVIDER_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
// The user names and confirms the app on GitHub (sign-in, sudo, 2FA) between
// the state being issued and used; GitHub keeps the manifest code for an hour.
export const GITHUB_INIT_STATE_TTL_MS = 60 * 60 * 1000;

const stateTtlMs = (provider: OAuthGitProviderType) =>
	provider === "github_init"
		? GITHUB_INIT_STATE_TTL_MS
		: GIT_PROVIDER_OAUTH_STATE_TTL_MS;

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

const hashNonce = (nonce: string) =>
	createHash("sha256").update(nonce).digest("base64url");

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
			e: now + stateTtlMs(state.provider),
			n: hashNonce(nonce),
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

	return {
		provider,
		providerId: i,
		userId: u,
		organizationId: o,
		nonceHash: n,
	};
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
		nonceCookie(req, provider, nonce, Math.floor(stateTtlMs(provider) / 1000)),
	);

export const clearGitProviderOAuthNonceCookie = (
	req: IncomingMessage,
	res: ServerResponse,
	provider: OAuthGitProviderType,
) => appendSetCookie(res, nonceCookie(req, provider, "", 0));

/**
 * Returns the nonce cookie's value, or null when it is absent, empty or sent
 * more than once. A sibling subdomain can set a cookie with the same name (for
 * a parent domain or a longer path), so a duplicate is never resolved by
 * picking one.
 */
export const readGitProviderOAuthNonceCookie = (
	req: IncomingMessage,
	provider: OAuthGitProviderType,
): string | null => {
	const name = nonceCookieName(provider);
	const values: string[] = [];
	for (const part of (req.headers.cookie ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === name) {
			values.push(part.slice(eq + 1).trim());
		}
	}
	return values.length === 1 && values[0] ? values[0] : null;
};

export const gitProviderOAuthNonceMatches = (
	cookieNonce: string | null,
	stateNonceHash: string,
) => {
	if (!cookieNonce) return false;
	const given = Buffer.from(hashNonce(cookieNonce));
	const wanted = Buffer.from(stateNonceHash);
	return given.length === wanted.length && timingSafeEqual(given, wanted);
};

const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

/**
 * The connect flow is only started from the dashboard itself, so only
 * same-origin requests, user-initiated navigations (`none`) and browsers that
 * send no Sec-Fetch-Site are allowed. `same-site` is refused too: other apps
 * can be served from sibling subdomains of the same site.
 */
export const isFetchSiteAllowed = (req: IncomingMessage) => {
	const value = req.headers["sec-fetch-site"];
	const site = Array.isArray(value) ? value.join(",") : value;
	return site === undefined || ALLOWED_FETCH_SITES.has(site);
};

export type GitProviderOAuthAccess =
	| { ok: true; userId: string; organizationId: string }
	| { ok: false; status: 401 | 403 | 404; error: string };

type OAuthSession = Extract<GitProviderOAuthAccess, { ok: true }>;

// The signed-in session, which also has to be the user and organization the
// OAuth state was issued to when `expected` is given.
const resolveOAuthSession = async (
	req: IncomingMessage,
	expected?: Pick<GitProviderOAuthState, "userId" | "organizationId">,
): Promise<OAuthSession | Extract<GitProviderOAuthAccess, { ok: false }>> => {
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

	return { ok: true, userId: user.id, organizationId };
};

const canCreateGitProviders = (session: OAuthSession) =>
	hasPermission(
		{
			user: { id: session.userId },
			session: { activeOrganizationId: session.organizationId },
		},
		{ gitProviders: ["create"] },
	);

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
	const session = await resolveOAuthSession(req, expected);
	if (!session.ok) return session;

	if (gitProvider.organizationId !== session.organizationId) {
		return { ok: false, status: 404, error: "Git provider not found" };
	}

	const canUpdate =
		(await canCreateGitProviders(session)) &&
		(await assertCanUpdateGitProvider(
			{
				userId: session.userId,
				activeOrganizationId: session.organizationId,
			},
			gitProvider,
		).then(
			() => true,
			() => false,
		));
	if (!canUpdate) {
		return { ok: false, status: 403, error: "Forbidden" };
	}

	return session;
};

/**
 * Same session checks for a flow that creates a provider (there is no row to
 * compare against yet): the user needs `gitProviders:create` in their active
 * organization.
 */
export const checkGitProviderCreateAccess = async (
	req: IncomingMessage,
	expected?: Pick<GitProviderOAuthState, "userId" | "organizationId">,
): Promise<GitProviderOAuthAccess> => {
	const session = await resolveOAuthSession(req, expected);
	if (!session.ok) return session;

	if (!(await canCreateGitProviders(session))) {
		return { ok: false, status: 403, error: "Forbidden" };
	}

	return session;
};
