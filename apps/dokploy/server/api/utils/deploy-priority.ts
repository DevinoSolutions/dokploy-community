import { checkPermission } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import type {
	PriorityOutcome,
	PriorityReason,
} from "@/server/queues/in-memory-queue";
import { audit } from "./audit";

/**
 * Helpers for the deploy queue priority lane. The rules are in
 * docs/design/deploy-queue-priority.md, the user instructions in
 * docs/deploy-queue-priority.md.
 */

type PriorityCtx = Parameters<typeof audit>[0];

export const PRIORITY_DENIED_MESSAGE =
	"Deploying ahead of the queue needs the deployment priority permission (owners and admins have it; an enterprise custom role can be given it).";

/**
 * Refuse a priority request from a caller without `deployment:priority`.
 * Always throws rather than quietly deploying in arrival order: the caller asked
 * for something specific and should know it did not happen.
 */
export const assertCanPrioritize = async (ctx: PriorityCtx) => {
	try {
		await checkPermission(ctx, { deployment: ["priority"] });
	} catch {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: PRIORITY_DENIED_MESSAGE,
		});
	}
};

export type PriorityResultReason = PriorityReason | "not-queued";

/** What the deploy, redeploy and prioritizeQueued calls return for a priority request. */
export interface PriorityResult {
	requested: true;
	/** The job is ahead of the jobs that were waiting, or will be when it starts. */
	applied: boolean;
	/** Waiting jobs in the queue lane that it went ahead of. */
	wentAheadOf: number;
	reason?: PriorityResultReason;
	message: string;
}

const messageFor = (outcome: PriorityOutcome | undefined): string => {
	if (!outcome) {
		return "This deploy does not go through the local queue, so there was nothing to go ahead of.";
	}
	if (outcome.applied) {
		const n = outcome.wentAheadOf;
		return `Queued ahead of ${n} waiting job${n === 1 ? "" : "s"}; it starts as soon as a build slot is free.`;
	}
	if (outcome.reason === "nothing-waiting") {
		return "No other job was waiting in this queue, so it was queued normally and the priority flag was not stored.";
	}
	if (outcome.reason === "first-in-line") {
		return "Nothing ahead of this job could start before it (it is next in line, or the jobs ahead are waiting on a running job of their own service), so there was nothing to go ahead of.";
	}
	if (outcome.reason === "older-same-service") {
		return "An older deploy of the same service is still waiting, and a priority deploy never goes ahead of its own service's older work. This job keeps its priority flag and may go ahead of other services' jobs once the older deploy has run.";
	}
	return "Another priority deploy is running or has just started in this queue. This job keeps its priority flag and goes ahead of the waiting jobs as soon as that is allowed.";
};

export const toPriorityResult = (
	outcome: PriorityOutcome | undefined,
): PriorityResult => ({
	requested: true,
	applied: outcome?.applied ?? false,
	wentAheadOf: outcome?.wentAheadOf ?? 0,
	reason: outcome ? outcome.reason : "not-queued",
	message: messageFor(outcome),
});

export interface PriorityUse {
	resourceType: "application" | "compose";
	resourceId: string;
	resourceName: string;
	/** Which call asked for it. */
	via: "deploy" | "redeploy" | "prioritizeQueued";
	jobId?: string;
	outcome: PriorityOutcome | undefined;
}

/**
 * Record who used the priority lane and what it did: an audit entry (kept for
 * licensed organizations, like every audit entry) and a console line, which is
 * always written so the use is traceable without a license too.
 */
export const recordPriorityUse = async (
	ctx: PriorityCtx,
	use: PriorityUse,
): Promise<PriorityResult> => {
	const result = toPriorityResult(use.outcome);
	console.log(
		`[queue-priority] ${ctx.user.email} (${ctx.user.role}) asked for priority on ${use.resourceType} ${use.resourceId} via ${use.via}: applied=${result.applied} wentAheadOf=${result.wentAheadOf}${result.reason ? ` reason=${result.reason}` : ""}`,
	);
	await audit(ctx, {
		action: "prioritize",
		resourceType: use.resourceType,
		resourceId: use.resourceId,
		resourceName: use.resourceName,
		metadata: {
			via: use.via,
			jobId: use.jobId,
			applied: result.applied,
			wentAheadOf: result.wentAheadOf,
			reason: result.reason,
		},
	});
	return result;
};
