import { db } from "@dokploy/server/db";
import {
	apikey,
	type DeploymentCancelAuditAction,
	type DeploymentCancelAuditActorType,
	type DeploymentCancelAuditTargetType,
	deploymentCancelAudit,
	oauthClient,
} from "@dokploy/server/db/schema";
import { and, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { scheduleJob } from "node-schedule";

/**
 * Fork-owned trail of who cancelled, killed or dropped a deployment or queued
 * job. Unlike `audit_log` it does not depend on an enterprise license, and it
 * only ever holds ids, names and counts.
 */

export interface DeploymentCancelAuditActor {
	type: DeploymentCancelAuditActorType;
	userId?: string | null;
	email?: string | null;
	apiKeyId?: string | null;
	/** The OAuth client of an MCP bearer token (its public id, never the token). */
	oauthClientId?: string | null;
}

export interface RecordDeploymentCancelAuditInput {
	organizationId: string;
	action: DeploymentCancelAuditAction;
	actor: DeploymentCancelAuditActor;
	targetType: DeploymentCancelAuditTargetType;
	targetId?: string | null;
	targetName?: string | null;
	applicationId?: string | null;
	composeId?: string | null;
	deploymentId?: string | null;
	metadata?: Record<string, unknown> | null;
}

/**
 * Best-effort: a failed write is logged and swallowed, so it can never block
 * or fail the cancel it describes.
 */
export const recordDeploymentCancelAudit = async (
	input: RecordDeploymentCancelAuditInput,
): Promise<void> => {
	try {
		await db.insert(deploymentCancelAudit).values({
			organizationId: input.organizationId,
			action: input.action,
			actorType: input.actor.type,
			actorId: input.actor.userId ?? null,
			actorEmail: input.actor.email ?? null,
			apiKeyId: input.actor.apiKeyId ?? null,
			oauthClientId: input.actor.oauthClientId ?? null,
			targetType: input.targetType,
			targetId: input.targetId ?? null,
			targetName: input.targetName ?? null,
			applicationId: input.applicationId ?? null,
			composeId: input.composeId ?? null,
			deploymentId: input.deploymentId ?? null,
			metadata: input.metadata ? JSON.stringify(input.metadata) : null,
		});
	} catch (error) {
		console.error("[deployment-cancel-audit] failed to write entry", error);
	}
};

export const listDeploymentCancelAudit = async ({
	organizationId,
	targetId,
	limit = 50,
	offset = 0,
}: {
	organizationId: string;
	targetId?: string;
	limit?: number;
	offset?: number;
}) => {
	const where = and(
		eq(deploymentCancelAudit.organizationId, organizationId),
		targetId ? eq(deploymentCancelAudit.targetId, targetId) : undefined,
	);
	const [logs, total] = await Promise.all([
		db.query.deploymentCancelAudit.findMany({
			where,
			orderBy: [
				desc(deploymentCancelAudit.createdAt),
				desc(deploymentCancelAudit.deploymentCancelAuditId),
			],
			limit,
			offset,
		}),
		db.$count(deploymentCancelAudit, where),
	]);
	return { logs, total };
};

/** The actions that leave a deployment row `cancelled`. */
const DEPLOYMENT_CANCEL_ACTIONS: DeploymentCancelAuditAction[] = [
	"cancel_deployment",
	"kill_build",
	"kill_process",
];

/** Longest OAuth client name shown; the rest is cut and ends in an ellipsis. */
const OAUTH_CLIENT_NAME_MAX = 64;

/**
 * An OAuth client registers itself without authentication, so its name is
 * untrusted text that ends up in a label: drop control and bidi/format
 * characters, collapse whitespace, cap the length. Null when nothing is left,
 * so the short client id is shown instead.
 */
export const sanitizeOAuthClientName = (
	name: string | null | undefined,
): string | null => {
	const clean = (name ?? "")
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (!clean) return null;
	const chars = Array.from(clean);
	return chars.length > OAUTH_CLIENT_NAME_MAX
		? `${chars
				.slice(0, OAUTH_CLIENT_NAME_MAX - 1)
				.join("")
				.trimEnd()}\u2026`
		: clean;
};

/** How many deployments a service shows, and so how many entries come back. */
const BY_SERVICE_DEPLOYMENT_LIMIT = 50;
/** Rows read to find the latest entry of that many deployments. */
const BY_SERVICE_ROW_LIMIT = 500;

export interface DeploymentCancelledBy {
	deploymentId: string;
	action: DeploymentCancelAuditAction;
	actorType: DeploymentCancelAuditActorType;
	actorEmail: string | null;
	/** The API key's name, or null when it has none or has been deleted. */
	apiKeyName: string | null;
	/** The first characters of the API key id, to tell unnamed keys apart. */
	apiKeyShortId: string | null;
	/** The OAuth client's name, or null when it has none or has been deleted. */
	oauthClientName: string | null;
	/** The first characters of the OAuth client id, to tell unnamed clients apart. */
	oauthClientShortId: string | null;
	createdAt: Date;
}

/**
 * Who cancelled the deployments of ONE service: the latest entry per
 * deployment, newest first. Display fields only (no metadata). The caller
 * authorizes the service; the organization filter is a second guard so an
 * entry of another organization can never come back through a shared id.
 */
export const findDeploymentCancelledByService = async ({
	organizationId,
	applicationId,
	composeId,
}: {
	organizationId: string;
} & (
	| { applicationId: string; composeId?: undefined }
	| { composeId: string; applicationId?: undefined }
)): Promise<DeploymentCancelledBy[]> => {
	const rows = await db
		.select({
			deploymentId: deploymentCancelAudit.deploymentId,
			action: deploymentCancelAudit.action,
			actorType: deploymentCancelAudit.actorType,
			actorEmail: deploymentCancelAudit.actorEmail,
			apiKeyId: deploymentCancelAudit.apiKeyId,
			apiKeyName: apikey.name,
			oauthClientId: deploymentCancelAudit.oauthClientId,
			oauthClientName: oauthClient.name,
			createdAt: deploymentCancelAudit.createdAt,
		})
		.from(deploymentCancelAudit)
		.leftJoin(apikey, eq(apikey.id, deploymentCancelAudit.apiKeyId))
		.leftJoin(
			oauthClient,
			eq(oauthClient.clientId, deploymentCancelAudit.oauthClientId),
		)
		.where(
			and(
				eq(deploymentCancelAudit.organizationId, organizationId),
				applicationId
					? eq(deploymentCancelAudit.applicationId, applicationId)
					: eq(deploymentCancelAudit.composeId, composeId as string),
				isNotNull(deploymentCancelAudit.deploymentId),
				inArray(deploymentCancelAudit.action, DEPLOYMENT_CANCEL_ACTIONS),
			),
		)
		.orderBy(
			desc(deploymentCancelAudit.createdAt),
			desc(deploymentCancelAudit.deploymentCancelAuditId),
		)
		.limit(BY_SERVICE_ROW_LIMIT);

	const latest = new Map<string, DeploymentCancelledBy>();
	for (const row of rows) {
		if (!row.deploymentId || latest.has(row.deploymentId)) continue;
		latest.set(row.deploymentId, {
			deploymentId: row.deploymentId,
			action: row.action,
			actorType: row.actorType,
			actorEmail: row.actorEmail,
			apiKeyName: row.apiKeyName?.trim() || null,
			apiKeyShortId: row.apiKeyId ? row.apiKeyId.slice(0, 6) : null,
			oauthClientName: sanitizeOAuthClientName(row.oauthClientName),
			oauthClientShortId: row.oauthClientId
				? row.oauthClientId.slice(0, 6)
				: null,
			createdAt: row.createdAt,
		});
		if (latest.size >= BY_SERVICE_DEPLOYMENT_LIMIT) break;
	}
	return [...latest.values()];
};

/** Entries older than this are pruned by the daily job. */
export const DEPLOYMENT_CANCEL_AUDIT_RETENTION_DAYS = 180;

/** Deletes entries older than the retention window; returns how many went. */
export const pruneDeploymentCancelAudit = async (
	now: Date = new Date(),
): Promise<number> => {
	const cutoff = new Date(
		now.getTime() - DEPLOYMENT_CANCEL_AUDIT_RETENTION_DAYS * 86_400_000,
	);
	const removed = await db
		.delete(deploymentCancelAudit)
		.where(lt(deploymentCancelAudit.createdAt, cutoff))
		.returning({ id: deploymentCancelAudit.deploymentCancelAuditId });
	return removed.length;
};

/** Daily prune; registered from server.ts. */
export const initDeploymentCancelAuditPruneCronJob = () => {
	scheduleJob("deployment-cancel-audit-prune", "41 4 * * *", async () => {
		try {
			await pruneDeploymentCancelAudit();
		} catch (error) {
			console.error("[deployment-cancel-audit] prune failed", error);
		}
	});
};

/**
 * Clears the email of a deleted user from their entries. The user id stays
 * (a plain id with no foreign key), so the trail still tells actions apart.
 */
export const scrubDeploymentCancelAuditActorEmail = async (
	userId: string,
	executor: Pick<typeof db, "update"> = db,
): Promise<void> => {
	await executor
		.update(deploymentCancelAudit)
		.set({ actorEmail: null })
		.where(eq(deploymentCancelAudit.actorId, userId));
};
