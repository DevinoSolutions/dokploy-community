import { randomUUID } from "node:crypto";
import type { DeploymentJob } from "./queue-types";

/**
 * In-memory deployment queue for self-hosted instances.
 *
 * Replaces BullMQ/Redis for deployments. The model is per-group FIFO with a
 * configurable concurrency per partition (server):
 *
 * - Jobs are partitioned by `serverId` (the local web server uses the
 *   `LOCAL_PARTITION` key). Each partition runs up to `concurrency` jobs at
 *   the same time, so two different applications can build concurrently.
 * - Within a partition, jobs that belong to the same group (same application
 *   or compose) never run in parallel — they are serialized FIFO. This avoids
 *   two builds of the same service stepping on each other (same code dir,
 *   same container name, etc).
 *
 * The concurrency is resolved lazily per partition through `resolveConcurrency`
 * so it can be gated by the enterprise license at run time (a non-licensed
 * instance always resolves to 1).
 *
 * Priority lane (docs/design/deploy-queue-priority.md): a job whose payload
 * carries `priority: true` may be picked ahead of the jobs waiting before it
 * when a slot is free. It never adds a slot, never starts a second job of a
 * running group, and at most one such "jump" runs in a lane at a time, with a
 * plain FIFO start between two jumps so the normal lane cannot starve.
 *
 * The public surface (`add`, `getJobs`, `close`, `on`) mirrors the subset of
 * BullMQ used by the routers so it can be a drop-in replacement.
 *
 * Durability: the queue lives in process memory, so on its own every restart
 * drops the waiting jobs. An optional `journal` (see queue-journal.ts) is told
 * about every job's life cycle (enqueued, started, finished or removed) so a
 * durable copy can be kept and re-enqueued on boot through `addRestored`. The
 * queue stays the executor; the journal only observes and must never be able
 * to break it.
 */

export const LOCAL_PARTITION = "__local__";

export type JobState = "waiting" | "active";

export interface InMemoryJob {
	id: string;
	/** Durable journal id (stable across restarts, unlike `id`). */
	journalId: string;
	name: string;
	data: DeploymentJob;
	timestamp: number;
	processedOn?: number;
	finishedOn?: number;
	failedReason?: string;
	/** Waiting jobs this one was started ahead of (0 unless it jumped). */
	wentAheadOf?: number;
	getState: () => Promise<JobState>;
	remove: () => Promise<void>;
}

/** A waiting job as reported by `keepOldestWaiting`. */
export interface KeptWaitingJob {
	jobId: string;
	/** ISO-8601 time the job was enqueued. */
	enqueuedAt: string;
	type: "deploy" | "redeploy";
}

/** What `keepOldestWaiting` kept and dropped. */
export interface KeepOldestOutcome {
	/** The surviving job of each duplicate group, in queue order. */
	kept: KeptWaitingJob[];
	removed: KeptWaitingJob[];
}

/** What `coalesceWaiting` did with an incoming push. */
export interface CoalesceWaitingOutcome {
	/**
	 * The waiting job the incoming payload was folded into (it keeps its place),
	 * or null when no waiting job matched and the caller must enqueue normally.
	 */
	merged: KeptWaitingJob | null;
	/** Later duplicates that were dropped. */
	removed: KeptWaitingJob[];
	/** Titles replaced or dropped, so an audit row can name them. */
	titles: string[];
}

type PinnedImage = { ref: string; tag: string | null; digest: string };

/**
 * Two waiting jobs are interchangeable (the later one is a duplicate) when they
 * are the same type and carry the same flags that change what the build does:
 * fresh volumes, a pinned image and the priority request. A job that differs in
 * any of them is not a duplicate and is never dropped in favour of the other.
 */
