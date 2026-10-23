import { apiUpdateWebServerSettings } from "@dokploy/server/db/schema/web-server-settings";
import {
	apiAddDeploymentWatchdogExclusion,
	apiUpdateDeploymentWatchdog,
	DEFAULT_WATCHDOG_IDLE_MINUTES,
	DEFAULT_WATCHDOG_MAX_MINUTES,
	evaluateWatchdog,
	isWatchdogExcluded,
	MIN_WATCHDOG_IDLE_MINUTES,
	MIN_WATCHDOG_MAX_MINUTES,
	resolveWatchdogConfig,
	WATCHDOG_FAILED_LINE,
	watchdogTriggerLine,
} from "@dokploy/server/utils/deployments/watchdog-config";
import { describe, expect, it } from "vitest";

/** The watchdog's settings: defaults, bounds, validation and the decision rule. */

const MIN = 60_000;

describe("defaults", () => {
	it("is on, 20 minutes idle, 90 minutes wall, nothing excluded", () => {
		expect(resolveWatchdogConfig(null)).toEqual({
			enabled: true,
			idleMinutes: 20,
			maxMinutes: 90,
			exclusions: [],
		});
		expect(DEFAULT_WATCHDOG_IDLE_MINUTES).toBe(20);
		expect(DEFAULT_WATCHDOG_MAX_MINUTES).toBe(90);
	});

	it("reads the stored row", () => {
		expect(
			resolveWatchdogConfig({
				deploymentWatchdogEnabled: false,
				deploymentWatchdogIdleMinutes: 30,
				deploymentWatchdogMaxMinutes: 120,
				deploymentWatchdogExclusions: [{ type: "compose", id: "c1" }],
			}),
		).toEqual({
			enabled: false,
			idleMinutes: 30,
			maxMinutes: 120,
			exclusions: [{ type: "compose", id: "c1" }],
		});
	});

	it("clamps a stored value outside its bounds instead of failing deployments eagerly", () => {
		const config = resolveWatchdogConfig({
			deploymentWatchdogIdleMinutes: 1,
			deploymentWatchdogMaxMinutes: 2,
		});
		// 15: a build step can be silent for several minutes, so less than that would kill healthy builds.
		expect(MIN_WATCHDOG_IDLE_MINUTES).toBe(15);
		expect(config.idleMinutes).toBe(MIN_WATCHDOG_IDLE_MINUTES);
		expect(config.maxMinutes).toBe(MIN_WATCHDOG_MAX_MINUTES);
	});

	it("keeps the wall limit at or above the idle limit", () => {
		const config = resolveWatchdogConfig({
			deploymentWatchdogIdleMinutes: 200,
			deploymentWatchdogMaxMinutes: 30,
		});
		expect(config.maxMinutes).toBeGreaterThanOrEqual(config.idleMinutes);
	});

	it("ignores an unreadable exclusion list", () => {
		expect(
			resolveWatchdogConfig({
				deploymentWatchdogExclusions: "not a list" as never,
			}).exclusions,
		).toEqual([]);
	});
});

