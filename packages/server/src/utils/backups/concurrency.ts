// Global concurrency limiter for SCHEDULED backup runs.
//
// Every backup row gets its own node-schedule job whose callback runs the dump
// pipeline directly. Backup policies can materialize many backup rows on the
// same cron, so without a limit 100+ backups firing in the same tick would spawn
// 100 concurrent docker-exec/pg_dump/rclone pipelines and SSH connections.
//
// Slots are counted PER TARGET SERVER KEY (local = "local", remote = serverId)
// so a slow remote server can't starve local backups: each server key gets its
// own limit of DOKPLOY_BACKUP_CONCURRENCY running backups.

export const DEFAULT_BACKUP_CONCURRENCY = 4;

// Parse the configured limit. Anything that isn't an integer >= 1 (absent,
// empty, non-numeric, zero, negative, fractional) falls back to the default.
export const parseConcurrency = (raw: string | undefined): number => {
	const n = Number(raw);
	return Number.isInteger(n) && n >= 1 ? n : DEFAULT_BACKUP_CONCURRENCY;
};

interface Semaphore {
	running: number;
	waiters: Array<() => void>;
}

export interface BackupLimiter {
	withSlot<T>(
		serverKey: string | null | undefined,
		label: string,
		fn: () => Promise<T>,
	): Promise<T>;
}

// A FIFO, per-key async semaphore. `limit` slots per key; callers past the limit
// queue and are woken in arrival order as slots free.
export const createBackupLimiter = (limit: number): BackupLimiter => {
	const semaphores = new Map<string, Semaphore>();

	const getSemaphore = (key: string): Semaphore => {
		let sem = semaphores.get(key);
		if (!sem) {
			sem = { running: 0, waiters: [] };
			semaphores.set(key, sem);
		}
		return sem;
	};

	const release = (sem: Semaphore): void => {
		const next = sem.waiters.shift();
		// Hand the just-freed slot straight to the next waiter (running stays put)
		// so an interleaving acquire can never overshoot the limit.
		if (next) {
			next();
		} else {
			sem.running--;
		}
	};

	return {
		async withSlot(serverKey, label, fn) {
			const key = serverKey || "local";
			const sem = getSemaphore(key);

			if (sem.running >= limit) {
				console.log(
					`[backup-queue] ${label} waiting (${sem.running} running on ${key})`,
				);
				await new Promise<void>((resolve) => {
					sem.waiters.push(resolve);
				});
				console.log(`[backup-queue] ${label} started on ${key}`);
			} else {
				sem.running++;
			}

			try {
				return await fn();
			} finally {
				release(sem);
			}
		},
	};
};

export const BACKUP_CONCURRENCY = parseConcurrency(
	process.env.DOKPLOY_BACKUP_CONCURRENCY,
);

const defaultLimiter = createBackupLimiter(BACKUP_CONCURRENCY);

// Run `fn` once a slot is free for `serverKey`, always releasing the slot
// afterwards (even on error). Used to throttle scheduled backup callbacks.
export const withBackupSlot = <T>(
	serverKey: string | null | undefined,
	label: string,
	fn: () => Promise<T>,
): Promise<T> => defaultLimiter.withSlot(serverKey, label, fn);
