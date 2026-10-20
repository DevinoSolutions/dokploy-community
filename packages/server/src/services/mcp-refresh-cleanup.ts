import { and, eq, ne } from "drizzle-orm";
import { db } from "../db";
import { oauthAccessToken, oauthRefreshToken } from "../db/schema";
import { hashOAuthToken } from "./mcp-oauth";

/**
 * Deletes the access tokens a refresh made obsolete.
 *
 * The provider links every opaque access token to the refresh token issued
 * with it (`refresh_id`). A refresh_token grant rotates the presented refresh
 * row (sets `rotated_at` and `revoked`) and issues a new pair, but leaves the
 * access token minted with the rotated row alive until it expires
 * (DOKPLOY_MCP_ACCESS_TOKEN_HOURS). Under 1.6 the fork deleted the consumed
 * access token after each refresh; this restores that.
 *
 * Only access tokens of the rotated refresh row go, and only when the token
 * just issued belongs to the same client and user and hangs off another
 * refresh row. The issued token itself is never matched. Returns the number
 * of rows deleted.
 */
export const deleteSupersededMcpAccessTokens = async (
	consumedRefreshToken: string,
	issuedAccessToken: string,
) => {
	if (!consumedRefreshToken || !issuedAccessToken) return 0;
	const consumed = await db.query.oauthRefreshToken.findFirst({
		where: eq(oauthRefreshToken.token, hashOAuthToken(consumedRefreshToken)),
		columns: { id: true, clientId: true, userId: true, rotatedAt: true },
	});
	if (!consumed?.rotatedAt) return 0;
	const issued = await db.query.oauthAccessToken.findFirst({
		where: eq(oauthAccessToken.token, hashOAuthToken(issuedAccessToken)),
		columns: { id: true, clientId: true, userId: true, refreshId: true },
	});
	if (
		!issued ||
		issued.clientId !== consumed.clientId ||
		issued.userId !== consumed.userId ||
		issued.refreshId === consumed.id
	) {
		return 0;
	}
	const deleted = await db
		.delete(oauthAccessToken)
		.where(
			and(
				eq(oauthAccessToken.refreshId, consumed.id),
				eq(oauthAccessToken.clientId, consumed.clientId),
				eq(oauthAccessToken.userId, consumed.userId),
				ne(oauthAccessToken.id, issued.id),
			),
		)
		.returning({ id: oauthAccessToken.id });
	return deleted.length;
};

/**
 * `hooks.after` step for `/oauth2/token`: once a refresh_token grant has
 * answered with new tokens, removes the access tokens it superseded. Errors
 * are logged and swallowed, so the token response is never affected.
 */
export const cleanupAfterMcpTokenGrant = async (
	body: Record<string, unknown>,
	returned: unknown,
) => {
	if (body.grant_type !== "refresh_token") return;
	if (typeof body.refresh_token !== "string") return;
	const accessToken =
		returned && typeof returned === "object"
			? (returned as { access_token?: unknown }).access_token
			: undefined;
	if (typeof accessToken !== "string") return;
	try {
		await deleteSupersededMcpAccessTokens(body.refresh_token, accessToken);
	} catch (error) {
		console.error("[mcp] failed to delete superseded access tokens", error);
	}
};
