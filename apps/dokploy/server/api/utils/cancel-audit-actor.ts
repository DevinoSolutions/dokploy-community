import type { DeployGateCaller } from "@dokploy/server/services/build-policy/webhook";

export interface CancelAuditActorCtx {
	user: { id: string; email: string };
	session: {
		apiKeyId?: string;
		oauthClientId?: string;
		impersonatedBy?: string | null;
	};
}

/**
 * Who a request is, in the shape the cancel trail stores: the signed-in user,
 * the user behind an API key (with the key id), or the user behind an OAuth
 * access token (with the client id). An admin acting as someone else is named
 * in `impersonatedBy`.
 */
export const cancelAuditCaller = (
	ctx: CancelAuditActorCtx,
): DeployGateCaller => ({
	actor: {
		type: ctx.session.apiKeyId
			? "api_key"
			: ctx.session.oauthClientId
				? "oauth_client"
				: "user",
		userId: ctx.user.id,
		email: ctx.user.email,
		apiKeyId: ctx.session.apiKeyId,
		oauthClientId: ctx.session.oauthClientId,
	},
	impersonatedBy: ctx.session.impersonatedBy,
});
