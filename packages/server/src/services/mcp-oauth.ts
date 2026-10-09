import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	isNotNull,
	isNull,
	lt,
	notExists,
	or,
} from "drizzle-orm";
import { scheduleJob } from "node-schedule";
import { db } from "../db";
import {
	legacyOauthAccessToken,
	legacyOauthConsent,
	member,
	oauthAccessToken,
	oauthClient,
	oauthClientAssertion,
	oauthConsent,
	oauthRefreshToken,
	oauthResource,
	organization,
} from "../db/schema";
import { betterAuthSecret } from "../lib/auth-secret";
import { getWebServerSettings } from "./web-server-settings";

/** Path of the MCP endpoint relative to the origin. */
export const MCP_ENDPOINT_PATH = "/api/mcp";
/** Path of the fork's consent page relative to the origin. */
export const MCP_AUTHORIZE_PAGE_PATH = "/mcp/authorize";
/** Path of the OAuth provider's authorize endpoint relative to the origin. */
export const MCP_PLUGIN_AUTHORIZE_PATH = "/api/auth/oauth2/authorize";
/** Path of the OAuth provider's token endpoint relative to the origin. */
export const MCP_TOKEN_PATH = "/api/auth/oauth2/token";
/** Path of the OAuth provider's registration endpoint relative to the origin. */
export const MCP_REGISTER_PATH = "/api/auth/oauth2/register";

/**
 * better-auth 1.6 served the MCP OAuth endpoints under `/api/auth/mcp/*`, and
 * clients registered before the 1.7 upgrade keep those URLs cached (Claude
 * Code stores the token endpoint with the grant). `pages/api/auth/[...all].ts`
 * rewrites each legacy path to its 1.7 equivalent before better-auth routes it.
 */
export const LEGACY_MCP_OAUTH_PATH_REWRITES: Readonly<Record<string, string>> =
	{
		"/api/auth/mcp/token": MCP_TOKEN_PATH,
		"/api/auth/mcp/register": MCP_REGISTER_PATH,
		"/api/auth/mcp/authorize": MCP_PLUGIN_AUTHORIZE_PATH,
	};

/**
 * better-auth 1.6 SSO received SAML responses at
 * `/api/auth/sso/saml2/callback/:providerId`; 1.7 serves the ACS at
 * `/api/auth/sso/saml2/sp/acs/:providerId`. IdPs configured before the
 * upgrade keep posting to the old URL, so it stays an alias.
 */
const LEGACY_SAML_ACS_PATH = /^\/api\/auth\/sso\/saml2\/callback\/([^/]+)$/;

/** Path of the 1.7 SAML assertion consumer service for a provider. */
export const samlAcsPath = (providerId: string) =>
	`/api/auth/sso/saml2/sp/acs/${encodeURIComponent(providerId)}`;

/**
 * Maps a request URL on a 1.6 auth route (MCP OAuth endpoints, SAML ACS) to
 * its 1.7 equivalent, query string preserved. Other URLs are returned as is.
 */
export const rewriteLegacyAuthUrl = (url: string): string => {
	const queryStart = url.indexOf("?");
	const path = queryStart === -1 ? url : url.slice(0, queryStart);
	const query = queryStart === -1 ? "" : url.slice(queryStart);
	// Keys all start with "/", so no Object.prototype member can match.
	const mcpTarget = LEGACY_MCP_OAUTH_PATH_REWRITES[path];
	if (mcpTarget) return `${mcpTarget}${query}`;
	const saml = LEGACY_SAML_ACS_PATH.exec(path);
	if (saml?.[1]) {
		return `/api/auth/sso/saml2/sp/acs/${saml[1]}${query}`;
	}
	return url;
};

/**
 * The provider stamps every authorization response with an RFC 9207 `iss`
 * parameter derived from better-auth's base URL (`https://<host>/api/auth`),
 * while the discovery document the fork serves advertises the bare origin
 * (`resolveMcpOrigin`). A client that checks `iss` against the discovery
 * issuer would reject the response, so the redirect carries the advertised
 * issuer instead. Locations without an `iss` parameter are returned as is.
 */
