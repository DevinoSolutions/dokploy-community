import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeManualDeploy } from "@/server/api/utils/manual-deploy-lock";

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

describe("serializeManualDeploy", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("runs tasks for one key in arrival order, one at a time", async () => {
		const log: string[] = [];
		const gate = deferred();
		const first = serializeManualDeploy("k", async () => {
			log.push("first:start");
			await gate.promise;
			log.push("first:end");
		});
		const second = serializeManualDeploy("k", async () => {
			log.push("second:start");
		});
		await vi.advanceTimersByTimeAsync(10);
		expect(log).toEqual(["first:start"]);

		gate.resolve();
		await Promise.all([first, second]);

		expect(log).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("does not make different keys wait for each other", async () => {
		const gate = deferred();
		const slow = serializeManualDeploy("a", () => gate.promise);
		const fast = vi.fn(async () => "done");

		await serializeManualDeploy("b", fast);

		expect(fast).toHaveBeenCalledTimes(1);
		gate.resolve();
		await slow;
	});

	it("goes on without a predecessor that has not settled after 60 s, and warns", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const stuck = deferred();
		const first = serializeManualDeploy("k", () => stuck.promise);
		const second = vi.fn(async () => "second");
		const secondRun = serializeManualDeploy("k", second);

		await vi.advanceTimersByTimeAsync(59_999);
		expect(second).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await expect(secondRun).resolves.toBe("second");

		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("k");
		stuck.resolve();
		await first;
	});

	it("keeps the chain intact after a timeout: a late predecessor does not release the next waiter early", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const stuck = deferred();
		const secondGate = deferred();
		const order: string[] = [];
		const first = serializeManualDeploy("k", () => stuck.promise);
		const second = serializeManualDeploy("k", async () => {
			order.push("second:start");
			await secondGate.promise;
			order.push("second:end");
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(order).toEqual(["second:start"]);
		const third = serializeManualDeploy("k", async () => {
			order.push("third");
		});

		stuck.resolve();
		await first;
		await vi.advanceTimersByTimeAsync(10);
		expect(order).toEqual(["second:start"]);

		secondGate.resolve();
		await Promise.all([second, third]);
		expect(order).toEqual(["second:start", "second:end", "third"]);
	});

	it("cleans up: a later call on the key runs at once and no timer is left behind", async () => {
		await serializeManualDeploy("k", async () => "a");
		await expect(serializeManualDeploy("k", async () => "b")).resolves.toBe(
			"b",
		);

		expect(vi.getTimerCount()).toBe(0);
	});

	it("a rejected task does not hold up the next one", async () => {
		const first = serializeManualDeploy("k", async () => {
			throw new Error("boom");
		});
		const second = serializeManualDeploy("k", async () => "ok");

		await expect(first).rejects.toThrow("boom");
		await expect(second).resolves.toBe("ok");
	});
});
