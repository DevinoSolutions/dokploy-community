import { nanoid } from "nanoid";

export const MAX_CONCURRENCY = 10;

// No persistence — tasks are discarded on process exit by design.
export interface GroupedJob<T> {
	readonly jobId: string;
	readonly groupId: string;
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
	jobId: string;
	data: T;
	controller: AbortController;
	enqueuedAt: number;
	startedAt?: number;
	resolve: () => void;
	reject: (error: Error) => void;
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
		this.concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, concurrency));
	}

	setHandler(handler: Handler<T>): void {
		this.handler = handler;
		this.schedule();
	}

	setConcurrency(concurrency: number): void {
		this.concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, concurrency));
		this.schedule();
	}

	getConcurrency(): number {
		return this.concurrency;
	}

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

	size(): number {
		let n = 0;
		for (const group of this.groups.values()) {
			n += group.pending.length + (group.active ? 1 : 0);
		}
		return n;
	}

	async close(reason = "Queue closed"): Promise<void> {
		this.closed = true;
		const waiting: Promise<void>[] = [];
		for (const [, group] of this.groups) {
			if (group.active) {
				const active = group.active;
				waiting.push(
					new Promise<void>((resolve) => {
						const settled = () => resolve();
						const origResolve = active.resolve;
						const origReject = active.reject;
						active.resolve = () => {
							origResolve();
							settled();
						};
						active.reject = (e) => {
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
		// Cancel must reject `done` even when the handler swallows the abort.
		if (!error && task.controller.signal.aborted) {
			const reason = task.controller.signal.reason;
			error = reason instanceof Error ? reason : new Error("Cancelled");
		}
		// Bookkeeping before settling so `await job.done` sees a consistent state.
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
