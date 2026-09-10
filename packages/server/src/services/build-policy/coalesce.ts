import type { BuildPolicyAuditAction } from "@dokploy/server/db/schema";
import type { BuildPolicyUnitType } from "./policy";

/**
 * Queue coalescing (spec 5.2.5).
 *
 * Before enqueueing a deploy for a unit, drop the deploys for that same unit
 * that are still *waiting*. Running builds are left alone. N pushes therefore
 * produce one build of the newest commit.
 *
 * Coalescing is best-effort: neither a queue failure nor an audit failure may
 * stop the deploy that is being enqueued.
 */
export interface CoalesceAuditEntry {
	organizationId: string;
	action: BuildPolicyAuditAction;
	applicationId: string | null;
	composeId: string | null;
	metadata: Record<string, unknown>;
}

export interface CoalesceQueuedDeployInput {
	unitType: BuildPolicyUnitType;
	unitId: string;
	unitName?: string;
	organizationId: string;
	/** Removes still-waiting jobs for this unit; returns how many it removed. */
	removeWaiting: () => Promise<number> | number;
	recordAudit: (entry: CoalesceAuditEntry) => Promise<unknown>;
}

export const coalesceQueuedDeploy = async ({
	unitType,
	unitId,
	unitName,
	organizationId,
	removeWaiting,
	recordAudit,
}: CoalesceQueuedDeployInput): Promise<{ removed: number }> => {
	let removed = 0;
	try {
		removed = (await removeWaiting()) ?? 0;
	} catch (error) {
		console.error("[build-policy] queue coalescing failed", error);
		return { removed: 0 };
	}

	if (removed <= 0) return { removed: 0 };

	try {
		await recordAudit({
			organizationId,
			action: "deploy_coalesced",
			applicationId: unitType === "application" ? unitId : null,
			composeId: unitType === "compose" ? unitId : null,
			metadata: { removed, unitType, unitName },
		});
	} catch (error) {
		console.error("[build-policy] failed to audit queue coalescing", error);
	}

	return { removed };
};