const sameJobProfile = (
	a: DeploymentJob,
	b: DeploymentJob,
	options: { pinnedImage: boolean },
): boolean => {
	const fresh = (data: DeploymentJob) =>
		(data as { freshVolumes?: boolean }).freshVolumes === true;
	const pinned = (data: DeploymentJob) => {
		const image = (data as { pinnedImage?: PinnedImage }).pinnedImage;
		return image ? `${image.ref}|${image.tag ?? ""}|${image.digest}` : "";
	};
	return (
		a.type === b.type &&
		fresh(a) === fresh(b) &&
		(a.priority === true) === (b.priority === true) &&
		(a.priorityBy ?? "") === (b.priorityBy ?? "") &&
		(!options.pinnedImage || pinned(a) === pinned(b))
	);
};

/**
 * What a processor may report about a job that ended early. A cancelled or
 * failed priority job gives its lane's cooldown back (see `jumpedLast`).
 */
export type JobOutcome = "cancelled" | "failed";

type Processor = (job: InMemoryJob) => Promise<unknown>;

/**
 * Why a priority request did not put a job ahead:
 * - nothing-waiting: no other job waits in the lane, so there is nothing to pass.
 * - first-in-line: nothing ahead of it could start before it (the jobs ahead are
 *   blocked by a running job of their own service, or will take free slots).
 * - older-same-service: an older job of the same service waits, and a flagged job
 *   never passes its own service's older work.
 * - priority-busy: another priority job runs or has just started in the lane.
 */
export type PriorityReason =
	| "nothing-waiting"
	| "first-in-line"
	| "older-same-service"
	| "priority-busy";

/** What a priority request did (or will do) to the job it was asked for. */
export interface PriorityOutcome {
	requested: true;
	/** The job is ahead of the jobs that were waiting, or will be when it starts. */
	applied: boolean;
	/**
	 * Waiting jobs in the lane that it goes ahead of: those ahead of it that could
	 * start now (their service is not running) and will not simply take a free
	 * slot first.
	 */
	wentAheadOf: number;
	reason?: PriorityReason;
}

const withoutPriority = (data: DeploymentJob): DeploymentJob => {
	const { priority: _priority, priorityBy: _by, ...rest } = data;
	return rest as DeploymentJob;
};

/** Resolve the partition key (serverId) a job belongs to. */
export const getPartition = (data: DeploymentJob): string =>
	data.serverId ?? LOCAL_PARTITION;

/** Resolve the FIFO group a job belongs to (the service being deployed). */
export const getGroup = (data: DeploymentJob): string => {
	if (
		data.applicationType === "compose" ||
		data.applicationType === "compose-preview"
	) {
		return `compose:${data.composeId}`;
	}
	return `application:${data.applicationId}`;
};

interface InternalJob {
	id: string;
	journalId: string;
	name: string;
	data: DeploymentJob;
	timestamp: number;
	processedOn?: number;
	finishedOn?: number;
	failedReason?: string;
	state: JobState;
	partition: string;
	group: string;
	/** Started ahead of waiting jobs through the priority lane. */
	jumped: boolean;
	wentAheadOf: number;
}

interface Partition {
	waiting: InternalJob[];
	/** Groups currently running in this partition. */
	activeGroups: Set<string>;
	active: InternalJob[];
	/**
	 * The last job started in this partition jumped the queue. Cleared by the
	 * next plain start, when the waiting list drains, or when that job is
	 * cancelled or fails, so a priority job is never followed directly by another.
	 */
	jumpedLast: boolean;
	/** The concurrency cap seen by the last scheduling tick (unset before). */
	concurrency?: number;
}

/**
 * Observer of a job's life cycle. The queue calls these without awaiting them
 * (except `enqueued`) and ignores whatever they throw.
 */
export interface QueueJournal {
	/** The job was accepted. Awaited by `add`, so its ack means "durable". */
	enqueued(job: {
		journalId: string;
		data: DeploymentJob;
	}): Promise<void> | void;
	/** The worker picked the job up. */
	started(journalId: string): void;
	/** The job completed, failed or was removed from the queue. */
	settled(journalIds: string[]): void;
	/** A waiting job's payload changed (it was flagged for priority). */
	updated?(journalId: string, data: DeploymentJob): void;
}

/** A job read back from the journal after a restart. */
export interface RestoredJob {
	journalId: string;
	data: DeploymentJob;
	/** Original enqueue time, epoch ms. */
	timestamp: number;
}

