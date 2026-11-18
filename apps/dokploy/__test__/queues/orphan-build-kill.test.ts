import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/services/deployment-cancel", () => ({
	stopBuildOnBuildServer: vi.fn(),
}));

import {
	killOrphanedBuilds,
	ORPHAN_KILL_BUDGET_MS,
} from "@dokploy/server/services/orphan-build-kill";

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("killOrphanedBuilds", () => {
	it("stops each build on its own build server, once per deployment", async () => {
		const stop = vi.fn(async () => ({ result: "KILLED" as const }));

		const summary = await killOrphanedBuilds(
			[
				{ deploymentId: "d1", buildServerId: "b1" },
				{ deploymentId: "d1", buildServerId: "b1" },
				{ deploymentId: "d2", buildServerId: "b2" },
			],
			{ stop },
		);

		expect(stop).toHaveBeenCalledTimes(2);
		expect(stop).toHaveBeenCalledWith("b1", "d1");
		expect(stop).toHaveBeenCalledWith("b2", "d2");
		expect(summary).toEqual({ attempted: 2, stopped: 2, unconfirmed: 0 });
	});

	it("skips deployments with no build server and does not call anything for an empty list", async () => {
		const stop = vi.fn();

		const summary = await killOrphanedBuilds(
			[
				{ deploymentId: "d1", buildServerId: null },
				{ deploymentId: "d2", buildServerId: undefined },
			],
			{ stop },
		);

		expect(stop).not.toHaveBeenCalled();
		expect(summary.attempted).toBe(0);
	});

	it("an answer of NONE or GONE (nothing left to stop) is not a failure", async () => {
		const stop = vi
			.fn()
			.mockResolvedValueOnce({ result: "NONE" })
			.mockResolvedValueOnce({ result: "GONE" });

		const summary = await killOrphanedBuilds(
			[
				{ deploymentId: "d1", buildServerId: "b1" },
				{ deploymentId: "d2", buildServerId: "b1" },
			],
			{ stop },
		);

		expect(summary).toEqual({ attempted: 2, stopped: 0, unconfirmed: 0 });
	});

	it("an unreachable server, a survivor and a thrown error are counted, logged, and never thrown", async () => {
		const stop = vi
			.fn()
			.mockResolvedValueOnce({
				result: "UNREACHABLE",
				warning: "Could not reach the build server",
			})
			.mockResolvedValueOnce({ result: "FAILED" })
			.mockRejectedValueOnce(new Error("boom"));

		const summary = await killOrphanedBuilds(
			[
				{ deploymentId: "d1", buildServerId: "b1" },
				{ deploymentId: "d2", buildServerId: "b2" },
				{ deploymentId: "d3", buildServerId: "b3" },
			],
			{ stop },
		);

		expect(summary).toEqual({ attempted: 3, stopped: 0, unconfirmed: 3 });
	});

	it("gives up after the budget so a hung build server cannot hold the boot", async () => {
		vi.useFakeTimers();
		const stop = vi.fn(() => new Promise<never>(() => {}));

		const done = killOrphanedBuilds(
			[
				{ deploymentId: "d1", buildServerId: "b1" },
				{ deploymentId: "d2", buildServerId: "b2" },
			],
			{ stop },
		);
		await vi.advanceTimersByTimeAsync(ORPHAN_KILL_BUDGET_MS - 1);
		let finished = false;
		void done.then(() => {
			finished = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(finished).toBe(false);
		await vi.advanceTimersByTimeAsync(2);

		await expect(done).resolves.toMatchObject({
			attempted: 2,
			unconfirmed: 2,
		});
	});

	it("logs ids and outcomes only, never a command", async () => {
		const log = vi.spyOn(console, "log");
		await killOrphanedBuilds([{ deploymentId: "d1", buildServerId: "b1" }], {
			stop: async () => ({ result: "KILLED" }),
		});

		const text = log.mock.calls.flat().join("\n");
		expect(text).toContain("d1");
		expect(text).toContain("b1");
		expect(text).toContain("KILLED");
		expect(text).not.toMatch(/kill -s|setsid|\.pid/);
	});
});
