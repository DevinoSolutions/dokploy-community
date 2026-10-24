import {
	DEFAULT_DOCKER_CLEANUP_CRON,
	DOCKER_CLEANUP_TIMEZONE,
	dockerCleanupCronSchema,
	dockerCleanupRule,
	parseDockerCleanupCron,
} from "@dokploy/server/utils/docker/cleanup-schedule";
import { describe, expect, it } from "vitest";

/**
 * T-7344: the nightly Docker cleanup used to be a hardcoded "50 23 * * *" in
 * the container's local time. It is now a per-host 5-field cron read in UTC,
 * default 04:00 UTC, and never more often than hourly.
 */

describe("DEFAULT_DOCKER_CLEANUP_CRON", () => {
	it("is 04:00 UTC every day and passes its own validation", () => {
		expect(DEFAULT_DOCKER_CLEANUP_CRON).toBe("0 4 * * *");
		expect(parseDockerCleanupCron(DEFAULT_DOCKER_CLEANUP_CRON)).toEqual({
			ok: true,
			expression: "0 4 * * *",
		});
	});
});

describe("parseDockerCleanupCron", () => {
	it.each([
		"0 4 * * *",
		"30 3 * * 0",
		"0 0 1 * *",
		"15 2 * * 1-5",
		"0 */6 * * *",
		"0 1,13 * * *",
		"0 * * * *", // hourly is the most often it may run
		"59 23 31 12 7",
		"5 4 1-15/2 * *",
	])("accepts %s", (cron) => {
		expect(parseDockerCleanupCron(cron)).toEqual({
			ok: true,
			expression: cron,
		});
	});

	it("collapses whitespace", () => {
		expect(parseDockerCleanupCron("  0   4 *  * *  ")).toEqual({
			ok: true,
			expression: "0 4 * * *",
		});
	});

	it.each([
		["", "empty"],
		["0 4 * *", "4 fields"],
		["0 4 * * * *", "6 fields (seconds)"],
		["@daily", "alias"],
	])("rejects the wrong field count: %s (%s)", (cron) => {
		const result = parseDockerCleanupCron(cron);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("5-field");
	});

	it.each([
		["* * * * *", "every minute"],
		["*/15 * * * *", "every 15 minutes"],
		["0,30 * * * *", "twice an hour"],
		["10-20 4 * * *", "a range of minutes"],
	])("rejects schedules that run more often than hourly: %s (%s)", (cron) => {
		const result = parseDockerCleanupCron(cron);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("once an hour");
	});

	it.each([
		"60 4 * * *",
		"0 24 * * *",
		"0 4 0 * *",
		"0 4 32 * *",
		"0 4 * 13 *",
		"0 4 * * 8",
		"0 4-2 * * *",
		"0 4 * * mon",
		"a b c d e",
		"0 */0 * * *",
		"0 4/ * * *",
		"0 4,,5 * * *",
		"0 4-5-6 * * *",
		"0 4/2 * * *",
	])("rejects out-of-range or malformed fields: %s", (cron) => {
		expect(parseDockerCleanupCron(cron).ok).toBe(false);
	});

	it.each([
		"0 4 31 2 *",
		"0 4 30 2 *",
		"0 4 31 4 *",
		"0 4 31 4,6,9,11 *",
		"0 4 30-31 2 *",
	])("rejects a day that none of the months has: %s", (cron) => {
		const result = parseDockerCleanupCron(cron);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("never");
	});

	it.each([
		"0 4 29 2 *", // leap years
		"0 4 31 1,2 *", // January has it
		"0 4 31 * *",
		"0 4 30,31 2,3 *",
		"0 4 31 2 1", // the weekday can still fire
	])("accepts a day that some month has: %s", (cron) => {
		expect(parseDockerCleanupCron(cron).ok).toBe(true);
	});
});

describe("dockerCleanupCronSchema (the tRPC input)", () => {
	it("parses to the normalised expression", () => {
		expect(dockerCleanupCronSchema.parse(" 0  3 * * * ")).toBe("0 3 * * *");
	});

	it("reports why a schedule is refused", () => {
		const result = dockerCleanupCronSchema.safeParse("*/5 * * * *");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("once an hour");
		}
	});

	it("is optional where the inputs make it so", () => {
		expect(dockerCleanupCronSchema.optional().parse(undefined)).toBeUndefined();
	});
});

describe("dockerCleanupRule (what node-schedule gets)", () => {
	it("pins the timezone to UTC", () => {
		expect(DOCKER_CLEANUP_TIMEZONE).toBe("Etc/UTC");
		expect(dockerCleanupRule("30 2 * * *")).toEqual({
			rule: "30 2 * * *",
			tz: "Etc/UTC",
		});
	});

	it("falls back to the default for a stored value that cannot be read", () => {
		for (const stored of [null, undefined, "", "garbage", "* * * * *"]) {
			expect(dockerCleanupRule(stored)).toEqual({
				rule: "0 4 * * *",
				tz: "Etc/UTC",
			});
		}
	});
});
