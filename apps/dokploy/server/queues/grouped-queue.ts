import { nanoid } from "nanoid";

/**
 * In-memory grouped task queue.
 *
 * Contract:
 * - Tasks are enqueued under a `groupId`. Tasks within a group run one at a
 *   time in FIFO order (the "per-service FIFO" guarantee).
 * - Tasks in different groups can run in parallel, up to `concurrency` groups
 *   at once.
 * - Every running task receives an `AbortSignal`. `cancel(jobId)` trips that
 *   signal and rejects the task's promise; the handler is expected to
 *   propagate the abort into any child process.
 * - No persistence. Queued tasks are discarded on process exit (by design —
 *   see the plan's §6.7, matches Dokploy maintainer's stated tradeoff).
 */
export interface GroupedJob<T> {
	/** Stable, unique id the caller uses for cancellation. */
	readonly jobId: string;
	/** Which group this job belongs to (FIFO scope). */
	readonly groupId: string;
	/** Resolves when the handler finishes; rejects on handler error or abort. */
	readonly done: Promise<void>;
}

export interface JobSnapshot<T> {
	readonly jobId: string;
	readonly groupId: string;
	readonly data: T;
	readonly enqueuedAt: number;
	readonly startedAt?: number;
}

type Handler<T> = (data: T, signal: AbortSignal) => Promise<void>;

interface Task<T> {
	readonly jobId: string;
	readonly data: T;
	readonly controller: AbortController;
	readonly enqueuedAt: number;
	startedAt?: number;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
}

interface Group<T> {
	pending: Task<T>[];
	active: Task<T> | null;
}

export class GroupedQueue<T> {
	private readonly groups = new Map<string, Group<T>>();
	private readonly activeGroups = new Set<string>();
	private handler: Handler<T> | null = null;
	private concurrency: number;
	private closed = false;

	constructor(concurrency: number) {
		this.concurrency = Math.max(1, concurrency);
	}

	setHandler(handler: Handler<T>): void {
		this.handler = handler;
		this.schedule();
	}

	/**
	 * Change the parallelism cap. In-flight tasks keep running; pending tasks
	 * stay queued — we deliberately do NOT flush pending jobs here (contrast
	 * with upstream #3744, which does).
	 */
	setConcurrency(concurrency: number): void {
		this.concurrency = Math.max(1, concurrency);
		this.schedule();
	}

	getConcurrency(): number {
		return this.concurrency;
	}

	/**
	 * Enqueue a task. Returns the job handle; `done` settles when the handler
	 * finishes, rejects on handler error or `cancel`.
	 */
	add(groupId: string, data: T): GroupedJob<T> {
		if (this.closed) {
			throw new Error("Queue is closed");
		}
		const jobId = nanoid();
		const done = new Promise<void>((resolve, reject) => {
			const task: Task<T> = {
				jobId,
				data,
				controller: new AbortController(),
				enqueuedAt: Date.now(),
				resolve,
				reject,
			};
			const group = this.groups.get(groupId) ?? {
				pending: [],
				active: null,
			};
			group.pending.push(task);
			this.groups.set(groupId, group);
			this.schedule();
		});
		return { jobId, groupId, done };
	}

	/**
	 * Cancel a specific job. If it's active, aborts its signal (the handler
	 * is expected to unwind promptly); if it's pending, removes it from its
	 * group's queue. Returns true if the job was found.
	 */
	cancel(jobId: string, reason = "Cancelled"): boolean {
		for (const [groupId, group] of this.groups) {
			if (group.active && group.active.jobId === jobId) {
				group.active.controller.abort(new Error(reason));
				return true;
			}
			const idx = group.pending.findIndex((t) => t.jobId === jobId);
			if (idx !== -1) {
				const [task] = group.pending.splice(idx, 1);
				if (task) {
					task.reject(new Error(reason));
				}
				this.maybeCleanupGroup(groupId);
				return true;
			}
		}
		return false;
	}

	/**
	 * Cancel every active job and reject every pending job across all groups.
	 * Active handlers receive the abort signal; pending tasks never run.
	 */
	cancelAll(reason = "Cancelled"): void {
		for (const [groupId, group] of this.groups) {
			if (group.active) {
				group.active.controller.abort(new Error(reason));
			}
			for (const task of group.pending) {
				task.reject(new Error(reason));
			}
			group.pending = [];
			this.maybeCleanupGroup(groupId);
		}
	}

