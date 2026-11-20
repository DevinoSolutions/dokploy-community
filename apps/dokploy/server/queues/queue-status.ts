import {
	getPartition,
	type InMemoryJob,
	type JobState,
	type Lane,
} from "./in-memory-queue";

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
	/** The cap the deploy counts against; null when `none`. */
	lane: Lane | null;
	/** Place among the jobs waiting in its lane on its server (1 = next); null unless `queued`. */
	position: number | null;
	/** Jobs waiting before it in that lane; null unless `queued`. */
	ahead: number | null;
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

/** One job of a queue snapshot, with the state it had when the snapshot was taken. */
export interface QueueStatusJob {
	job: InMemoryJob;
	state: JobState;
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

/**
 * The status of the target's deploy in a snapshot of the queue (waiting and
 * running jobs, in queue order per server). With a deployment id only the job that
 * carries that row answers; without one the service's current deploy does: a
 * running one, else the oldest waiting one.
 */
export const describeQueueStatus = (
	snapshot: QueueStatusJob[],
	target: QueueStatusTarget,
	context: QueueStatusContext,
): QueueStatus => {
	const matching = snapshot.filter(({ job }) => deploysService(job, target));
	const running = matching.find((entry) => entry.state === "active");
	if (running) {
		const { job } = running;
		return {
			...NONE(context.restoring),
			state: "running",
			lane: laneOf(job),
			waitingSinceMs:
				job.processedOn === undefined
					? null
					: Math.max(0, job.processedOn - job.timestamp),
			startedAt: job.processedOn ?? null,
		};
	}
	const first = matching.find((entry) => entry.state === "waiting");
	if (!first) return NONE(context.restoring);

	const { job } = first;
	const lane = laneOf(job);
	const partition = getPartition(job.data);
	let ahead = 0;
	for (const other of snapshot) {
		if (other === first) break;
		if (
			other.state === "waiting" &&
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