export const withAdvertisedIssuer = (location: string, issuer: string) => {
	let url: URL;
	try {
		url = new URL(location);
	} catch {
		return location;
	}
	if (!url.searchParams.has("iss")) return location;
	url.searchParams.set("iss", issuer);
	return url.toString();
};

/**
 * Storage format of OAuth tokens: `base64url(SHA-256)`, byte-identical to
 * `@better-auth/oauth-provider`'s `"hashed"` storage. The fork looks bearer
 * tokens up itself, so it must hash the same way.
 */
export const hashOAuthToken = (value: string) =>
	createHash("sha256").update(value, "utf8").digest("base64url");

/**
 * Scope ids live in the leaf module `./mcp-scopes` so the web app can import
 * them without pulling `db`/`node-schedule` into a page bundle. Re-exported
 * here so existing `services/mcp-oauth` imports keep working.
 */
export { DOKPLOY_MCP_SCOPE_IDS, type DokployMcpScope } from "./mcp-scopes";

const DEFAULT_ACCESS_TOKEN_HOURS = 24 * 30; // 30 days
const DEFAULT_REFRESH_TOKEN_DAYS = 365;
const DEFAULT_REFRESH_GRACE_SECONDS = 300; // 5 minutes

/** Env reads take an explicit env object so tests never mutate process.env. */
type Env = Record<string, string | undefined>;