export interface InMemoryQueueOptions {
	/**
	 * Returns the max number of jobs that may run in parallel for a given
	 * partition. Called on every scheduling tick so license/config changes are
	 * picked up without restarting the queue. Must return a value >= 1.
	 */
	resolveConcurrency: (partition: string) => Promise<number> | number;
	/**
	 * Clock for the enqueue time reported on jobs; injectable for tests. Defaults
	 * to Date.now, which is not monotonic. Queue order never depends on it: it is
	 * the insertion order of the waiting list.
	 */
	now?: () => number;
	/** Durable record of the queue; see `QueueJournal`. */
	journal?: QueueJournal;
}

export class InMemoryQueue {
	private partitions = new Map<string, Partition>();
	private processor: Processor | null = null;
	private running = false;
	private paused = false;
	private seq = 0;
	private idleWaiters: Array<() => void> = [];
	private readonly resolveConcurrency: InMemoryQueueOptions["resolveConcurrency"];
	private readonly now: () => number;
	private readonly journal?: QueueJournal;

	constructor(options: InMemoryQueueOptions) {
		this.resolveConcurrency = options.resolveConcurrency;
		this.now = options.now ?? (() => Date.now());
		this.journal = options.journal;
	}

	private getPartitionState(key: string): Partition {
		let partition = this.partitions.get(key);
		if (!partition) {
			partition = {
				waiting: [],
				activeGroups: new Set(),
				active: [],
				jumpedLast: false,
			};
			this.partitions.set(key, partition);
		}
		return partition;
	}

	/** Run a journal hook; a failing journal must never affect the queue. */
	private notify(call: () => unknown) {
		try {
			const result = call();
			if (result && typeof (result as Promise<unknown>).catch === "function") {
				(result as Promise<unknown>).catch(() => {});
			}
		} catch {
			// The journal reports its own failures.
		}
	}

	/**
	 * Register the worker that processes each job. Registering a processor also
	 * starts the queue: in dev (tsx/Next) the module that calls `run()` and the
	 * module that calls `add()` can resolve to different instances, so we must
	 * not depend on a separate `run()` call to flip `running` on.
	 */
	process(processor: Processor) {
		this.processor = processor;
		this.running = true;
		this.schedule();
	}

	run() {
		this.running = true;
		this.schedule();
		return Promise.resolve();
	}

	async add(
		requested: DeploymentJob,
	): Promise<{ id: string; priority?: PriorityOutcome }> {
		const partition = this.getPartitionState(getPartition(requested));
		const priority =
			requested.priority === true
				? this.assessPriority(
						partition,
						partition.waiting.length,
						getGroup(requested),
						false,
					)
				: undefined;
		// Nothing waits at all: the flag would only be noise in the journal.
		const data =
			priority?.reason === "nothing-waiting"
				? withoutPriority(requested)
				: requested;
		const job = this.createJob(data, randomUUID(), this.now());
		// In memory first and synchronously: FIFO order is the call order even
		// when the journal write below is slow.
		partition.waiting.push(job);
		this.schedule();
		const journal = this.journal;
		if (journal) {
			try {
				await journal.enqueued({ journalId: job.journalId, data });
			} catch {
				// Never block a deploy on the journal; it reports its own failures.
			}
		}
		return priority ? { id: job.id, priority } : { id: job.id };
	}

	/**
	 * Flag a job that is already waiting so it may go ahead of the jobs before
	 * it. Returns null when the job is not waiting (running, finished or gone).
	 * The job keeps its place; the flag only matters when a slot frees.
	 */
	prioritize(id: string, by?: string): PriorityOutcome | null {
		for (const partition of this.partitions.values()) {
			const index = partition.waiting.findIndex((job) => job.id === id);
			if (index === -1) continue;
			const job = partition.waiting[index] as InternalJob;
			const outcome = this.assessPriority(
				partition,
				index,
				job.group,
				partition.waiting.length > 1,
			);
			// First in line: it starts next anyway, so no flag is stored.
			if (index === 0) return outcome;
			if (job.data.priority !== true) {
				job.data = {
					...job.data,
					priority: true,
					...(by ? { priorityBy: by } : {}),
				};
				const journal = this.journal;
				if (journal?.updated) {
					const { journalId, data } = job;
					const update = journal.updated.bind(journal);
					this.notify(() => update(journalId, data));
				}
			}
			return outcome;
		}
		return null;
	}

