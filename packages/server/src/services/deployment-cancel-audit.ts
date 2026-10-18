import { db } from "@dokploy/server/db";
import {
	type DeploymentCancelAuditAction,
	type DeploymentCancelAuditActorType,
	type DeploymentCancelAuditTargetType,
	deploymentCancelAudit,
} from "@dokploy/server/db/schema";
import { and, desc, eq } from "drizzle-orm";

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
