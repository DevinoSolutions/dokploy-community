import type { BuildPolicyAuditAction } from "@dokploy/server/db/schema";
import type { BuildPolicyUnitType } from "./policy";

/**
 * Queue coalescing (spec 5.2.5).
 *
 * Before enqueueing a deploy for a unit, drop the deploys for that same unit
 * that are still *waiting*. Running builds are left alone. N pushes therefore
 * produce one build of the newest commit.
 *
 * The caller's `removeWaiting` must drop only the unit's own plain deploys — a
 * queued PR preview for the same application is a different job that nobody
 * asked to cancel. It returns the titles of what it dropped so the audit entry
 * names them.
 *
 * Coalescing is best-effort: neither a queue failure nor an audit failure may
 * stop the deploy that is being enqueued.
 */
/**
 * Which waiting jobs a coalescing pass may drop.
 *
 * Only the unit's own **plain** deploys. A queued PR preview carries the same
 * `applicationId` (or `composeId`) but a different `applicationType`, and
 * nobody asked to cancel it: it belongs to a pull request, not to the push that
 * is being coalesced. Upstream's `cleanQueuesBy*` helpers deliberately drop
 * everything because they back an explicit "clean queues" button; coalescing
 * runs automatically on every push, which is a different contract.
 *
 * The rule lives here rather than in the queue so both queue helpers and the
 * tests read the same predicate.
 */
export const isCoalescableDeployJob = (
	unitType: BuildPolicyUnitType,
	unitId: string,
	data: unknown,
): boolean => {
	if (data === null || typeof data !== "object") return false;
	const job = data as Record<string, unknown>;
	if (unitType === "application") {
		return (
			job.applicationType === "application" && job.applicationId === unitId
		);
	}
	return job.applicationType === "compose" && job.composeId === unitId;
};

export interface CoalesceAuditEntry {
	organizationId: string;
	action: BuildPolicyAuditAction;
	applicationId: string | null;
	composeId: string | null;
	metadata: Record<string, unknown>;
}

export interface CoalesceRemoval {
	removed: number;
	titles?: string[];
}

export interface CoalesceQueuedDeployInput {
	unitType: BuildPolicyUnitType;
	unitId: string;
	unitName?: string;
	organizationId: string;
	/**
	 * Removes this unit's still-waiting plain deploys. Either a count or a
	 * `{removed, titles}` record.
	 */
	removeWaiting: () =>
		| Promise<number | CoalesceRemoval>
		| number
		| CoalesceRemoval;
	recordAudit: (entry: CoalesceAuditEntry) => Promise<unknown>;
}

const normalize = (
	result: number | CoalesceRemoval | undefined | null,
): CoalesceRemoval =>
	typeof result === "number"
		? { removed: result }
		: { removed: result?.removed ?? 0, titles: result?.titles };

export const coalesceQueuedDeploy = async ({
	unitType,
	unitId,
	unitName,
	organizationId,
	removeWaiting,
	recordAudit,
}: CoalesceQueuedDeployInput): Promise<{ removed: number }> => {
	let result: CoalesceRemoval;
	try {
		result = normalize(await removeWaiting());
	} catch (error) {
		console.error("[build-policy] queue coalescing failed", error);
		return { removed: 0 };
	}

	if (result.removed <= 0) return { removed: 0 };

	try {
		await recordAudit({
			organizationId,
			action: "deploy_coalesced",
			applicationId: unitType === "application" ? unitId : null,
			composeId: unitType === "compose" ? unitId : null,
			metadata: {
				removed: result.removed,
				unitType,
				unitName,
				// So a dropped deploy is traceable to the push it came from.
				...(result.titles?.length ? { droppedTitles: result.titles } : {}),
			},
		});
	} catch (error) {
		console.error("[build-policy] failed to audit queue coalescing", error);
	}

	return { removed: result.removed };
};