	/** A jump is not allowed while one runs, nor straight after one started. */
	private jumpBlocked(partition: Partition): boolean {
		return partition.jumpedLast || partition.active.some((job) => job.jumped);
	}

	/**
	 * Slots that waiting jobs are about to take anyway: free right now while the
	 * queue is actually starting jobs. A job that would get one of these is not
	 * going ahead of anything.
	 */
	private freeSlots(partition: Partition): number {
		if (!this.running || this.paused || !this.processor) return 0;
		return Math.max(0, (partition.concurrency ?? 1) - partition.active.length);
	}

	/** Waiting jobs before `index` that could start now (their service is idle). */
	private startableBefore(partition: Partition, index: number): number {
		let count = 0;
		for (let i = 0; i < index; i++) {
			const job = partition.waiting[i] as InternalJob;
			if (!partition.activeGroups.has(job.group)) count++;
		}
		return count;
	}

	/** An older job of the same service waits before `index`. */
	private hasOlderOfGroup(
		partition: Partition,
		index: number,
		group: string,
	): boolean {
		for (let i = 0; i < index; i++) {
			if ((partition.waiting[i] as InternalJob).group === group) return true;
		}
		return false;
	}

	/**
	 * What a priority request for the job at `index` (the end of the list for a
	 * job that is being added) does. `othersBehind` says whether other jobs wait
	 * after it, which tells a job that is first in line from one that is alone.
	 */
	private assessPriority(
		partition: Partition,
		index: number,
		group: string,
		othersBehind: boolean,
	): PriorityOutcome {
		const none = (reason: PriorityReason): PriorityOutcome => ({
			requested: true,
			applied: false,
			wentAheadOf: 0,
			reason,
		});
		if (index === 0) {
			return none(othersBehind ? "first-in-line" : "nothing-waiting");
		}
		if (this.hasOlderOfGroup(partition, index, group)) {
			return none("older-same-service");
		}
		const wentAheadOf = Math.max(
			0,
			this.startableBefore(partition, index) - this.freeSlots(partition),
		);
		if (wentAheadOf === 0) return none("first-in-line");
		if (this.jumpBlocked(partition)) return none("priority-busy");
		return { requested: true, applied: true, wentAheadOf };
	}

	/**
	 * Re-add jobs read back from the journal after a restart. They go to the
	 * FRONT of their partition (in the order given) because they were enqueued
	 * before anything that arrived since boot, and they are not journaled again:
	 * their row already exists. A job whose journal id is already queued or
	 * running is skipped, so a repeated restore cannot duplicate anything.
	 */
	addRestored(jobs: RestoredJob[]): number {
		const known = new Set(this.knownJournalIds());
		const byPartition = new Map<string, InternalJob[]>();
		let added = 0;
		for (const restored of jobs) {
			if (known.has(restored.journalId)) continue;
			known.add(restored.journalId);
			const job = this.createJob(
				restored.data,
				restored.journalId,
				restored.timestamp,
			);
			const list = byPartition.get(job.partition) ?? [];
			list.push(job);
			byPartition.set(job.partition, list);
			added++;
		}
		for (const [key, list] of byPartition) {
			const partition = this.getPartitionState(key);
			partition.waiting = [...list, ...partition.waiting];
		}
		if (added > 0) this.schedule();
		return added;
	}

	private createJob(
		data: DeploymentJob,
		journalId: string,
		timestamp: number,
	): InternalJob {
		return {
			id: `job-${++this.seq}`,
			journalId,
			name: "deployments",
			data,
			timestamp,
			state: "waiting",
			partition: getPartition(data),
			group: getGroup(data),
			jumped: false,
			wentAheadOf: 0,
		};
	}