const positiveIntEnv = (env: Env, name: string, fallback: number) => {
	const raw = env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Like positiveIntEnv but accepts 0, which is meaningful for the grace window. */
const nonNegativeIntEnv = (env: Env, name: string, fallback: number) => {
	const raw = env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/** Access-token lifetime in seconds (DOKPLOY_MCP_ACCESS_TOKEN_HOURS, default 720 = 30 days). */
export const getMcpAccessTokenSeconds = (env: Env = process.env) =>
	positiveIntEnv(
		env,
		"DOKPLOY_MCP_ACCESS_TOKEN_HOURS",
		DEFAULT_ACCESS_TOKEN_HOURS,
	) * 3600;

/** Refresh-token lifetime in seconds (DOKPLOY_MCP_REFRESH_TOKEN_DAYS, default 365). Slides on every refresh. */
export const getMcpRefreshTokenSeconds = (env: Env = process.env) =>
	positiveIntEnv(
		env,
		"DOKPLOY_MCP_REFRESH_TOKEN_DAYS",
		DEFAULT_REFRESH_TOKEN_DAYS,
	) * 86400;

/**
 * How long a rotated refresh token can still be presented after being
 * consumed (DOKPLOY_MCP_REFRESH_GRACE_SECONDS, default 300). Inside the window
 * the provider replays the response of the refresh that consumed it, so a
 * retried or racing request recovers the same tokens instead of stranding the
 * client. 0 makes a consumed token invalid immediately.
 */
export const getMcpRefreshGraceSeconds = (env: Env = process.env) =>
	nonNegativeIntEnv(
		env,
		"DOKPLOY_MCP_REFRESH_GRACE_SECONDS",
		DEFAULT_REFRESH_GRACE_SECONDS,
	);

/** Kill switch: DOKPLOY_MCP_DISABLED=true removes the endpoint and the purge job. */
export const isMcpDisabled = (env: Env = process.env) =>
	env.DOKPLOY_MCP_DISABLED === "true";

/**
 * Public origin used in discovery documents and the `WWW-Authenticate` header.
 * Deterministic on purpose (never trusts the Host header in production) so a
 * spoofed header cannot rewrite the issuer a client records.
 */
export const resolveMcpOrigin = async (
	headers: IncomingHttpHeaders,
	env: Env = process.env,
): Promise<string | null> => {
	const fromEnv = env.BETTER_AUTH_URL;
	if (fromEnv) {
		try {
			return new URL(fromEnv).origin;
		} catch {
			// fall through to the configured host
		}
	}
	const settings = await getWebServerSettings();
	if (settings?.host) {
		return `https://${settings.host}`;
	}
	if (env.NODE_ENV === "development" && headers.host) {
		return `http://${headers.host}`;
	}
	return null;
};

/**
 * Dynamic client registration is anonymous, so restrict where authorization
 * codes may be sent: loopback over http (Claude Code and other CLIs) or https.
 */
export const isAllowedRedirectUri = (uri: string): boolean => {
	// The 1.6 plugin stored the registered list as `redirect_uris.join(",")`
	// and migration 0211 splits it back on commas, so a single entry containing
	// one would smuggle a second, unvetted target into the list. 1.7 stores an
	// array, but the rule stays: no legitimate redirect target needs a comma.
	if (uri.includes(",")) return false;
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return false;
	}
	// A fragment is never sent to the server and cannot be matched reliably, so
	// a registered redirect must not carry one.
	if (parsed.hash !== "") return false;
	if (parsed.protocol === "https:") return true;
	if (parsed.protocol !== "http:") return false;
	return (
		parsed.hostname === "localhost" ||
		parsed.hostname === "127.0.0.1" ||
		// Node's URL keeps IPv6 hosts bracketed.
		parsed.hostname === "[::1]"
	);
};

/** Verdict of the dynamic-client-registration policy, ready to become an APIError. */
export type McpRegisterDecision =
	| { ok: true }
	| { ok: false; error: string; error_description: string };

/**
 * Gate for `POST /api/auth/oauth2/register` (and the legacy
 * `/api/auth/mcp/register` alias). Pure so the policy can be exercised
 * without a better-auth request context; `lib/auth.ts` only translates the
 * verdict into an `APIError`.
 */
export const evaluateMcpRegisterBody = (body: unknown): McpRegisterDecision => {
	const uris = (body as { redirect_uris?: unknown } | null | undefined)
		?.redirect_uris;
	const valid =
		Array.isArray(uris) &&
		uris.length > 0 &&
		uris.every((uri) => typeof uri === "string" && isAllowedRedirectUri(uri));
	if (valid) return { ok: true };
	return {
		ok: false,
		error: "invalid_redirect_uri",
		error_description:
			"redirect_uris must use http://localhost, http://127.0.0.1 or https://",
	};
};

const isLoopbackHttpUri = (uri: string) => {
	try {
		const parsed = new URL(uri);
		return (
			parsed.protocol === "http:" &&
			(parsed.hostname === "localhost" ||
				parsed.hostname === "127.0.0.1" ||
				parsed.hostname === "[::1]")
		);
	} catch {
		return false;
	}
};

/**
 * Registration defaults the 1.6 plugin applied implicitly. The 1.7 provider
 * treats a registration without `application_type` as a `web` client, and a
 * web client may not use an http loopback redirect, which is exactly what
 * Claude Code and other CLIs register (RFC 8252 native clients). Such a
 * registration is declared `native` here so it keeps working. Returns null
 * when the body needs no change.
 */
export const normalizeMcpRegisterBody = (
	body: unknown,
): Record<string, unknown> | null => {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const record = body as Record<string, unknown>;
	if (record.application_type !== undefined) return null;
	const uris = record.redirect_uris;
	if (
		!Array.isArray(uris) ||
		!uris.some((uri) => typeof uri === "string" && isLoopbackHttpUri(uri))
	) {
		return null;
	}
	return { ...record, application_type: "native" };
};

/** Canonical RFC 8707 resource identifier of the MCP endpoint for an origin. */
export const mcpResourceIdentifier = (origin: string) =>
	`${origin}${MCP_ENDPOINT_PATH}`;

const firstHeaderHost = (value: string | string[] | undefined) => {
	const raw = Array.isArray(value) ? value[0] : value;
	const host = raw?.split(",")[0]?.trim().toLowerCase();
	return host ? host : null;
};

/**
 * Hosts this instance is reached under besides the advertised origin: the
 * request's Host and X-Forwarded-Host, and the configured web server host.
 */
export const mcpResourceAliasHosts = async (
	headers: IncomingHttpHeaders,
): Promise<string[]> => {
	const hosts = [
		firstHeaderHost(headers.host),
		firstHeaderHost(headers["x-forwarded-host"]),
	];
	const settings = await getWebServerSettings().catch(() => null);
	if (settings?.host) hosts.push(settings.host.trim().toLowerCase());
	return [...new Set(hosts.filter((host): host is string => !!host))];
};

/**
 * Maps a client-sent RFC 8707 `resource` naming this instance's MCP endpoint
 * to the identifier the protected-resource metadata advertises
 * (`mcpResourceIdentifier(resolveMcpOrigin(...))`), or null when it names
 * something else.
 *
 * Clients do not all echo the advertised value byte for byte: some append a
 * trailing slash, some keep the URL they were configured with (another host
 * name of this instance, or http behind a TLS-terminating proxy). Each of
 * those is this endpoint, and the provider would answer `invalid_target`
 * because it knows only the advertised identifier. Only hosts that reach this
 * instance are accepted, never an arbitrary one, so a token can never be bound
 * to a third-party resource name.
 */
export const canonicalizeMcpResource = (
	resource: string,
	origin: string,
	aliasHosts: readonly string[] = [],
): string | null => {
	let parsed: URL;
	let advertised: URL;
	try {
		parsed = new URL(resource);
		advertised = new URL(origin);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	if (parsed.search !== "" || parsed.hash !== "") return null;
	if (parsed.username !== "" || parsed.password !== "") return null;
	if (parsed.pathname.replace(/\/+$/, "") !== MCP_ENDPOINT_PATH) return null;
	const host = parsed.host.toLowerCase();
	const known =
		host === advertised.host.toLowerCase() ||
		aliasHosts.some((alias) => alias.toLowerCase() === host);
	return known ? mcpResourceIdentifier(advertised.origin) : null;
};

/**
 * Canonical form of a `resource` parameter (a string, or an array when the
 * key repeats). Values naming another resource are left as sent, so the
 * provider still rejects them.
 */
export const canonicalizeMcpResourceParam = (
	value: unknown,
	origin: string,
	aliasHosts: readonly string[] = [],
): unknown => {
	const one = (entry: unknown) =>
		typeof entry === "string"
			? (canonicalizeMcpResource(entry, origin, aliasHosts) ?? entry)
			: entry;
	if (Array.isArray(value)) return [...new Set(value.map(one))];
	return one(value);
};

/**
 * The 1.7 provider rejects an RFC 8707 `resource` it has no `oauth_resource`
 * row for, and MCP clients send the endpoint URL as `resource` on every
 * authorize and token request (the 1.6 plugin ignored it). The origin is only
 * known per request (BETTER_AUTH_URL or the configured host), so the row is
 * created on demand instead of from static plugin options. Idempotent.
 */
export const ensureMcpResource = async (origin: string) => {
	const identifier = mcpResourceIdentifier(origin);
	const now = new Date();
	await db
		.insert(oauthResource)
		.values({
			identifier,
			name: "Dokploy MCP",
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing({ target: oauthResource.identifier });
	return identifier;
};

/**
 * Organization an MCP grant acts in: the member row flagged `is_default`,
 * else the user's earliest membership, else null (→ 401 at the endpoint).
 */
export const resolveDefaultOrganizationId = async (
	userId: string,
): Promise<string | null> => {
	const row = await db.query.member.findFirst({
		where: eq(member.userId, userId),
		orderBy: [desc(member.isDefault), asc(member.createdAt)],
		columns: { organizationId: true },
	});
	return row?.organizationId ?? null;
};

export const findOrganizationName = async (organizationId: string) => {
	const row = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		columns: { id: true, name: true },
	});
	return row ?? null;
};

// ---------------------------------------------------------------------------
// Bearer tokens
// ---------------------------------------------------------------------------

export interface McpAccessToken {
	userId: string;
	clientId: string;
	scopes: string[];
}

/**
 * Opaque access-token lookup against the provider's hashed token store. Null
 * for missing, expired, revoked or user-less rows, and for tokens whose client
 * has since been disabled.
 */
export const findMcpAccessToken = async (
	accessToken: string,
): Promise<McpAccessToken | null> => {
	if (!accessToken) return null;
	const row = await db.query.oauthAccessToken.findFirst({
		where: eq(oauthAccessToken.token, hashOAuthToken(accessToken)),
		columns: {
			userId: true,
			clientId: true,
			scopes: true,
			expiresAt: true,
			revoked: true,
		},
		with: { client: { columns: { disabled: true } } },
	});
	if (!row || !row.userId) return null;
	if (row.revoked) return null;
	if (row.client?.disabled) return null;
	if (!row.expiresAt || row.expiresAt.getTime() <= Date.now()) return null;
	return {
		userId: row.userId,
		clientId: row.clientId,
		scopes: (row.scopes ?? []).filter(Boolean),
	};
};

export const findOAuthApplicationByClientId = async (clientId: string) => {
	if (!clientId) return null;
	const row = await db.query.oauthClient.findFirst({
		where: eq(oauthClient.clientId, clientId),
		columns: {
			clientId: true,
			name: true,
			redirectUris: true,
			disabled: true,
		},
	});
	if (!row) return null;
	return {
		clientId: row.clientId,
		name: row.name || "Unnamed client",
		redirectUrls: (row.redirectUris ?? []).filter(Boolean),
		disabled: row.disabled ?? false,
	};
};

// ---------------------------------------------------------------------------
// Consent proof — binds the plugin's authorize call to a consent-page approval
// ---------------------------------------------------------------------------

export interface ConsentProofPayload {
	userId: string;
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
	/** Space-separated scope string; compared as a sorted set. */
	scope: string;
}

const CONSENT_PROOF_TTL_MS = 5 * 60 * 1000;

const canonicalScope = (scope: string) =>
	scope.split(" ").filter(Boolean).sort().join(" ");

/**
 * JSON encoding, not a `|` join: every field below is client-controlled, and a
 * separator-joined string lets one field absorb a separator to shift the field
 * boundaries and forge a different-but-identical message.
 */
const consentProofMessage = (payload: ConsentProofPayload, exp: number) =>
	JSON.stringify([
		payload.userId,
		payload.clientId,
		payload.redirectUri,
		payload.state,
		payload.codeChallenge,
		canonicalScope(payload.scope),
		exp,
	]);

const sign = (message: string, secret: string) =>
	createHmac("sha256", secret).update(message).digest("base64url");

/**
 * `<exp>.<signature>` — the signature covers every OAuth parameter the
 * plugin will act on plus the approving user, so the proof cannot be replayed
 * for another client, redirect, scope set, or user.
 */
export const createConsentProof = (
	payload: ConsentProofPayload,
	secret: string = betterAuthSecret,
	expiresAt: number = Date.now() + CONSENT_PROOF_TTL_MS,
): string =>
	`${expiresAt}.${sign(consentProofMessage(payload, expiresAt), secret)}`;

export const verifyConsentProof = (
	proof: string,
	expected: ConsentProofPayload,
	secret: string = betterAuthSecret,
): boolean => {
	const dot = proof.indexOf(".");
	if (dot <= 0) return false;
	const exp = Number.parseInt(proof.slice(0, dot), 10);
	if (!Number.isFinite(exp) || exp < Date.now()) return false;
	const given = Buffer.from(proof.slice(dot + 1));
	const wanted = Buffer.from(sign(consentProofMessage(expected, exp), secret));
	return given.length === wanted.length && timingSafeEqual(given, wanted);
};

/** Verdict of the authorize gate: let the plugin run, bounce to the consent page, or refuse. */
export type McpAuthorizeDecision =
	| { action: "allow" }
	| { action: "redirect"; location: string }
	| { action: "reject"; error: string; error_description: string };

export interface McpAuthorizeGateInput {
	/** Raw query of the authorize request; every value is client-controlled. */
	query: Record<string, unknown>;
	/** Signed-in user, or null when the request carries no session. */
	userId: string | null;
	secret?: string;
}

const asString = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * The provider also accepts POST on its authorize endpoint and then reads the
 * parameters from the body, while the consent proof is checked against the
 * query string. The fork's consent page always redirects with GET, so any
 * other method is refused before the provider can issue a code for parameters
 * the proof never covered.
 */
export const isMcpAuthorizeMethodAllowed = (method: string | undefined) =>
	(method ?? "").toUpperCase() === "GET";

/**
 * Gate for `GET /api/auth/oauth2/authorize` (and the legacy
 * `/api/auth/mcp/authorize` alias). The fork's consent page is the only way to
 * approve a client, so an anonymous request is bounced to it (before the
 * provider can redirect to its own login flow) and a signed-in one must carry
 * the proof that page mints for this exact user and parameters.
 */
export const evaluateMcpAuthorizeGate = ({
	query,
	userId,
	secret = betterAuthSecret,
}: McpAuthorizeGateInput): McpAuthorizeDecision => {
	if (userId === null) {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			// `consent` is this gate's own parameter, and a repeated query key
			// arrives as an array the consent page cannot act on.
			if (key !== "consent" && typeof value === "string") {
				params.set(key, value);
			}
		}
		// Relative on purpose: better-auth's baseURL can be undefined, and the
		// browser resolves this against the host it already reached.
		return {
			action: "redirect",
			location: `${MCP_AUTHORIZE_PAGE_PATH}?${params.toString()}`,
		};
	}

	const ok = verifyConsentProof(
		asString(query.consent),
		{
			userId,
			clientId: asString(query.client_id),
			redirectUri: asString(query.redirect_uri),
			state: asString(query.state),
			codeChallenge: asString(query.code_challenge),
			scope: asString(query.scope),
		},
		secret,
	);
	if (ok) return { action: "allow" };
	return {
		action: "reject",
		error: "consent_required",
		error_description: `Authorization must start from ${MCP_AUTHORIZE_PAGE_PATH}`,
	};
};

// ---------------------------------------------------------------------------
// Token hygiene
// ---------------------------------------------------------------------------

/**
 * How long a rotated refresh row is kept after rotation. The provider marks
 * the consumed row `revoked` and, when the same token is presented again
 * outside the reuse window, treats it as replay and tears the whole grant
 * family down (RFC 9700 §4.14). The row has to exist for that detection, so
 * it is reaped only well after any legitimate retry could arrive.
 */
export const ROTATED_REFRESH_RETENTION_DAYS = 30;

/**
 * True when a refresh token was already consumed (rotated or revoked) and its
 * replay window has closed.
 *
 * The provider answers such a token by deleting every refresh and access token
 * of the (client, user) pair, as RFC 9700 §4.14 suggests for a stolen token.
 * MCP clients share one grant across many sessions (every Claude Code session
 * on a machine reads the same credentials file), so a session still holding
 * the previous token would log every other session out with it. The 1.6
 * behaviour, kept on purpose since #214, is to refuse only the stale token:
 * `lib/auth.ts` answers `invalid_grant` before the provider sees it, and the
 * grant the other sessions use stays valid.
 */
export const isStaleRotatedRefreshToken = async (
	refreshToken: string,
	now: Date = new Date(),
) => {
	if (!refreshToken) return false;
	const row = await db.query.oauthRefreshToken.findFirst({
		where: eq(oauthRefreshToken.token, hashOAuthToken(refreshToken)),
		columns: { revoked: true, rotationReplayExpiresAt: true },
	});
	if (!row?.revoked) return false;
	return (
		!row.rotationReplayExpiresAt ||
		row.rotationReplayExpiresAt.getTime() < now.getTime()
	);
};

/**
 * Removes rows that can never be used again.
 *
 * First the token rows: refresh tokens whose window closed or that were
 * rotated/revoked long ago (their access tokens go with them through the
 * `refresh_id` cascade), then access tokens that expired or were revoked.
 *
 * Then the abandoned client registrations. Dynamic client registration is
 * anonymous, so every registration writes an `oauth_client` row whether or
 * not the user ever authorizes it, and nothing else removes them. A
 * registration with no token row has never completed an authorization.
 * Clients cache their registration indefinitely, though (Claude Code keeps the
 * client id in its credentials file), and a user who registers today and only
 * clicks Authorize next week must still land on a known client rather than
 * "Unknown or disabled OAuth client". Wait ABANDONED_REGISTRATION_DAYS before
 * treating such a row as abandoned.
 *
 * The better-auth 1.6 tables (`oauth_application`, `oauth_access_token`,
 * `oauth_consent`) are the rollback copy, so live rows stay. 1.6 stored its
 * tokens in plaintext, though, so a 1.6 token row is removed as soon as both
 * of its tokens have expired: 1.6 would refuse it too, and nothing else ever
 * cleans that table.
 *
 * Finally, the encrypted replay response of a rotated refresh token is
 * cleared once its replay window has closed. The row itself stays for
 * ROTATED_REFRESH_RETENTION_DAYS (stale-token detection needs it), but the
 * response, which holds the tokens issued by the rotation, is never used
 * again.
 */
export const ABANDONED_REGISTRATION_DAYS = 30;

export const purgeExpiredMcpTokens = async () => {
	const now = new Date();
	const rotatedBefore = new Date(
		now.getTime() - ROTATED_REFRESH_RETENTION_DAYS * 86_400_000,
	);
	await db
		.delete(oauthRefreshToken)
		.where(
			or(
				lt(oauthRefreshToken.expiresAt, now),
				and(
					isNotNull(oauthRefreshToken.revoked),
					lt(oauthRefreshToken.revoked, rotatedBefore),
				),
			),
		);
	await db
		.delete(oauthAccessToken)
		.where(
			or(
				lt(oauthAccessToken.expiresAt, now),
				and(
					isNotNull(oauthAccessToken.revoked),
					lt(oauthAccessToken.revoked, now),
				),
			),
		);
	await db
		.delete(oauthClientAssertion)
		.where(lt(oauthClientAssertion.expiresAt, now));
	await db
		.update(oauthRefreshToken)
		.set({ rotationReplayResponse: null })
		.where(
			and(
				isNotNull(oauthRefreshToken.rotationReplayResponse),
				lt(oauthRefreshToken.rotationReplayExpiresAt, now),
			),
		);
	await db
		.delete(legacyOauthAccessToken)
		.where(
			and(
				lt(legacyOauthAccessToken.accessTokenExpiresAt, now),
				or(
					isNull(legacyOauthAccessToken.refreshTokenExpiresAt),
					lt(legacyOauthAccessToken.refreshTokenExpiresAt, now),
				),
			),
		);

	const abandonedBefore = new Date(
		now.getTime() - ABANDONED_REGISTRATION_DAYS * 86_400_000,
	);
	await db
		.delete(oauthClient)
		.where(
			and(
				lt(oauthClient.createdAt, abandonedBefore),
				notExists(
					db
						.select({ id: oauthRefreshToken.id })
						.from(oauthRefreshToken)
						.where(eq(oauthRefreshToken.clientId, oauthClient.clientId)),
				),
				notExists(
					db
						.select({ id: oauthAccessToken.id })
						.from(oauthAccessToken)
						.where(eq(oauthAccessToken.clientId, oauthClient.clientId)),
				),
			),
		);
};

/** Daily purge; registered from server.ts when MCP is enabled. */
export const initMcpTokenPurgeCronJob = () => {
	scheduleJob("mcp-token-purge", "23 4 * * *", async () => {
		try {
			await purgeExpiredMcpTokens();
		} catch (error) {
			console.error("[mcp] token purge failed", error);
		}
	});
};

// ---------------------------------------------------------------------------
// Authorizations (settings card)
// ---------------------------------------------------------------------------

export interface McpAuthorization {
	clientId: string;
	clientName: string;
	scopes: string[];
	authorizedAt: Date;
	lastRefreshedAt: Date;
	refreshExpiresAt: Date | null;
}

/** Cap on rows read per user when listing authorizations. */
const MCP_AUTHORIZATION_ROW_LIMIT = 200;

/**
 * Records the grant the user approved on the consent page. The provider's
 * authorize endpoint issues a code only when a consent row for the user and
 * client covers every requested scope and resource, so this row is what lets
 * the redirect that follows succeed. Token rows are rotated away on every
 * refresh and cannot date the original grant; this row can.
 *
 * The row replaces any earlier grant for the same client: re-authorizing keeps
 * one row per (user, client), so `authorizedAt` reflects the grant actually in
 * force and the table cannot grow without bound.
 */
export const recordMcpConsent = async (
	userId: string,
	clientId: string,
	scopes: string[],
	resources: string[] = [],
) => {
	const now = new Date();
	await db
		.delete(oauthConsent)
		.where(
			and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)),
		);
	await db.insert(oauthConsent).values({
		clientId,
		userId,
		scopes,
		resources: resources.length > 0 ? resources : null,
		createdAt: now,
		updatedAt: now,
	});
};

