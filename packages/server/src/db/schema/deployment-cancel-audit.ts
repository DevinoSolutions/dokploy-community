import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";

/**
 * Fork module: who cancelled, killed or dropped a deployment or a queued job.
 *
 * `audit_log` (enterprise) only records anything on a licensed instance, so
 * this narrow trail is written on every instance. It holds the action, the
 * actor, the organization and the target; never a request body or a secret.
 * The targets are plain ids with no foreign keys on purpose: the trail has to
 * outlive the service or deployment it names.
 */

export type DeploymentCancelAuditAction =
	| "cancel_deployment"
	| "kill_build"
	| "kill_process"
	| "remove_deployment"
	| "clear_deployments"
	| "clean_queue"
	| "keep_oldest_queue"
	| "clear_all_queues"
	| "coalesce_drop";

/** `system` is an internal path with no caller (coalescing on a push). */
export type DeploymentCancelAuditActorType =
	| "user"
	| "api_key"
	| "oauth_client"
	| "system";

export type DeploymentCancelAuditTargetType =
	| "application"
	| "compose"
	| "deployment"
	| "queue";

export const deploymentCancelAudit = pgTable(
	"deployment_cancel_audit",
	{
		deploymentCancelAuditId: text("deploymentCancelAuditId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		action: text("action").$type<DeploymentCancelAuditAction>().notNull(),
		actorType: text("actorType")
			.$type<DeploymentCancelAuditActorType>()
			.notNull(),
		/** The user, also for an API key call (the key's owner). Null for `system`. */
		actorId: text("actorId"),
		actorEmail: text("actorEmail"),
		/** Set when the request authenticated with an API key (also over MCP). */
		apiKeyId: text("apiKeyId"),
		/**
		 * Set when the request authenticated with an OAuth access token (an MCP
		 * client). The client's public id only, never the token.
		 */
		oauthClientId: text("oauthClientId"),
		targetType: text("targetType")
			.$type<DeploymentCancelAuditTargetType>()
			.notNull(),
		targetId: text("targetId"),
		/** The application or compose appName, or the deployment title. */
		targetName: text("targetName"),
		applicationId: text("applicationId"),
		composeId: text("composeId"),
		deploymentId: text("deploymentId"),
		/** JSON.stringify'd, matching `audit_log.metadata`. Counts and job ids only. */
		metadata: text("metadata"),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
	},
	(t) => ({
		orgIdx: index("deploymentCancelAudit_organizationId_idx").on(
			t.organizationId,
		),
		targetIdx: index("deploymentCancelAudit_targetId_idx").on(t.targetId),
		createdAtIdx: index("deploymentCancelAudit_createdAt_idx").on(t.createdAt),
	}),
);

export type DeploymentCancelAudit = typeof deploymentCancelAudit.$inferSelect;
