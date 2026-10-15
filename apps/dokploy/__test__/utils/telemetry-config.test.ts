import {
	buildTelemetryConfig,
	parseSampleRate,
	resolveReplayDsn,
} from "@/server/utils/telemetry-config";
import { SENTRY_DSN } from "@/server/sentry-config";
import { describe, expect, it } from "vitest";

const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
const on = { ...prod, DOKPLOY_SESSION_REPLAY: "true" } as NodeJS.ProcessEnv;
const withPosthog = {
	...on,
	DOKPLOY_POSTHOG_KEY: "phc_abc",
	DOKPLOY_POSTHOG_HOST: "https://posthog.example.com/",
} as NodeJS.ProcessEnv;

describe("buildTelemetryConfig", () => {
	it("is off by default", () => {
		expect(buildTelemetryConfig(prod, "1.0.0")).toEqual({ enabled: false });
		expect(buildTelemetryConfig({} as NodeJS.ProcessEnv, "1.0.0")).toEqual({
			enabled: false,
		});
	});

	it("only turns on for the exact value true", () => {
		for (const value of ["1", "TRUE", "yes", "false", ""]) {
			expect(
				buildTelemetryConfig(
					{ ...prod, DOKPLOY_SESSION_REPLAY: value } as NodeJS.ProcessEnv,
					"1.0.0",
				),
			).toEqual({ enabled: false });
		}
	});

	it("is off outside production even with the switch", () => {
		expect(
			buildTelemetryConfig(
				{ ...on, NODE_ENV: "development" } as NodeJS.ProcessEnv,
				"1.0.0",
			),
		).toEqual({ enabled: false });
	});

	it("turns Sentry replay on with the switch and uses defaults", () => {
		expect(buildTelemetryConfig(on, "1.2.3")).toEqual({
			enabled: true,
			sentry: {
				dsn: SENTRY_DSN,
				release: "1.2.3",
				sessionSampleRate: 0.1,
				onErrorSampleRate: 1,
			},
			posthog: null,
		});
	});

	it("keeps PostHog null unless both key and host are set and valid", () => {
		const keyOnly = {
			...on,
			DOKPLOY_POSTHOG_KEY: "phc_abc",
		} as NodeJS.ProcessEnv;
		const hostOnly = {
			...on,
			DOKPLOY_POSTHOG_HOST: "https://posthog.example.com",
		} as NodeJS.ProcessEnv;
		const badHost = {
			...withPosthog,
			DOKPLOY_POSTHOG_HOST: "javascript:alert(1)",
		} as NodeJS.ProcessEnv;
		const blankKey = {
			...withPosthog,
			DOKPLOY_POSTHOG_KEY: "  ",
		} as NodeJS.ProcessEnv;
		for (const env of [keyOnly, hostOnly, badHost, blankKey]) {
			expect(buildTelemetryConfig(env, "1.0.0")).toMatchObject({
				enabled: true,
				posthog: null,
			});
		}
	});

	it("enables PostHog with key and host, trimming the trailing slash", () => {
		const config = buildTelemetryConfig(withPosthog, "1.0.0");
		expect(config).toMatchObject({
			enabled: true,
			posthog: {
				key: "phc_abc",
				host: "https://posthog.example.com",
				sampleRate: 0.1,
			},
		});
	});

	it("does not load PostHog when the switch is off", () => {
		expect(
			buildTelemetryConfig(
				{ ...withPosthog, DOKPLOY_SESSION_REPLAY: "false" } as NodeJS.ProcessEnv,
				"1.0.0",
			),
		).toEqual({ enabled: false });
	});

	it("lets the existing opt-outs win over the switch", () => {
		for (const optOut of [
			{ DOKPLOY_DISABLE_SENTRY: "true" },
			{ DO_NOT_TRACK: "1" },
			{ DO_NOT_TRACK: "true" },
		]) {
			expect(
				buildTelemetryConfig(
					{ ...withPosthog, ...optOut } as NodeJS.ProcessEnv,
					"1.0.0",
				),
			).toEqual({ enabled: false });
		}
	});

	it("does not treat DO_NOT_TRACK=0 as an opt-out", () => {
		expect(
			buildTelemetryConfig(
				{ ...on, DO_NOT_TRACK: "0" } as NodeJS.ProcessEnv,
				"1.0.0",
			),
		).toMatchObject({ enabled: true });
	});

	it("applies parsed and clamped sample rates to both SDKs", () => {
		const config = buildTelemetryConfig(
			{
				...withPosthog,
				DOKPLOY_SESSION_REPLAY_SAMPLE_RATE: "0.25",
				DOKPLOY_SESSION_REPLAY_ON_ERROR_SAMPLE_RATE: "7",
			} as NodeJS.ProcessEnv,
			"1.0.0",
		);
		expect(config).toMatchObject({
			sentry: { sessionSampleRate: 0.25, onErrorSampleRate: 1 },
			posthog: { sampleRate: 0.25 },
		});
	});

	it("leaks no DSN, key or host when disabled", () => {
		const json = JSON.stringify(
			buildTelemetryConfig(
				{
					...withPosthog,
					DOKPLOY_SESSION_REPLAY: "false",
				} as NodeJS.ProcessEnv,
				"1.0.0",
			),
		);
		expect(json).toBe('{"enabled":false}');
		expect(json).not.toContain(SENTRY_DSN);
		expect(json).not.toContain("phc_abc");
		expect(json).not.toContain("posthog.example.com");
	});
});

