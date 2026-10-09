import type { IncomingMessage, ServerResponse } from "node:http";
import { auth } from "@dokploy/server/index";
import {
	MCP_PLUGIN_AUTHORIZE_PATH,
	resolveMcpOrigin,
	rewriteLegacyAuthUrl,
	withAdvertisedIssuer,
} from "@dokploy/server/services/mcp-oauth";
import {
	getRefreshTokenLock,
	serializeRefreshGrants,
} from "@dokploy/server/services/mcp-refresh-lock";
import { toNodeHandler } from "better-auth/node";
import { isHttpsRequest, secureSetCookie } from "@/lib/secure-cookies";

// Disallow body parsing, we will parse it manually
export const config = { api: { bodyParser: false } };

// Concurrent refreshes of one MCP refresh token are serialized so the losers
// receive the winner's replay instead of invalid_grant (see mcp-refresh-lock).
const handler = serializeRefreshGrants(
	toNodeHandler(auth.handler),
	getRefreshTokenLock(),
);

const pathOf = (url: string | undefined) => (url ?? "").split("?")[0];

export default async function authHandler(
	req: IncomingMessage,
	res: ServerResponse,
) {
	// 1.6 routes (MCP OAuth under /mcp/*, the SAML callback) keep working for
	// clients and IdPs configured before the better-auth 1.7 upgrade.
	if (req.url) req.url = rewriteLegacyAuthUrl(req.url);

	// Mark the session cookie as Secure when the request comes over HTTPS
	if (isHttpsRequest(req.headers["x-forwarded-proto"])) {
		const setHeader = res.setHeader.bind(res);
		res.setHeader = (name, value) =>
			String(name).toLowerCase() === "set-cookie"
				? setHeader(name, secureSetCookie(value))
				: setHeader(name, value);

		const appendHeader = res.appendHeader?.bind(res);
		if (appendHeader) {
			res.appendHeader = (name, value) =>
				String(name).toLowerCase() === "set-cookie"
					? appendHeader(name, secureSetCookie(value) as string | string[])
					: appendHeader(name, value);
		}
	}

	// Authorization responses carry the issuer the discovery document
	// advertises (see withAdvertisedIssuer).
	if (pathOf(req.url) === MCP_PLUGIN_AUTHORIZE_PATH) {
		const issuer = await resolveMcpOrigin(req.headers).catch(() => null);
		if (issuer) {
			const setHeader = res.setHeader.bind(res);
			res.setHeader = (name, value) =>
				String(name).toLowerCase() === "location" && typeof value === "string"
					? setHeader(name, withAdvertisedIssuer(value, issuer))
					: setHeader(name, value);
		}
	}

	return handler(req, res);
}