	private knownJournalIds(): string[] {
		const ids: string[] = [];
		for (const partition of this.partitions.values()) {
			for (const job of partition.waiting) ids.push(job.journalId);
			for (const job of partition.active) ids.push(job.journalId);
		}
		return ids;
	}

	/** True when a job with this journal id is waiting or running. */
	hasJournalId(journalId: string): boolean {
		return this.knownJournalIds().includes(journalId);
	}

	private toPublic(job: InternalJob): InMemoryJob {
		return {
			id: job.id,
			journalId: job.journalId,
			name: job.name,
			data: job.data,
			timestamp: job.timestamp,
			processedOn: job.processedOn,
			finishedOn: job.finishedOn,
			wentAheadOf: job.wentAheadOf,
			getState: () => Promise.resolve(job.state),
			remove: () => this.remove(job.id),
		};
	}

	/** Snapshot of jobs in the requested states (defaults to waiting + active). */
	getJobs(states?: JobState[]): Promise<InMemoryJob[]> {
		const wantWaiting = !states || states.includes("waiting");
		const wantActive = !states || states.includes("active");
		const jobs: InMemoryJob[] = [];
		for (const partition of this.partitions.values()) {
			if (wantWaiting) {
				jobs.push(...partition.waiting.map((job) => this.toPublic(job)));
			}
			if (wantActive) {
				jobs.push(...partition.active.map((job) => this.toPublic(job)));
			}
		}
		return Promise.resolve(jobs);
	}

	/** Remove a single waiting job by id. Active jobs cannot be removed. */
	remove(id: string): Promise<void> {
		for (const partition of this.partitions.values()) {
			const removed = partition.waiting.filter((job) => job.id === id);
			if (removed.length === 0) continue;
			partition.waiting = partition.waiting.filter((job) => job.id !== id);
			this.settle(removed);
			break;
		}
		return Promise.resolve();
	}

	/** Remove waiting jobs matching a predicate. Active jobs are not affected. */
	removeWaiting(predicate: (data: DeploymentJob) => boolean): number {
		const dropped: InternalJob[] = [];
		for (const partition of this.partitions.values()) {
			partition.waiting = partition.waiting.filter((job) => {
				const match = predicate(job.data);
				if (match) dropped.push(job);
				return !match;
			});
		}
		this.settle(dropped);
		return dropped.length;
	}

	private summarize(job: InternalJob): KeptWaitingJob {
		return {
			jobId: job.id,
			enqueuedAt: new Date(job.timestamp).toISOString(),
			type: job.data.type,
		};
	}

	/**
	 * Among the waiting jobs that match `predicate`, keep the oldest of each group
	 * of duplicates and remove the later ones. Duplicates are the same type
	 * (`deploy` and `redeploy` never displace each other) with the same
	 * freshVolumes, pinnedImage and priority flags; a job that differs in any of
	 * them is kept. "Oldest" is queue position within the partition (insertion
	 * order), never the clock, so it holds when two jobs share a millisecond or
	 * the clock steps back. Partitions are independent lanes: each keeps its own
	 * oldest. The kept job is not touched, so it keeps its place; active jobs are
	 * never looked at.
	 */
	keepOldestWaiting(
		predicate: (data: DeploymentJob) => boolean,
	): KeepOldestOutcome {
		const keptJobs: InternalJob[] = [];
		const dropped: InternalJob[] = [];
		for (const partition of this.partitions.values()) {
			const survivors: InternalJob[] = [];
			const gone = new Set<InternalJob>();
			for (const job of partition.waiting) {
				if (!predicate(job.data)) continue;
				const twin = survivors.find((kept) =>
					sameJobProfile(kept.data, job.data, { pinnedImage: true }),
				);
				if (twin) gone.add(job);
				else survivors.push(job);
			}
			if (gone.size > 0) {
				partition.waiting = partition.waiting.filter((job) => !gone.has(job));
				dropped.push(...gone);
			}
			keptJobs.push(...survivors);
		}
		this.settle(dropped);
		return {
			kept: keptJobs.map((job) => this.summarize(job)),
			removed: dropped.map((job) => this.summarize(job)),
		};
	}

