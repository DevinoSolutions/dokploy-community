import {
	type GroupedJob,
	GroupedQueue,
	type JobSnapshot,
} from "./grouped-queue";
import { resolveServiceKey, resolveTargetKey } from "./queue-router";
import type { DeploymentJob } from "./queue-types";

export type DeploymentSnapshot = JobSnapshot<DeploymentJob> & {
	readonly state: "active" | "pending";
};

/**
 * Reads the initial concurrency for a target key from persistent config.
 * Returning `undefined` means "fall back to the default".
 */
export type ConcurrencyProvider = (
	targetKey: string,
) => Promise<number | undefined> | number | undefined;

type Handler = (job: DeploymentJob, signal: AbortSignal) => Promise<void>;

/**
 * Owns one `GroupedQueue<DeploymentJob>` per deployment target (local host +
 * each remote server). Responsibilities:
 *   - Lazy creation of per-target pools on first enqueue.
 *   - Cross-target cancellation / iteration.
 *   - Funnelling concurrency changes to the right pool.
 *
 * The handler is registered once and applied to every pool as it's created.
 */
export class DeploymentQueueManager {
	// Fully-created queues, keyed by target. Synchronous reads are always
	// safe against this map.
	private readonly queues = new Map<string, GroupedQueue<DeploymentJob>>();
	// Queues whose creation is currently in flight. De-duplicates first-time
	// `add()`s for the same target so concurrent callers never race to
	// instantiate separate `GroupedQueue`s for the same key (which would
	// orphan whichever was overwritten). Always emptied into `queues` on
	// settlement.
	private readonly creating = new Map<
		string,
		Promise<GroupedQueue<DeploymentJob>>
	>();
	private handler: Handler | null = null;
	private readonly defaultConcurrency: number;
	private readonly provider: ConcurrencyProvider;
	private closed = false;

	constructor(options: {
		defaultConcurrency: number;
		concurrencyProvider: ConcurrencyProvider;
	}) {
		this.defaultConcurrency = Math.max(1, options.defaultConcurrency);
		this.provider = options.concurrencyProvider;
	}

	setHandler(handler: Handler): void {
		this.handler = handler;
		for (const queue of this.queues.values()) {
			queue.setHandler((data, signal) => handler(data, signal));
		}
		for (const pending of this.creating.values()) {
			pending.then((queue) => {
				queue.setHandler((data, signal) => handler(data, signal));
			});
		}
	}

	async add(job: DeploymentJob): Promise<GroupedJob<DeploymentJob>> {
		if (this.closed) {
			throw new Error("DeploymentQueueManager is closed");
		}
		const targetKey = resolveTargetKey(job);
		const serviceKey = resolveServiceKey(job);
		const queue = await this.getOrCreate(targetKey);
		return queue.add(serviceKey, job);
	}

	async updateConcurrency(
		targetKey: string,
		concurrency: number,
	): Promise<void> {
		if (concurrency < 1 || concurrency > 10) {
			throw new Error("concurrency must be between 1 and 10");
		}
		const queue = await this.getOrCreate(targetKey);
		queue.setConcurrency(concurrency);
	}

	getConcurrency(targetKey: string): number | undefined {
		return this.queues.get(targetKey)?.getConcurrency();
	}

	/**
	 * Cancel a job by id. We don't know which target owns it, so iterate.
	 * Returns true if the job was found in any target's queue.
	 */
	cancelJob(jobId: string, reason?: string): boolean {
		for (const queue of this.queues.values()) {
			if (queue.cancel(jobId, reason)) return true;
		}
		return false;
	}

	/** Abort every active job and reject every pending job across all targets. */
	cancelAllJobs(reason?: string): void {
		for (const queue of this.queues.values()) {
			queue.cancelAll(reason);
		}
	}

	/**
	 * Cancel jobs matching a predicate, fanned out across every target queue.
	 * Used by `cleanQueuesByApplication` / `cleanQueuesByCompose`.
	 */
	cancelWhere(
		predicate: (job: DeploymentJob) => boolean,
		reason?: string,
	): number {
		let removed = 0;
		for (const queue of this.queues.values()) {
			removed += queue.cancelWhere(predicate, reason);
		}
		return removed;
	}

	/** Active + pending job payloads across every target. */
	listJobs(): DeploymentJob[] {
		return this.listSnapshots().map((snapshot) => snapshot.data);
	}

	/** Active + pending snapshots (with timing + state) across every target. */
	listSnapshots(): DeploymentSnapshot[] {
		const out: DeploymentSnapshot[] = [];
		for (const queue of this.queues.values()) {
			for (const item of queue.listActive()) {
				out.push({ ...item, state: "active" });
			}
			for (const item of queue.listPending()) {
				out.push({ ...item, state: "pending" });
			}
		}
		return out;
	}

	/** Split view for the queue-summary UI. */
	summarize(): { active: DeploymentJob[]; pending: DeploymentJob[] } {
		const active: DeploymentJob[] = [];
		const pending: DeploymentJob[] = [];
		for (const queue of this.queues.values()) {
			for (const item of queue.listActive()) active.push(item.data);
			for (const item of queue.listPending()) pending.push(item.data);
		}
		return { active, pending };
	}

	size(): number {
		let n = 0;
		for (const queue of this.queues.values()) n += queue.size();
		return n;
	}

	async close(reason = "shutdown"): Promise<void> {
		this.closed = true;
		// Drain any in-flight creation first so their GroupedQueues are in
		// `this.queues` and get closed too — otherwise a job whose target
		// was being created at the moment of shutdown would race past us.
		const inflight = [...this.creating.values()];
		if (inflight.length > 0) {
			await Promise.allSettled(inflight);
		}
		await Promise.all(
			[...this.queues.values()].map((queue) => queue.close(reason)),
		);
		this.queues.clear();
		this.creating.clear();
	}

	// --- internals ------------------------------------------------------------

	private getOrCreate(targetKey: string): Promise<GroupedQueue<DeploymentJob>> {
		const existing = this.queues.get(targetKey);
		if (existing) return Promise.resolve(existing);
		const inflight = this.creating.get(targetKey);
		if (inflight) return inflight;
		const pending = this.createQueue(targetKey)
			.then((queue) => {
				this.queues.set(targetKey, queue);
				this.creating.delete(targetKey);
				return queue;
			})
			.catch((error) => {
				// Don't poison the slot on transient failure (e.g. DB blip in
				// provider). Next enqueue retries cleanly.
				this.creating.delete(targetKey);
				throw error;
			});
		this.creating.set(targetKey, pending);
		return pending;
	}

	private async createQueue(
		targetKey: string,
	): Promise<GroupedQueue<DeploymentJob>> {
		const override = await this.provider(targetKey);
		const concurrency =
			typeof override === "number" && override > 0
				? override
				: this.defaultConcurrency;
		const queue = new GroupedQueue<DeploymentJob>(concurrency);
		if (this.handler) {
			const handler = this.handler;
			queue.setHandler((data, signal) => handler(data, signal));
		}
		return queue;
	}
}
