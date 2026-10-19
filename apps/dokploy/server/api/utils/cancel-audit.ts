import type {
	DeploymentCancelAuditAction,
	DeploymentCancelAuditTargetType,
} from "@dokploy/server/db/schema";
import { recordDeploymentCancelAudit } from "@dokploy/server/services/deployment-cancel-audit";

interface CancelAuditCtx {
	user: { id: string; email: string };
	session: {
		activeOrganizationId: string;
		apiKeyId?: string;
		oauthClientId?: string;
		impersonatedBy?: string | null;
	};
}

interface CancelAuditEvent {
	action: DeploymentCancelAuditAction;
	targetType: DeploymentCancelAuditTargetType;
	targetId?: string | null;
	targetName?: string | null;
	applicationId?: string | null;
	composeId?: string | null;
	deploymentId?: string | null;
	metadata?: Record<string, unknown>;
}

/**
 * Records who cancelled, killed or dropped a deployment or queued job in the
 * fork's own trail, which (unlike `audit()`) needs no enterprise license. The
 * actor is read from the tRPC context; a request that authenticated with an
 * API key, over REST or MCP, also carries the key id; one that came in on an
 * OAuth access token (an MCP client) carries the client id. Best-effort: it never
 * throws, so it can sit right next to the cancel it describes.
 */
export const auditCancel = (ctx: CancelAuditCtx, event: CancelAuditEvent) =>
	recordDeploymentCancelAudit({
		organizationId: ctx.session.activeOrganizationId,
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
		...event,
		// An admin acting as someone else: the entry names the user, this the admin.
		...(ctx.session.impersonatedBy
			? {
					metadata: {
						...event.metadata,
						impersonatedBy: ctx.session.impersonatedBy,
					},
				}
			: {}),
	});
