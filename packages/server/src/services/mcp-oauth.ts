import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { and, asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import { scheduleJob } from "node-schedule";
import { db } from "../db";
import {
	member,
	oauthAccessToken,
	oauthApplication,
	oauthConsent,
	organization,
} from "../db/schema";
import { betterAuthSecret } from "../lib/auth-secret";
import { getWebServerSettings } from "./web-server-settings";

/** Path of the MCP endpoint relative to the origin. */
export const MCP_ENDPOINT_PATH = "/api/mcp";
/** Path of the fork's consent page relative to the origin. */
export const MCP_AUTHORIZE_PAGE_PATH = "/mcp/authorize";
/** Path of the plugin's authorize endpoint relative to the origin. */
export const MCP_PLUGIN_AUTHORIZE_PATH = "/api/auth/mcp/authorize";

/**
 * Scope ids live in the leaf module `./mcp-scopes` so the web app can import
 * them without pulling `db`/`node-schedule` into a page bundle. Re-exported
 * here so existing `services/mcp-oauth` imports keep working.
 */
export { DOKPLOY_MCP_SCOPE_IDS, type DokployMcpScope } from "./mcp-scopes";

const DEFAULT_ACCESS_TOKEN_HOURS = 24;
const DEFAULT_REFRESH_TOKEN_DAYS = 180;

/** Env reads take an explicit env object so tests never mutate process.env. */
type Env = Record<string, string | undefined>;

const positiveIntEnv = (env: Env, name: string, fallback: number) => {
	const raw = env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Access-token lifetime in seconds (DOKPLOY_MCP_ACCESS_TOKEN_HOURS, default 24). */
export const getMcpAccessTokenSeconds = (env: Env = process.env) =>
	positiveIntEnv(
		env,
		"DOKPLOY_MCP_ACCESS_TOKEN_HOURS",
		DEFAULT_ACCESS_TOKEN_HOURS,
	) * 3600;

/** Refresh-token lifetime in seconds (DOKPLOY_MCP_REFRESH_TOKEN_DAYS, default 180). Slides on every refresh. */
export const getMcpRefreshTokenSeconds = (env: Env = process.env) =>
	positiveIntEnv(
		env,
		"DOKPLOY_MCP_REFRESH_TOKEN_DAYS",
		DEFAULT_REFRESH_TOKEN_DAYS,
	) * 86400;

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
	// The plugin stores the registered list as `redirect_uris.join(",")` and
	// splits it back on commas, so a single entry containing one would smuggle a
	// second, unvetted target into the stored list.
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
 * Gate for `POST /api/auth/mcp/register`. Pure so the policy can be exercised
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
 * Opaque access-token lookup. Null for missing, expired or user-less rows, and
 * for tokens whose client application has since been disabled.
 */
export const findMcpAccessToken = async (
	accessToken: string,
): Promise<McpAccessToken | null> => {
	if (!accessToken) return null;
	const row = await db.query.oauthAccessToken.findFirst({
		where: eq(oauthAccessToken.accessToken, accessToken),
		columns: {
			userId: true,
			clientId: true,
			scopes: true,
			accessTokenExpiresAt: true,
		},
		with: { application: { columns: { disabled: true } } },
	});
	if (!row || !row.userId) return null;
	if (row.application?.disabled) return null;
	if (row.accessTokenExpiresAt.getTime() <= Date.now()) return null;
	return {
		userId: row.userId,
		clientId: row.clientId,
		scopes: row.scopes.split(" ").filter(Boolean),
	};
};

export const findOAuthApplicationByClientId = async (clientId: string) => {
	if (!clientId) return null;
	const row = await db.query.oauthApplication.findFirst({
		where: eq(oauthApplication.clientId, clientId),
		columns: {
			clientId: true,
			name: true,
			redirectUrls: true,
			disabled: true,
		},
	});
	if (!row) return null;
	return {
		clientId: row.clientId,
		name: row.name || "Unnamed client",
		redirectUrls: row.redirectUrls.split(",").filter(Boolean),
		disabled: row.disabled,
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
 * Gate for `GET /api/auth/mcp/authorize`. The plugin issues a code without ever
 * asking the user, so an anonymous request is bounced to the fork's consent
 * page (before the plugin can set its login-resume cookie) and a signed-in one
 * must carry the proof that page mints for this exact user and parameters.
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

/** Called after a successful refresh: the consumed refresh token must die. */
export const deleteConsumedRefreshToken = async (refreshToken: string) => {
	if (!refreshToken) return;
	await db
		.delete(oauthAccessToken)
		.where(eq(oauthAccessToken.refreshToken, refreshToken));
};

/**
 * Removes rows that can never be used again: the refresh window closed, or the
 * access token expired and no usable refresh window exists — either because
 * there is no refresh token at all, or because its expiry was never recorded.
 */
export const purgeExpiredMcpTokens = async () => {
	const now = new Date();
	await db
		.delete(oauthAccessToken)
		.where(
			or(
				lt(oauthAccessToken.refreshTokenExpiresAt, now),
				and(
					isNull(oauthAccessToken.refreshToken),
					lt(oauthAccessToken.accessTokenExpiresAt, now),
				),
				and(
					isNull(oauthAccessToken.refreshTokenExpiresAt),
					lt(oauthAccessToken.accessTokenExpiresAt, now),
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
 * Records the grant the user approved on the consent page. Token rows are
 * rotated away on every refresh, so they cannot date the original grant; this
 * row can.
 *
 * The row replaces any earlier grant for the same client: re-authorizing keeps
 * one row per (user, client), so `authorizedAt` reflects the grant actually in
 * force and the table cannot grow without bound.
 */
export const recordMcpConsent = async (
	userId: string,
	clientId: string,
	scopes: string[],
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
		scopes: scopes.join(" "),
		consentGiven: true,
		createdAt: now,
		updatedAt: now,
	});
};

/**
 * One row per client the user has authorized, newest token wins for scopes.
 * `authorizedAt` is the latest consent, since `recordMcpConsent` replaces the
 * previous grant for the client rather than adding to it.
 */
export const listMcpAuthorizations = async (
	userId: string,
): Promise<McpAuthorization[]> => {
	// Never project the token columns: this list is rendered in the UI.
	const rows = await db.query.oauthAccessToken.findMany({
		where: eq(oauthAccessToken.userId, userId),
		columns: {
			clientId: true,
			scopes: true,
			createdAt: true,
			refreshTokenExpiresAt: true,
		},
		orderBy: [asc(oauthAccessToken.createdAt)],
		limit: MCP_AUTHORIZATION_ROW_LIMIT,
		with: { application: { columns: { name: true } } },
	});
	const consents = await db.query.oauthConsent.findMany({
		where: eq(oauthConsent.userId, userId),
		columns: { clientId: true, createdAt: true },
		orderBy: [asc(oauthConsent.createdAt)],
		limit: MCP_AUTHORIZATION_ROW_LIMIT,
	});
	const grantedAt = new Map<string, Date>();
	for (const consent of consents) {
		if (!grantedAt.has(consent.clientId)) {
			grantedAt.set(consent.clientId, consent.createdAt);
		}
	}
	const byClient = new Map<string, McpAuthorization>();
	for (const row of rows) {
		const existing = byClient.get(row.clientId);
		const scopes = row.scopes
			.split(" ")
			.filter((scope) => scope.startsWith("dokploy:"));
		if (!existing) {
			byClient.set(row.clientId, {
				clientId: row.clientId,
				clientName: row.application?.name || "Unnamed client",
				scopes,
				// Falls back to the oldest surviving token for grants made before
				// consent rows were recorded.
				authorizedAt: grantedAt.get(row.clientId) ?? row.createdAt,
				lastRefreshedAt: row.createdAt,
				refreshExpiresAt: row.refreshTokenExpiresAt,
			});
			continue;
		}
		existing.scopes = scopes;
		existing.lastRefreshedAt = row.createdAt;
		existing.refreshExpiresAt = row.refreshTokenExpiresAt;
	}
	return [...byClient.values()];
};

/**
 * Deletes every token and consent row for client+user; the client's next call
 * gets 401 and a re-authorization starts a fresh grant.
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
		.delete(oauthConsent)
		.where(
			and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)),
		);
};