/**
 * One row per client the user has authorized, newest live refresh token wins
 * for scopes. `authorizedAt` is the latest consent, since `recordMcpConsent`
 * replaces the previous grant for the client rather than adding to it.
 */
export const listMcpAuthorizations = async (
	userId: string,
): Promise<McpAuthorization[]> => {
	// Never project the token columns: this list is rendered in the UI. The
	// newest live tokens are read (a user with many sessions can hold far more
	// than the cap), then walked oldest first so the newest wins per client.
	const newestFirst = await db.query.oauthRefreshToken.findMany({
		where: and(
			eq(oauthRefreshToken.userId, userId),
			isNull(oauthRefreshToken.revoked),
			gt(oauthRefreshToken.expiresAt, new Date()),
		),
		columns: {
			clientId: true,
			scopes: true,
			createdAt: true,
			expiresAt: true,
		},
		orderBy: [desc(oauthRefreshToken.createdAt)],
		limit: MCP_AUTHORIZATION_ROW_LIMIT,
		with: { client: { columns: { name: true } } },
	});
	const rows = [...newestFirst].reverse();
	const consents = await db.query.oauthConsent.findMany({
		where: eq(oauthConsent.userId, userId),
		columns: { clientId: true, createdAt: true },
		orderBy: [asc(oauthConsent.createdAt)],
		limit: MCP_AUTHORIZATION_ROW_LIMIT,
	});
	const grantedAt = new Map<string, Date>();
	for (const consent of consents) {
		if (consent.createdAt && !grantedAt.has(consent.clientId)) {
			grantedAt.set(consent.clientId, consent.createdAt);
		}
	}
	const byClient = new Map<string, McpAuthorization>();
	for (const row of rows) {
		const existing = byClient.get(row.clientId);
		const createdAt = row.createdAt ?? new Date(0);
		const scopes = (row.scopes ?? []).filter((scope) =>
			scope.startsWith("dokploy:"),
		);
		if (!existing) {
			byClient.set(row.clientId, {
				clientId: row.clientId,
				clientName: row.client?.name || "Unnamed client",
				scopes,
				// Falls back to the oldest surviving token for grants made before
				// consent rows were recorded.
				authorizedAt: grantedAt.get(row.clientId) ?? createdAt,
				lastRefreshedAt: createdAt,
				refreshExpiresAt: row.expiresAt,
			});
			continue;
		}
		existing.scopes = scopes;
		existing.lastRefreshedAt = createdAt;
		existing.refreshExpiresAt = row.expiresAt;
	}
	return [...byClient.values()];
};

/**
 * Deletes every token and consent row for client+user; the client's next call
 * gets 401 and a re-authorization starts a fresh grant. The matching 1.6 rows
 * go too: they hold the same grant in plaintext, and a rollback must not bring
 * back an authorization the user revoked.
 */
export const revokeMcpAuthorization = async (
	userId: string,
	clientId: string,
) => {
	await db
		.delete(oauthAccessToken)
		.where(
			and(
				eq(oauthAccessToken.userId, userId),
				eq(oauthAccessToken.clientId, clientId),
			),
		);
	await db
		.delete(oauthRefreshToken)
		.where(
			and(
				eq(oauthRefreshToken.userId, userId),
				eq(oauthRefreshToken.clientId, clientId),
			),
		);
	await db
		.delete(oauthConsent)
		.where(
			and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)),
		);
	await db
		.delete(legacyOauthAccessToken)
		.where(
			and(
				eq(legacyOauthAccessToken.userId, userId),
				eq(legacyOauthAccessToken.clientId, clientId),
			),
		);
	await db
		.delete(legacyOauthConsent)
		.where(
			and(
				eq(legacyOauthConsent.userId, userId),
				eq(legacyOauthConsent.clientId, clientId),
			),
		);
};
