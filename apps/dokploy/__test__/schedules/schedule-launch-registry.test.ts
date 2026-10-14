import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The run records its launch in the module that runs the schedules; the cancel
 * reads it in the module that serves the router. The app can load two copies of
 * the module (a server bundle and a router chunk), so the records live in a slot
 * on globalThis that every copy shares.
 */

const SLOT = Symbol.for("dokploy.scheduleLaunches");

afterEach(() => {
	(globalThis as Record<symbol, unknown>)[SLOT] = undefined;
	vi.resetModules();
});

const loadCopy = async () => {
	vi.resetModules();
	return import("@dokploy/server/utils/schedules/launch");
};

describe("the schedule launch records", () => {
	it("are shared by two copies of the module", async () => {
		const runner = await loadCopy();
		const canceller = await loadCopy();
		expect(canceller).not.toBe(runner);

		runner.markScheduleRunChecking("dep-1");
		expect(canceller.getScheduleRunLaunch("dep-1")).toEqual({
			state: "checking",
		});

		runner.markScheduleRunLaunched("dep-1", 1234);
		expect(canceller.getScheduleRunLaunch("dep-1")).toEqual({
			state: "launched",
			at: 1234,
		});

		runner.forgetScheduleRunLaunch("dep-1");
		expect(canceller.getScheduleRunLaunch("dep-1")).toBeUndefined();
	});

	it("keep runs apart", async () => {
		const launch = await loadCopy();

		launch.markScheduleRunLaunched("dep-1", 1);
		launch.markScheduleRunChecking("dep-2");

		expect(launch.getScheduleRunLaunch("dep-1")).toEqual({
			state: "launched",
			at: 1,
		});
		expect(launch.getScheduleRunLaunch("dep-2")).toEqual({ state: "checking" });
		expect(launch.getScheduleRunLaunch("dep-3")).toBeUndefined();
	});

	it("live in a well-known slot on globalThis", async () => {
		const launch = await loadCopy();

		launch.markScheduleRunChecking("dep-1");

		const slot = (globalThis as Record<symbol, Map<string, unknown>>)[SLOT];
		expect(slot?.get("dep-1")).toEqual({ state: "checking" });
	});
});
