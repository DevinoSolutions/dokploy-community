import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { and, asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import { scheduleJob } from "node-schedule";
import { db } from "../db";
import {
	member,
	oauthAccessToken,
	oauthApplication,
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

/** Scope ids the MCP OAuth server accepts. The catalogue with labels lives in apps/dokploy/server/mcp/scopes.ts. */
export const DOKPLOY_MCP_SCOPE_IDS = [
	"dokploy:read",
	"dokploy:deploy",
	"dokploy:services:write",
	"dokploy:services:delete",
	"dokploy:projects:write",
	"dokploy:projects:delete",
	"dokploy:backups",
	"dokploy:admin",
] as const;
export type DokployMcpScope = (typeof DOKPLOY_MCP_SCOPE_IDS)[number];

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
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return false;
	}
	if (parsed.protocol === "https:") return true;
	if (parsed.protocol !== "http:") return false;
	return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
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