	/**
	 * Push-hook coalescing: fold `incoming` into the oldest waiting job it is a
	 * duplicate of and drop the other duplicates, so a burst of pushes leaves one
	 * waiting job, at the earliest position, carrying the newest payload. A
	 * duplicate is a matching job (`predicate`) of the same type with the same
	 * freshVolumes and priority flags; a pinned image is deliberately NOT part of
	 * the match, because the newest digest must win. The kept job's payload is
	 * replaced by `incoming` (title, description, pinned image, server) and the
	 * journal row is updated to match. It keeps its place and enqueue time.
	 *
	 * Returns `merged: null` when nothing in the incoming job's partition matched;
	 * the caller then enqueues the incoming job as usual. Duplicates found in
	 * another partition (the service moved servers) are dropped either way.
	 */
	coalesceWaiting(
		incoming: DeploymentJob,
		predicate: (data: DeploymentJob) => boolean,
	): CoalesceWaitingOutcome {
		const home = getPartition(incoming);
		let target: InternalJob | null = null;
		const dropped: InternalJob[] = [];
		// The incoming job's own partition first, so its oldest match is the target.
		const ordered = [...this.partitions.entries()].sort(
			([a], [b]) => Number(b === home) - Number(a === home),
		);
		for (const [key, partition] of ordered) {
			const gone = new Set<InternalJob>();
			for (const job of partition.waiting) {
				if (!predicate(job.data)) continue;
				if (!sameJobProfile(job.data, incoming, { pinnedImage: false })) {
					continue;
				}
				if (!target && key === home) target = job;
				else gone.add(job);
			}
			if (gone.size > 0) {
				partition.waiting = partition.waiting.filter((job) => !gone.has(job));
				dropped.push(...gone);
			}
		}
		const titleOf = (job: InternalJob) => {
			const title = (job.data as { titleLog?: unknown }).titleLog;
			return typeof title === "string" ? [title] : [];
		};
		const titles = dropped.flatMap(titleOf);
		this.settle(dropped);
		if (target) {
			titles.unshift(...titleOf(target));
			target.data = incoming;
			const journal = this.journal;
			if (journal?.updated) {
				const { journalId } = target;
				const update = journal.updated.bind(journal);
				this.notify(() => update(journalId, incoming));
			}
		}
		return {
			merged: target ? this.summarize(target) : null,
			removed: dropped.map((job) => this.summarize(job)),
			titles,
		};
	}

	/** Drop every waiting job across all partitions. */
	clearWaiting(): number {
		const dropped: InternalJob[] = [];
		for (const partition of this.partitions.values()) {
			dropped.push(...partition.waiting);
			partition.waiting = [];
		}
		this.settle(dropped);
		return dropped.length;
	}

	/** Tell the journal these jobs are gone (finished, failed or cancelled). */
	private settle(jobs: InternalJob[]) {
		const journal = this.journal;
		if (!journal || jobs.length === 0) return;
		const ids = jobs.map((job) => job.journalId);
		this.notify(() => journal.settled(ids));
	}

	on() {
		// No-op: kept for BullMQ API compatibility (error events, etc).
	}

	close() {
		this.running = false;
		return Promise.resolve();
	}

	/**
	 * Hold back processing: jobs can still be added (and journaled) but none
	 * starts until `resume()`. Used to keep the worker idle until the boot replay
	 * has put the previous process's jobs ahead of anything that arrived since.
	 */
	pause() {
		this.paused = true;
	}

	resume() {
		if (!this.paused) return;
		this.paused = false;
		this.schedule();
	}

	/**
	 * Resolve `true` once no job is running, or `false` after `timeoutMs`. Used
	 * by the graceful shutdown: after `close()` nothing new starts, so this only
	 * waits for the jobs already in flight.
	 */
	waitForIdle(timeoutMs: number): Promise<boolean> {
		if (this.activeCount() === 0) return Promise.resolve(true);
		return new Promise((resolve) => {
			const onIdle = () => {
				clearTimeout(timer);
				resolve(true);
			};
			const timer = setTimeout(() => {
				this.idleWaiters = this.idleWaiters.filter((wake) => wake !== onIdle);
				resolve(false);
			}, timeoutMs);
			this.idleWaiters.push(onIdle);
		});
	}

