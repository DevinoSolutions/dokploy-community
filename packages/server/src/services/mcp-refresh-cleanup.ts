import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { oauthAccessToken, oauthRefreshToken } from "../db/schema";
import { getMcpRefreshGraceSeconds, hashOAuthToken } from "./mcp-oauth";

/**
 * Retires the access tokens a refresh made obsolete.
 *
 * The provider links every opaque access token to the refresh token issued
 * with it (`refresh_id`). A refresh_token grant rotates the presented refresh
 * row (sets `rotated_at` and `revoked`) and issues a new pair, but leaves the
 * access token minted with the rotated row alive until it expires
 * (DOKPLOY_MCP_ACCESS_TOKEN_HOURS). Since #214 the fork clamped the consumed
 * token to the rotation grace window after each refresh
 * (`consumeRotatedRefreshToken`); the 1.7 port (498fa20b2) dropped that step,
 * and this restores it.
 *
 * The token is clamped, not deleted: many MCP sessions share one grant, and
 * the siblings still holding the old token keep working until they pick up
 * the new one (deleting it would 401 them all, and each 401 refreshes again
 * and retires the token the others just switched to). A replay inside the
 * provider's reuse window can also hand back a token that a later refresh has
 * already retired; the clamp keeps it usable for the window.
 *
 * LEAST() only ever shortens the expiry; `findMcpAccessToken` refuses the row
 * once it has passed and the daily purge removes it. `revoked` is not used:
 * any value there makes the token dead at once. With
 * DOKPLOY_MCP_REFRESH_GRACE_SECONDS=0 the row is deleted outright.
 *
 * Only access tokens of the rotated refresh row are touched, and only when the
 * token just issued belongs to the same client and user and hangs off another
 * refresh row. The issued token itself is never matched. Returns the number
 * of rows clamped or deleted.
 */
export const retireSupersededMcpAccessTokens = async (
	consumedRefreshToken: string,
	issuedAccessToken: string,
	// Injected like the env helpers in mcp-oauth: the vitest config statically
	// `define`s process.env, so tests cannot stub it.
	graceSeconds: number = getMcpRefreshGraceSeconds(),
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
	const superseded = and(
		eq(oauthAccessToken.refreshId, consumed.id),
		eq(oauthAccessToken.clientId, consumed.clientId),
		eq(oauthAccessToken.userId, consumed.userId),
		ne(oauthAccessToken.id, issued.id),
	);

	if (graceSeconds <= 0) {
		const deleted = await db
			.delete(oauthAccessToken)
			.where(superseded)
			.returning({ id: oauthAccessToken.id });
		return deleted.length;
	}

	// A value interpolated into a raw `sql` template bypasses the column's
	// driver mapping, so a Date reaches postgres-js as-is and its parameter
	// encoder throws (`The "string" argument must be of type string ... Received
	// an instance of Date`). Serialise the way drizzle's timestamp column does.
	const until = new Date(Date.now() + graceSeconds * 1000).toISOString();
	const clamped = await db
		.update(oauthAccessToken)
		.set({
			expiresAt: sql`LEAST(${oauthAccessToken.expiresAt}, ${until}::timestamp)`,
		})
		.where(superseded)
		.returning({ id: oauthAccessToken.id });
	return clamped.length;
};

/**
 * `hooks.after` step for `/oauth2/token`: once a refresh_token grant has
 * answered with new tokens, retires the access tokens it superseded. Errors
 * are logged and swallowed, so the token response is never affected.
 */
export const cleanupAfterMcpTokenGrant = async (
	body: Record<string, unknown>,
	returned: unknown,
	graceSeconds: number = getMcpRefreshGraceSeconds(),
) => {
	if (body.grant_type !== "refresh_token") return;
	if (typeof body.refresh_token !== "string") return;
	const accessToken =
		returned && typeof returned === "object"
			? (returned as { access_token?: unknown }).access_token
			: undefined;
	if (typeof accessToken !== "string") return;
	try {
		await retireSupersededMcpAccessTokens(
			body.refresh_token,
			accessToken,
			graceSeconds,
		);
	} catch (error) {
		console.error("[mcp] failed to retire superseded access tokens", error);
	}
};
