import {
	type GroupedJob,
	GroupedQueue,
	type JobSnapshot,
	MAX_CONCURRENCY,
} from "./grouped-queue";
import { resolveServiceKey, resolveTargetKey } from "./queue-router";
import type { DeploymentJob } from "./queue-types";

export type DeploymentSnapshot = JobSnapshot<DeploymentJob> & {
	readonly state: "active" | "pending";
};

// Returning `undefined` falls back to the default concurrency.
export type ConcurrencyProvider = (
	targetKey: string,
) => Promise<number | undefined> | number | undefined;

type Handler = (job: DeploymentJob, signal: AbortSignal) => Promise<void>;

export class DeploymentQueueManager {
	private readonly queues = new Map<string, GroupedQueue<DeploymentJob>>();
	// Guards concurrent first-enqueue races for the same target.
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
			// `.catch` keeps a failed creation from surfacing as an unhandled rejection.
			pending
				.then((queue) => {
					queue.setHandler((data, signal) => handler(data, signal));
				})
				.catch(() => {});
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
		if (concurrency < 1 || concurrency > MAX_CONCURRENCY) {
			throw new Error(`concurrency must be between 1 and ${MAX_CONCURRENCY}`);
		}
		const queue = await this.getOrCreate(targetKey);
		queue.setConcurrency(concurrency);
	}

	getConcurrency(targetKey: string): number | undefined {
		return this.queues.get(targetKey)?.getConcurrency();
	}

	cancelJob(jobId: string, reason?: string): boolean {
		for (const queue of this.queues.values()) {
			if (queue.cancel(jobId, reason)) return true;
		}
		return false;
	}

	cancelAllJobs(reason?: string): void {
		for (const queue of this.queues.values()) {
			queue.cancelAll(reason);
		}
	}

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

	listJobs(): DeploymentJob[] {
		return this.listSnapshots().map((snapshot) => snapshot.data);
	}

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
		// Drain in-flight creations so their queues land in `this.queues` and get closed too.
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

	private getOrCreate(targetKey: string): Promise<GroupedQueue<DeploymentJob>> {
		if (this.closed) {
			return Promise.reject(new Error("DeploymentQueueManager is closed"));
		}
		const existing = this.queues.get(targetKey);
		if (existing) return Promise.resolve(existing);
		const inflight = this.creating.get(targetKey);
		if (inflight) return inflight;
		const pending = this.createQueue(targetKey)
			.then(async (queue) => {
				if (this.closed) {
					await queue.close("shutdown");
					this.creating.delete(targetKey);
					throw new Error("DeploymentQueueManager is closed");
				}
				this.queues.set(targetKey, queue);
				this.creating.delete(targetKey);
				return queue;
			})
			.catch((error) => {
				// Transient provider failure leaves the slot empty so next enqueue retries.
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