	/**
	 * Predicate-based cancellation — used by the facade to scope cancels to a
	 * single application / compose.
	 */
	cancelWhere(predicate: (data: T) => boolean, reason = "Cancelled"): number {
		let removed = 0;
		for (const [groupId, group] of this.groups) {
			if (group.active && predicate(group.active.data)) {
				group.active.controller.abort(new Error(reason));
				removed++;
			}
			const keep: Task<T>[] = [];
			for (const task of group.pending) {
				if (predicate(task.data)) {
					task.reject(new Error(reason));
					removed++;
				} else {
					keep.push(task);
				}
			}
			group.pending = keep;
			this.maybeCleanupGroup(groupId);
		}
		return removed;
	}

	listActive(): ReadonlyArray<JobSnapshot<T>> {
		const out: JobSnapshot<T>[] = [];
		for (const [groupId, group] of this.groups) {
			if (group.active) {
				out.push({
					jobId: group.active.jobId,
					groupId,
					data: group.active.data,
					enqueuedAt: group.active.enqueuedAt,
					startedAt: group.active.startedAt,
				});
			}
		}
		return out;
	}

	listPending(): ReadonlyArray<JobSnapshot<T>> {
		const out: JobSnapshot<T>[] = [];
		for (const [groupId, group] of this.groups) {
			for (const task of group.pending) {
				out.push({
					jobId: task.jobId,
					groupId,
					data: task.data,
					enqueuedAt: task.enqueuedAt,
				});
			}
		}
		return out;
	}

	/** Number of tasks (active + pending) across all groups. */
	size(): number {
		let n = 0;
		for (const group of this.groups.values()) {
			n += group.pending.length + (group.active ? 1 : 0);
		}
		return n;
	}

	/**
	 * Abort all in-flight jobs and reject all pending ones. Subsequent `add`
	 * calls throw. The returned promise settles when every handler has
	 * unwound.
	 */
	async close(reason = "Queue closed"): Promise<void> {
		this.closed = true;
		const waiting: Promise<void>[] = [];
		for (const [, group] of this.groups) {
			if (group.active) {
				// The active task's `done` promise will settle; collect it via a
				// reject-safe wrapper so Promise.all doesn't short-circuit.
				const active = group.active;
				waiting.push(
					new Promise<void>((resolve) => {
						const settled = () => resolve();
						// monkey-patch resolve/reject to also resolve our waiter
						const origResolve = active.resolve;
						const origReject = active.reject;
						(active as { resolve: () => void }).resolve = () => {
							origResolve();
							settled();
						};
						(active as { reject: (e: Error) => void }).reject = (e) => {
							origReject(e);
							settled();
						};
					}),
				);
				active.controller.abort(new Error(reason));
			}
			for (const task of group.pending) {
				task.reject(new Error(reason));
			}
			group.pending = [];
		}
		await Promise.all(waiting);
		this.groups.clear();
		this.activeGroups.clear();
	}

	// --- internal scheduling ---------------------------------------------------

	private schedule(): void {
		if (!this.handler || this.closed) return;
		while (this.activeGroups.size < this.concurrency) {
			const next = this.pickNextGroup();
			if (!next) return;
			this.runGroup(next);
		}
	}

	private pickNextGroup(): string | null {
		for (const [groupId, group] of this.groups) {
			if (
				!this.activeGroups.has(groupId) &&
				group.active === null &&
				group.pending.length > 0
			) {
				return groupId;
			}
		}
		return null;
	}

	private runGroup(groupId: string): void {
		const group = this.groups.get(groupId);
		if (!group || group.pending.length === 0) return;
		const task = group.pending.shift();
		if (!task) return;
		task.startedAt = Date.now();
		group.active = task;
		this.activeGroups.add(groupId);

		// Fire and forget — errors are routed through task.reject inside execute.
		void this.execute(task, groupId, group);
	}

	private async execute(
		task: Task<T>,
		groupId: string,
		group: Group<T>,
	): Promise<void> {
		const handler = this.handler;
		if (!handler) {
			task.reject(new Error("No handler registered"));
			return;
		}
		let error: Error | null = null;
		try {
			await handler(task.data, task.controller.signal);
		} catch (e) {
			error = e instanceof Error ? e : new Error(String(e));
		}
		// Perform bookkeeping BEFORE settling the caller's promise so that an
		// `await job.done` observes the queue in a consistent post-run state
		// (no leaked group entries, concurrency slot freed).
		group.active = null;
		this.activeGroups.delete(groupId);
		this.maybeCleanupGroup(groupId);
		this.schedule();
		if (error) task.reject(error);
		else task.resolve();
	}

	private maybeCleanupGroup(groupId: string): void {
		const group = this.groups.get(groupId);
		if (!group) return;
		if (group.active === null && group.pending.length === 0) {
			this.groups.delete(groupId);
		}
	}
}
