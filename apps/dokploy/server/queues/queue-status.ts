import { getPartition, type InMemoryJob, type Lane } from "./in-memory-queue";

/**
 * What `deployment.queueStatus` tells a caller about one service's deploy in the
 * local queue (T-12497). It exists because a deploy that waits in the queue has
 * no deployment row of its own, so a client (the GitHub Actions deploy action)
 * could only see "nothing" or, with a registered row, "running" for the whole
 * wait. The answer says whether the deploy is waiting or running, so a client can
 * give the wait its own, longer limit and start its run limit at `startedAt`.
 *
 * Names no job id: the caller already knows its service, and job ids restart with
 * the process.
 */
export interface QueueStatus {
	/** `queued`: waiting for a slot. `running`: a slot is held. `none`: not in the queue. */
	state: "queued" | "running" | "none";
	/**
	 * The cap the deploy counts against; null when `none`. Not final while
	 * `queued`: a deploy is read again just before it starts and can move from
	 * `pull` to `build` if its service changed.
	 */
	lane: Lane | null;
	/**
	 * Place in the list of jobs waiting in its lane on its server (1 = first in the
	 * list); null unless `queued`. A list order, not a forecast: a prioritized
	 * deploy can start before it, and a job ahead whose service is busy can start
	 * after it.
	 */
	position: number | null;
	/** Jobs listed before it in that lane on its server; null unless `queued`. */
	ahead: number | null;
	/**
	 * `running` only: how many deploys of the same service wait behind the running
	 * one. Above 0, the running deploy is not necessarily the caller's (one service
	 * never runs two deploys at once, so a newer deploy waits for the older one):
	 * send the deploymentId to be exact. Null when not `running`.
	 */
	queuedBehind: number | null;
	/**
	 * How long the deploy waited: so far when `queued`, in total when `running`
	 * (until it started); null when `none`.
	 */
	waitingSinceMs: number | null;
	/** Epoch ms the deploy started; null unless `running`. */
	startedAt: number | null;
	/** Why a waiting deploy is not starting although a slot may be free (an update is in progress). */
	heldReason: "intake-closed-for-update" | null;
	/**
	 * The boot restore of the queue is not over, so jobs the previous process left
	 * waiting may not be listed yet: a `none` is not final until this is false.
	 */
	restoring: boolean;
}

/**
 * One job of a queue snapshot. Whether it runs is read from the snapshot itself (a
 * job has `processedOn` once a slot took it), never from the live queue, so one
 * job cannot be reported with a state and fields of two different moments.
 */
export interface QueueStatusJob {
	job: InMemoryJob;
}

export interface QueueStatusTarget {
	applicationId?: string;
	composeId?: string;
	/** The registered GitHub Actions row the deploy continues. */
	deploymentId?: string;
}

export interface QueueStatusContext {
	now: number;
	intakeClosed: boolean;
	restoring: boolean;
}

const NONE = (restoring: boolean): QueueStatus => ({
	state: "none",
	lane: null,
	position: null,
	ahead: null,
	waitingSinceMs: null,
	startedAt: null,
	heldReason: null,
	restoring,
	queuedBehind: null,
});

const laneOf = (job: InMemoryJob): Lane =>
	job.lane === "pull" ? "pull" : "build";

/**
 * Does this job deploy the target service itself (not one of its previews)? A job
 * of another service, or of the same id under the other kind, never matches.
 */
const deploysService = (job: InMemoryJob, target: QueueStatusTarget) => {
	const data = job.data as {
		applicationType?: string;
		applicationId?: string;
		composeId?: string;
		deploymentId?: string;
	};
	if (target.applicationId) {
		if (data.applicationType !== "application") return false;
		if (data.applicationId !== target.applicationId) return false;
	} else if (target.composeId) {
		if (data.applicationType !== "compose") return false;
		if (data.composeId !== target.composeId) return false;
	} else {
		return false;
	}
	return !target.deploymentId || data.deploymentId === target.deploymentId;
};

/** The same target without the registered row: every deploy of the service. */
const serviceOnly = (target: QueueStatusTarget): QueueStatusTarget => ({
	applicationId: target.applicationId,
	composeId: target.composeId,
});

/**
 * The status of the target's deploy in a snapshot of the queue (waiting and
 * running jobs, in queue order per server). With a deployment id only the job that
 * carries that row answers, whatever else the service has in the queue. Without
 * one the service's current deploy does (a running one, else the oldest waiting
 * one), and `queuedBehind` says when the caller's own deploy may be one of those
 * waiting behind it.
 */
export const describeQueueStatus = (
	snapshot: QueueStatusJob[],
	target: QueueStatusTarget,
	context: QueueStatusContext,
): QueueStatus => {
	const matching = snapshot.filter(({ job }) => deploysService(job, target));
	const hasStarted = (entry: QueueStatusJob) =>
		entry.job.processedOn !== undefined;
	const running = matching.find(hasStarted);
	if (running) {
		const { job } = running;
		const startedAt = job.processedOn as number;
		return {
			...NONE(context.restoring),
			state: "running",
			lane: laneOf(job),
			waitingSinceMs: Math.max(0, startedAt - job.timestamp),
			startedAt,
			// Waiting deploys of the same service (one service never runs two at once).
			queuedBehind: snapshot.filter(
				(entry) =>
					!hasStarted(entry) && deploysService(entry.job, serviceOnly(target)),
			).length,
		};
	}
	const first = matching.find((entry) => !hasStarted(entry));
	if (!first) return NONE(context.restoring);

	const { job } = first;
	const lane = laneOf(job);
	const partition = getPartition(job.data);
	let ahead = 0;
	for (const other of snapshot) {
		if (other === first) break;
		if (
			!hasStarted(other) &&
			laneOf(other.job) === lane &&
			getPartition(other.job.data) === partition
		) {
			ahead++;
		}
	}
	return {
		...NONE(context.restoring),
		state: "queued",
		lane,
		position: ahead + 1,
		ahead,
		waitingSinceMs: Math.max(0, context.now - job.timestamp),
		heldReason: context.intakeClosed ? "intake-closed-for-update" : null,
	};
};