	private activeCount(): number {
		let count = 0;
		for (const partition of this.partitions.values()) {
			count += partition.active.length;
		}
		return count;
	}

	private schedule() {
		if (!this.running || this.paused || !this.processor) return;
		for (const key of this.partitions.keys()) {
			void this.drainPartition(key);
		}
	}

	private async drainPartition(key: string) {
		const partition = this.partitions.get(key);
		if (!partition || !this.processor) return;

		const concurrency = Math.max(1, await this.resolveConcurrency(key));
		partition.concurrency = concurrency;

		// A shutdown can land while the concurrency was being resolved.
		while (
			this.running &&
			!this.paused &&
			partition.active.length < concurrency
		) {
			const pick = this.pickNext(partition);
			if (!pick) break;

			const wentAheadOf = pick.jumped
				? this.startableBefore(partition, pick.index)
				: 0;
			const job = partition.waiting.splice(pick.index, 1)[0];
			if (!job) break;
			job.jumped = pick.jumped;
			job.wentAheadOf = wentAheadOf;
			partition.jumpedLast = pick.jumped;
			job.state = "active";
			job.processedOn = this.now();
			partition.activeGroups.add(job.group);
			partition.active.push(job);

			const journal = this.journal;
			if (journal) this.notify(() => journal.started(job.journalId));
			void this.runJob(job);
		}
		// A drained lane has nothing left to be fair to.
		if (partition.waiting.length === 0) partition.jumpedLast = false;
	}

	/**
	 * Which waiting job takes a free slot: the first one whose group is not
	 * already running, unless a priority-flagged job further down may jump it. A
	 * flagged job that is first in line anyway is a plain start, not a jump. A
	 * flagged job never jumps while an older job of its own service waits: that
	 * older work (a pinned image, a fresh-volumes redeploy) has to run first.
	 */
	private pickNext(
		partition: Partition,
	): { index: number; jumped: boolean } | null {
		const isFree = (job: InternalJob) => !partition.activeGroups.has(job.group);
		const first = partition.waiting.findIndex(isFree);
		if (first === -1) return null;
		if (!this.jumpBlocked(partition)) {
			// The oldest eligible flagged job wins; if that is the first one anyway,
			// nothing is jumped.
			const seen = new Set<string>();
			for (let index = 0; index < partition.waiting.length; index++) {
				const job = partition.waiting[index] as InternalJob;
				if (
					index >= first &&
					job.data.priority === true &&
					isFree(job) &&
					!seen.has(job.group)
				) {
					return { index, jumped: index > first };
				}
				seen.add(job.group);
			}
		}
		return { index: first, jumped: false };
	}

	private async runJob(job: InternalJob) {
		let outcome: JobOutcome | undefined;
		try {
			const result = await this.processor?.(this.toPublic(job));
			if (result === "cancelled" || result === "failed") outcome = result;
		} catch (error) {
			outcome = "failed";
			job.failedReason = error instanceof Error ? error.message : String(error);
			console.error("In-memory deployment job failed", error);
		} finally {
			job.finishedOn = this.now();
			const partition = this.partitions.get(job.partition);
			if (partition) {
				partition.active = partition.active.filter((j) => j.id !== job.id);
				partition.activeGroups.delete(job.group);
				// A priority job that did not complete frees the "one ahead"
				// allowance for a retry; it is held for exactly as long as the slot.
				if (job.jumped && outcome) partition.jumpedLast = false;
			}
			this.settle([job]);
			if (this.activeCount() === 0) {
				const waiters = this.idleWaiters;
				this.idleWaiters = [];
				for (const wake of waiters) wake();
			}
			// A slot (and possibly the group) freed up — try to schedule more.
			void this.drainPartition(job.partition);
		}
	}
}