describe("parseSampleRate", () => {
	it("falls back when missing, blank or not a number", () => {
		expect(parseSampleRate(undefined, 0.1)).toBe(0.1);
		expect(parseSampleRate("", 0.1)).toBe(0.1);
		expect(parseSampleRate("   ", 0.1)).toBe(0.1);
		expect(parseSampleRate("abc", 0.1)).toBe(0.1);
		expect(parseSampleRate("NaN", 0.1)).toBe(0.1);
		expect(parseSampleRate("Infinity", 0.1)).toBe(0.1);
	});

	it("clamps to [0, 1]", () => {
		expect(parseSampleRate("-1", 0.1)).toBe(0);
		expect(parseSampleRate("0", 0.1)).toBe(0);
		expect(parseSampleRate("0.5", 0.1)).toBe(0.5);
		expect(parseSampleRate("1", 0.1)).toBe(1);
		expect(parseSampleRate("50", 0.1)).toBe(1);
	});
});

describe("DOKPLOY_SESSION_REPLAY_SENTRY_DSN override", () => {
	const own = "https://abc123@sentry.example.com/7";
	const withDsn = (value: string) =>
		({
			...on,
			DOKPLOY_SESSION_REPLAY_SENTRY_DSN: value,
		}) as NodeJS.ProcessEnv;

	it("uses the built-in DSN when unset or blank", () => {
		expect(resolveReplayDsn(on)).toBe(SENTRY_DSN);
		expect(resolveReplayDsn(withDsn("   "))).toBe(SENTRY_DSN);
	});

	it("uses a valid https override instead of the built-in DSN", () => {
		expect(resolveReplayDsn(withDsn(` ${own} `))).toBe(own);
		expect(buildTelemetryConfig(withDsn(own), "1.0.0")).toMatchObject({
			enabled: true,
			sentry: { dsn: own },
		});
		expect(JSON.stringify(buildTelemetryConfig(withDsn(own), "1.0.0"))).not.toContain(
			SENTRY_DSN,
		);
	});

	it("never falls back to the built-in DSN when the override is invalid", () => {
		for (const bad of [
			"http://abc@sentry.example.com/7",
			"https://sentry.example.com/7",
			"https://abc@sentry.example.com/",
			"https://abc@sentry.example.com/project",
			"not a url",
		]) {
			expect(resolveReplayDsn(withDsn(bad))).toBeNull();
			expect(buildTelemetryConfig(withDsn(bad), "1.0.0")).toEqual({
				enabled: false,
			});
		}
	});

	it("keeps PostHog running when only the Sentry override is invalid", () => {
		const config = buildTelemetryConfig(
			{
				...withPosthog,
				DOKPLOY_SESSION_REPLAY_SENTRY_DSN: "nope",
			} as NodeJS.ProcessEnv,
			"1.0.0",
		);
		expect(config).toMatchObject({
			enabled: true,
			sentry: null,
			posthog: { key: "phc_abc" },
		});
	});

	it("is ignored when the switch is off", () => {
		expect(
			buildTelemetryConfig(
				{
					...prod,
					DOKPLOY_SESSION_REPLAY_SENTRY_DSN: own,
				} as NodeJS.ProcessEnv,
				"1.0.0",
			),
		).toEqual({ enabled: false });
	});
});
