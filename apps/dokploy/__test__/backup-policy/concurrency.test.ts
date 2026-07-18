import {
	BACKUP_CONCURRENCY,
	createBackupLimiter,
	DEFAULT_BACKUP_CONCURRENCY,
	parseConcurrency,
} from "@dokploy/server/utils/backups/concurrency";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A promise plus its resolve/reject, to hold a task "running" until we release it.
const deferred = () => {
	let resolve!: () => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

// Let queued microtasks settle so slot hand-offs take effect before asserting.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("parseConcurrency", () => {
	it("parses valid positive integers", () => {
		expect(parseConcurrency("1")).toBe(1);
		expect(parseConcurrency("8")).toBe(8);
	});

	it("falls back to the default for invalid or absent values", () => {
		const invalid: Array<string | undefined> = [
			undefined,
			"",
			" ",
			"abc",
			"0",
			"-3",
			"2.5",
			"NaN",
			"1e3abc",
		];
		for (const value of invalid) {
			expect(parseConcurrency(value)).toBe(DEFAULT_BACKUP_CONCURRENCY);
		}
	});

	it("exposes an env-derived default limit >= 1", () => {
		expect(BACKUP_CONCURRENCY).toBeGreaterThanOrEqual(1);
		expect(Number.isInteger(BACKUP_CONCURRENCY)).toBe(true);
	});
});

describe("createBackupLimiter", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it("runs at most `limit` tasks concurrently per key", async () => {
		const limiter = createBackupLimiter(2);
		let active = 0;
		let maxActive = 0;
		const gates = [deferred(), deferred(), deferred(), deferred()];
		const tasks = gates.map((gate, i) =>
			limiter.withSlot("local", `b${i}`, async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				await gate.promise;
				active--;
			}),
		);

		await flush();
		expect(active).toBe(2);

		gates[0].resolve();
		await flush();
		// one finished, the next queued task took its slot — still capped at 2
		expect(active).toBe(2);

		for (const gate of gates) gate.resolve();
		await Promise.all(tasks);
		expect(maxActive).toBe(2);
	});

	it("wakes waiters in FIFO arrival order", async () => {
		const limiter = createBackupLimiter(1);
		const started: number[] = [];
		const gates = [deferred(), deferred(), deferred()];
		const tasks = [0, 1, 2].map((i) =>
			limiter.withSlot("k", `t${i}`, async () => {
				started.push(i);
				await gates[i].promise;
			}),
		);

		await flush();
		expect(started).toEqual([0]);

		gates[0].resolve();
		await flush();
		expect(started).toEqual([0, 1]);

		gates[1].resolve();
		await flush();
		expect(started).toEqual([0, 1, 2]);

		gates[2].resolve();
		await Promise.all(tasks);
	});

	it("releases the slot when a task throws", async () => {
		const limiter = createBackupLimiter(1);

		await expect(
			limiter.withSlot("k", "boom", async () => {
				throw new Error("fail");
			}),
		).rejects.toThrow("fail");

		let ran = false;
		await limiter.withSlot("k", "ok", async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});

	it("limits each server key independently", async () => {
		const limiter = createBackupLimiter(1);
		const gateA = deferred();
		const gateB = deferred();
		let aActive = false;
		let bActive = false;

		const a = limiter.withSlot("serverA", "a", async () => {
			aActive = true;
			await gateA.promise;
		});
		const b = limiter.withSlot("serverB", "b", async () => {
			bActive = true;
			await gateB.promise;
		});

		await flush();
		// Different keys → neither blocks the other despite a limit of 1.
		expect(aActive).toBe(true);
		expect(bActive).toBe(true);

		gateA.resolve();
		gateB.resolve();
		await Promise.all([a, b]);
	});

	it("treats null/undefined/empty server keys as the shared 'local' queue", async () => {
		const limiter = createBackupLimiter(1);
		const gate = deferred();
		let secondStarted = false;

		const first = limiter.withSlot(null, "first", async () => {
			await gate.promise;
		});
		const second = limiter.withSlot(undefined, "second", async () => {
			secondStarted = true;
		});

		await flush();
		expect(secondStarted).toBe(false);

		gate.resolve();
		await Promise.all([first, second]);
		expect(secondStarted).toBe(true);
	});

	it("logs on wait and stays quiet when a slot is free", async () => {
		const limiter = createBackupLimiter(1);

		await limiter.withSlot("k", "immediate", async () => {});
		expect(logSpy).not.toHaveBeenCalled();

		const gate = deferred();
		const first = limiter.withSlot("k", "first", async () => {
			await gate.promise;
		});
		const second = limiter.withSlot("k", "second", async () => {});

		await flush();
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("second waiting (1 running on k)"),
		);

		gate.resolve();
		await Promise.all([first, second]);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("second started on k"),
		);
	});
});
