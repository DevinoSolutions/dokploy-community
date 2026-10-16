import { apiUpdateCompose } from "@dokploy/server/db/schema";
import {
	composeRollingReplaceSchema,
	ROLLING_DRAIN_DEFAULT_SECONDS,
	ROLLING_DRAIN_MAX_SECONDS,
	ROLLING_HEALTH_TIMEOUT_DEFAULT_SECONDS,
	ROLLING_HEALTH_TIMEOUT_MAX_SECONDS,
	ROLLING_HEALTH_TIMEOUT_MIN_SECONDS,
	ROLLING_MAX_SERVICES,
} from "@dokploy/server/db/validations/compose-rolling";
import { resolveComposeRolling } from "@dokploy/server/utils/builders/compose-rolling";
import { describe, expect, it } from "vitest";

describe("compose rolling replace schema", () => {
	it("fills the defaults", () => {
		const parsed = composeRollingReplaceSchema.parse({
			enabled: true,
			services: ["web"],
		});
		expect(parsed).toEqual({
			enabled: true,
			services: ["web"],
			healthTimeoutSeconds: ROLLING_HEALTH_TIMEOUT_DEFAULT_SECONDS,
			drainSeconds: ROLLING_DRAIN_DEFAULT_SECONDS,
		});
	});

	it("an empty object is a disabled setting with no services", () => {
		expect(composeRollingReplaceSchema.parse({})).toMatchObject({
			enabled: false,
			services: [],
		});
	});

	it("enabling needs at least one service", () => {
		expect(
			composeRollingReplaceSchema.safeParse({ enabled: true, services: [] })
				.success,
		).toBe(false);
		expect(
			composeRollingReplaceSchema.safeParse({ enabled: false, services: [] })
				.success,
		).toBe(true);
	});

	it.each([
		[
			"timeout below the minimum",
			{ healthTimeoutSeconds: ROLLING_HEALTH_TIMEOUT_MIN_SECONDS - 1 },
		],
		[
			"timeout above the maximum",
			{ healthTimeoutSeconds: ROLLING_HEALTH_TIMEOUT_MAX_SECONDS + 1 },
		],
		["fractional timeout", { healthTimeoutSeconds: 30.5 }],
		["negative drain", { drainSeconds: -1 }],
		[
			"drain above the maximum",
			{ drainSeconds: ROLLING_DRAIN_MAX_SECONDS + 1 },
		],
		["fractional drain", { drainSeconds: 1.5 }],
		["a duplicated service", { services: ["web", "web"] }],
		["an empty service name", { services: [""] }],
		["a service name with shell syntax", { services: ["web;rm -rf /"] }],
		["a service name with a space", { services: ["web api"] }],
		["a service name starting with a dash", { services: ["-web"] }],
		["a service name with a newline", { services: ["web\nx"] }],
		[
			"too many services",
			{
				services: Array.from(
					{ length: ROLLING_MAX_SERVICES + 1 },
					(_, i) => `s${i}`,
				),
			},
		],
		["services that are not strings", { services: [1] }],
	])("rejects %s", (_name, patch) => {
		expect(
			composeRollingReplaceSchema.safeParse({
				enabled: true,
				services: ["web"],
				...patch,
			}).success,
		).toBe(false);
	});

	it("accepts the boundary values", () => {
		for (const patch of [
			{ healthTimeoutSeconds: ROLLING_HEALTH_TIMEOUT_MIN_SECONDS },
			{ healthTimeoutSeconds: ROLLING_HEALTH_TIMEOUT_MAX_SECONDS },
			{ drainSeconds: 0 },
			{ drainSeconds: ROLLING_DRAIN_MAX_SECONDS },
			{ services: ["web", "my_api-2", "svc.v1"] },
		]) {
			expect(
				composeRollingReplaceSchema.safeParse({
					enabled: true,
					services: ["web"],
					...patch,
				}).success,
			).toBe(true);
		}
	});

	it("is part of the compose update input, nullable to switch it off", () => {
		const base = { composeId: "c1" };
		expect(
			apiUpdateCompose.safeParse({ ...base, rollingReplace: null }).success,
		).toBe(true);
		expect(
			apiUpdateCompose.safeParse({
				...base,
				rollingReplace: { enabled: true, services: ["web"] },
			}).success,
		).toBe(true);
		expect(
			apiUpdateCompose.safeParse({
				...base,
				rollingReplace: { enabled: true, services: ["web;x"] },
			}).success,
		).toBe(false);
	});
});

describe("resolving whatever is stored", () => {
	const on = { enabled: true, services: ["web"] };

	it.each([
		["null", null],
		["undefined", undefined],
		["an empty object", {}],
		["disabled", { enabled: false, services: ["web"] }],
		["enabled with no services", { enabled: true, services: [] }],
		["a string", "yes"],
		["an array", []],
		["a number", 1],
		[
			"a hand-edited row with a bad timeout",
			{ ...on, healthTimeoutSeconds: 1 },
		],
		[
			"a hand-edited row with a hostile service name",
			{ enabled: true, services: ["web;x"] },
		],
	])("%s is off", (_name, value) => {
		expect(resolveComposeRolling(value)).toBeNull();
	});

	it("a valid enabled setting resolves with its defaults", () => {
		expect(resolveComposeRolling(on)).toEqual({
			enabled: true,
			services: ["web"],
			healthTimeoutSeconds: ROLLING_HEALTH_TIMEOUT_DEFAULT_SECONDS,
			drainSeconds: ROLLING_DRAIN_DEFAULT_SECONDS,
		});
	});
});