describe("settings validation", () => {
	const valid = { enabled: true, idleMinutes: 20, maxMinutes: 90 };

	it("accepts the defaults and the minimums", () => {
		expect(apiUpdateDeploymentWatchdog.safeParse(valid).success).toBe(true);
		expect(
			apiUpdateDeploymentWatchdog.safeParse({
				enabled: false,
				idleMinutes: 15,
				maxMinutes: 15,
			}).success,
		).toBe(true);
	});

	it.each([
		["idle below 15", { ...valid, idleMinutes: 14 }],
		["idle of the old minimum", { ...valid, idleMinutes: 5 }],
		["wall below 15", { ...valid, maxMinutes: 14 }],
		["idle not a whole number", { ...valid, idleMinutes: 20.5 }],
		["idle as text", { ...valid, idleMinutes: "20" }],
		["idle zero", { ...valid, idleMinutes: 0 }],
		["idle negative", { ...valid, idleMinutes: -1 }],
		["wall absurdly large", { ...valid, maxMinutes: 10_000_000 }],
		["idle absurdly large", { ...valid, idleMinutes: 10_000_000 }],
		["wall shorter than idle", { ...valid, idleMinutes: 60, maxMinutes: 30 }],
		["enabled missing", { idleMinutes: 20, maxMinutes: 90 }],
		["enabled as text", { ...valid, enabled: "yes" }],
	])("rejects %s", (_name, input) => {
		expect(apiUpdateDeploymentWatchdog.safeParse(input).success).toBe(false);
	});

	it("says why a shorter wall limit is refused", () => {
		const result = apiUpdateDeploymentWatchdog.safeParse({
			...valid,
			idleMinutes: 60,
			maxMinutes: 30,
		});
		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error?.issues)).toContain("wall time limit");
	});

	it("applies the same bounds to the web server settings update", () => {
		expect(
			apiUpdateWebServerSettings.safeParse({
				deploymentWatchdogIdleMinutes: 3,
			}).success,
		).toBe(false);
		expect(
			apiUpdateWebServerSettings.safeParse({
				deploymentWatchdogMaxMinutes: 10,
			}).success,
		).toBe(false);
		expect(
			apiUpdateWebServerSettings.safeParse({
				deploymentWatchdogEnabled: false,
				deploymentWatchdogIdleMinutes: 15,
			}).success,
		).toBe(true);
	});

	it("validates an exclusion", () => {
		expect(
			apiAddDeploymentWatchdogExclusion.safeParse({
				type: "application",
				id: "a1",
				reason: "long migrations",
			}).success,
		).toBe(true);
		expect(
			apiAddDeploymentWatchdogExclusion.safeParse({
				type: "postgres",
				id: "a1",
			}).success,
		).toBe(false);
		expect(
			apiAddDeploymentWatchdogExclusion.safeParse({ type: "compose", id: "" })
				.success,
		).toBe(false);
	});
});

describe("exclusions", () => {
	const list = [
		{ type: "application", id: "a1" },
		{ type: "compose", id: "c1" },
	] as const;

	it("match by kind and id", () => {
		expect(isWatchdogExcluded(list, { applicationId: "a1" })).toBe(true);
		expect(isWatchdogExcluded(list, { composeId: "c1" })).toBe(true);
		expect(isWatchdogExcluded(list, { applicationId: "c1" })).toBe(false);
		expect(isWatchdogExcluded(list, { composeId: "a1" })).toBe(false);
		expect(isWatchdogExcluded(list, {})).toBe(false);
	});

	it("exclude nothing by default", () => {
		expect(isWatchdogExcluded([], { applicationId: "a1" })).toBe(false);
	});
});

describe("evaluateWatchdog", () => {
	const limits = { idleMinutes: 20, maxMinutes: 90 };

	it("passes a deployment inside both limits", () => {
		expect(
			evaluateWatchdog(limits, { runningMs: 30 * MIN, idleMs: 5 * MIN }),
		).toBeNull();
	});

	it("flags idleness past the limit, and only strictly past it", () => {
		expect(
			evaluateWatchdog(limits, { runningMs: 30 * MIN, idleMs: 20 * MIN }),
		).toBeNull();
		expect(
			evaluateWatchdog(limits, { runningMs: 30 * MIN, idleMs: 21 * MIN }),
		).toEqual({ kind: "idle", minutes: 20, observedMinutes: 21 });
	});

	it("flags wall time past the limit even when the log is fresh", () => {
		expect(
			evaluateWatchdog(limits, { runningMs: 91 * MIN, idleMs: 0 }),
		).toEqual({ kind: "wall", minutes: 90, observedMinutes: 91 });
	});

	it("reports the wall limit when both are past", () => {
		expect(
			evaluateWatchdog(limits, { runningMs: 120 * MIN, idleMs: 50 * MIN })
				?.kind,
		).toBe("wall");
	});

	it("applies only the wall limit when the log cannot be read", () => {
		expect(
			evaluateWatchdog(limits, { runningMs: 60 * MIN, idleMs: null }),
		).toBeNull();
		expect(
			evaluateWatchdog(limits, { runningMs: 100 * MIN, idleMs: null })?.kind,
		).toBe("wall");
	});
});

describe("log lines", () => {
	it("say what happened", () => {
		expect(
			watchdogTriggerLine({ kind: "idle", minutes: 20, observedMinutes: 25 }),
		).toBe("Watchdog: no log output for 20 min");
		expect(
			watchdogTriggerLine({ kind: "wall", minutes: 90, observedMinutes: 95 }),
		).toBe("Watchdog: exceeded 90 min");
		expect(WATCHDOG_FAILED_LINE).toBe("Watchdog: marked failed");
	});
});
