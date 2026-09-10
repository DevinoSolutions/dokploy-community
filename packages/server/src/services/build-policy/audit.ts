import { db } from "@dokploy/server/db";
import {
	type BuildPolicyAudit,
	type BuildPolicyAuditAction,
	buildPolicyAudit,
} from "@dokploy/server/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { BuildPolicyUnitType } from "./policy";

/**
 * Append-only trail for build-policy decisions, plus the break-glass grants
 * that live in the same table (a grant is a `break_glass_granted` row with
 * `consumedAt IS NULL`).
 */
export interface BuildPolicyAuditInput {
	organizationId: string;
	action: BuildPolicyAuditAction;
	applicationId?: string | null;
	composeId?: string | null;
	actorId?: string | null;
	actorEmail?: string | null;
	reason?: string | null;
	metadata?: Record<string, unknown> | null;
}

export const recordBuildPolicyAudit = async (
	input: BuildPolicyAuditInput,
): Promise<BuildPolicyAudit | null> => {
	try {
		const [row] = await db
			.insert(buildPolicyAudit)
			.values({
				organizationId: input.organizationId,
				action: input.action,
				applicationId: input.applicationId ?? null,
				composeId: input.composeId ?? null,
				actorId: input.actorId ?? null,
				actorEmail: input.actorEmail ?? null,
				reason: input.reason ?? null,
				metadata: input.metadata ? JSON.stringify(input.metadata) : null,
			})
			.returning();
		return row ?? null;
	} catch (error) {
		// Auditing must never take a deploy down with it.
		console.error("[build-policy] failed to write audit entry", error);
		return null;
	}
};

export const listBuildPolicyAudit = async ({
	organizationId,
	limit = 50,
	offset = 0,
}: {
	organizationId: string;
	limit?: number;
	offset?: number;
}) => {
	const [rows, total] = await Promise.all([
		db.query.buildPolicyAudit.findMany({
			where: eq(buildPolicyAudit.organizationId, organizationId),
			orderBy: [desc(buildPolicyAudit.createdAt)],
			limit,
			offset,
			with: { application: true, compose: true },
		}),
		db.$count(buildPolicyAudit, eq(buildPolicyAudit.organizationId, organizationId)),
	]);
	return { logs: rows, total };
};

const unitColumn = (unitType: BuildPolicyUnitType) =>
	unitType === "application"
		? buildPolicyAudit.applicationId
		: buildPolicyAudit.composeId;

export interface BreakGlassUnit {
	organizationId: string;
	unitType: BuildPolicyUnitType;
	unitId: string;
}

/** "Build locally once" — admin action, consumed by the next deploy. */
export const grantBreakGlass = async ({
	organizationId,
	unitType,
	unitId,
	actorId,
	actorEmail,
	reason,
}: BreakGlassUnit & {
	actorId: string | null;
	actorEmail: string;
	reason: string;
}) =>
	db
		.insert(buildPolicyAudit)
		.values({
			organizationId,
			action: "break_glass_granted",
			applicationId: unitType === "application" ? unitId : null,
			composeId: unitType === "compose" ? unitId : null,
			actorId,
			actorEmail,
			reason,
		})
		.returning();

export const findPendingBreakGlass = async ({
	organizationId,
	unitType,
	unitId,
}: BreakGlassUnit): Promise<BuildPolicyAudit | null> => {
	const row = await db.query.buildPolicyAudit.findFirst({
		where: and(
			eq(buildPolicyAudit.organizationId, organizationId),
			eq(buildPolicyAudit.action, "break_glass_granted"),
			eq(unitColumn(unitType), unitId),
			isNull(buildPolicyAudit.consumedAt),
		),
		orderBy: [desc(buildPolicyAudit.createdAt)],
	});
	return row ?? null;
};

/**
 * Stamp the grant as used and write the matching `break_glass_consumed` entry,
 * so the trail shows both who authorised the local build and which deploy
 * spent it.
 */
export const consumeBreakGlass = async ({
	grant,
	organizationId,
	unitType,
	unitId,
	metadata,
}: BreakGlassUnit & {
	grant: BuildPolicyAudit;
	metadata?: Record<string, unknown>;
}) => {
	await db
		.update(buildPolicyAudit)
		.set({ consumedAt: new Date() })
		.where(eq(buildPolicyAudit.buildPolicyAuditId, grant.buildPolicyAuditId));

	await recordBuildPolicyAudit({
		organizationId,
		action: "break_glass_consumed",
		applicationId: unitType === "application" ? unitId : null,
		composeId: unitType === "compose" ? unitId : null,
		actorId: grant.actorId,
		actorEmail: grant.actorEmail,
		reason: grant.reason,
		metadata: { grantId: grant.buildPolicyAuditId, ...metadata },
	});
};
