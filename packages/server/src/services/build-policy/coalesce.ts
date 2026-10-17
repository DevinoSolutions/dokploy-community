import type { BuildPolicyAuditAction } from "@dokploy/server/db/schema";
import type { BuildPolicyUnitType } from "./policy";

/**
 * Queue coalescing (spec 5.2.5).
 *
 * Before enqueueing a deploy for a unit, fold it into the oldest deploy for
 * that same unit that is still *waiting* (same type, same freshVolumes and
 * priority flags): that job keeps its place in the queue but takes the incoming
 * title, description and pinned image, and the other waiting duplicates are
 * dropped. Running builds are left alone. N pushes therefore produce one build,
 * at the earliest slot, of the newest commit. When the push was folded in
 * (`merged`) the caller must not enqueue it; when nothing waited it enqueues
 * as usual. A waiting manual redeploy is a different type and is never touched.
 *
 * The caller's `removeWaiting` must touch only the unit's own plain deploys — a
 * queued PR preview for the same application is a different job that nobody
 * asked to cancel. It returns the titles of what it replaced or dropped so the
 * audit entry names them.
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
	/**
	 * Waiting jobs taken out of the queue. The job a push was merged into stays
	 * queued, so it is not counted here; `merged` reports it.
	 */
	removed: number;
	/** Titles of the builds that will not run: dropped, or replaced by the merge. */
	titles?: string[];
	/** The incoming push was folded into a waiting job; do not enqueue it. */
	merged?: boolean;
}

export interface CoalesceQueuedDeployInput {
	unitType: BuildPolicyUnitType;
	unitId: string;
	unitName?: string;
	organizationId: string;
	/**
	 * Folds the incoming push into this unit's oldest still-waiting plain deploy
	 * and drops the other waiting duplicates. Either a count of the jobs dropped
	 * or a `{removed, titles, merged}` record.
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
		: {
				removed: result?.removed ?? 0,
				titles: result?.titles,
				merged: result?.merged,
			};

export const coalesceQueuedDeploy = async ({
	unitType,
	unitId,
	unitName,
	organizationId,
	removeWaiting,
	recordAudit,
}: CoalesceQueuedDeployInput): Promise<{
	removed: number;
	merged?: true;
}> => {
	let result: CoalesceRemoval;
	try {
		result = normalize(await removeWaiting());
	} catch (error) {
		console.error("[build-policy] queue coalescing failed", error);
		return { removed: 0 };
	}

	if (result.removed <= 0 && !result.merged) return { removed: 0 };

	try {
		await recordAudit({
			organizationId,
			action: "deploy_coalesced",
			applicationId: unitType === "application" ? unitId : null,
			composeId: unitType === "compose" ? unitId : null,
			metadata: {
				// Jobs dropped from the queue; a merge is reported by `merged`.
				removed: result.removed,
				...(result.merged ? { merged: true } : {}),
				unitType,
				unitName,
				// So a dropped or replaced deploy is traceable to the push it came from.
				...(result.titles?.length ? { droppedTitles: result.titles } : {}),
			},
		});
	} catch (error) {
		console.error("[build-policy] failed to audit queue coalescing", error);
	}

	return result.merged
		? { removed: result.removed, merged: true }
		: { removed: result.removed };
};
