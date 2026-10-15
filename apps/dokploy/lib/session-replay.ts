// Opt-in browser session replay. The instance operator enables it at runtime
// (DOKPLOY_SESSION_REPLAY=true), so the SDKs are only ever loaded through the
// dynamic imports below: an install with it off never downloads them. Nothing
// here may import @sentry/browser or posthog-js statically, directly or through
// a statically imported module.
import { isSensitiveLocation } from "./telemetry-privacy";

interface SentryReplayConfig {
	dsn: string;
	release: string;
	sessionSampleRate: number;
	onErrorSampleRate: number;
}

interface PostHogReplayConfig {
	key: string;
	host: string;
	sampleRate: number;
}

interface TelemetryConfigResponse {
	enabled?: boolean;
	sentry?: SentryReplayConfig | null;
	posthog?: PostHogReplayConfig | null;
}

const RETRY_DELAY_MS = 5000;

let started = false;
let suppressed = false;
const stoppers: Array<() => unknown> = [];

const fetchConfig = async (): Promise<TelemetryConfigResponse | null> => {
	try {
		const response = await fetch("/api/telemetry/config", {
			cache: "no-store",
		});
		if (!response.ok) return null;
		return (await response.json()) as TelemetryConfigResponse;
	} catch {
		return null;
	}
};

const initSdks = async (config: TelemetryConfigResponse) => {
	const tasks: Promise<void>[] = [];
	if (config.sentry) {
		const sentry = config.sentry;
		tasks.push(
			import("./session-replay-sentry").then((module) => {
				if (suppressed) return;
				stoppers.push(module.startSentryReplay(sentry).stop);
			}),
		);
	}
	if (config.posthog) {
		const posthog = config.posthog;
		tasks.push(
			import("./session-replay-posthog").then((module) => {
				if (suppressed) return;
				stoppers.push(module.startPostHogReplay(posthog).stop);
			}),
		);
	}
	for (const result of await Promise.allSettled(tasks)) {
		if (result.status === "rejected") {
			console.warn("Session replay could not start", result.reason);
		}
	}
};

/**
 * Fetches the runtime telemetry config and, only when the operator has
 * enabled replay, loads and initialises the SDKs. Pages that carry credentials
 * are never recorded. A failed config fetch is retried once. Failures are
 * swallowed: telemetry must never break the dashboard.
 */
export const startSessionReplay = async () => {
	if (started || suppressed) return;
	if (isSensitiveLocation(window.location.href)) return;
	started = true;
	try {
		let config = await fetchConfig();
		if (!config) {
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
			config = await fetchConfig();
		}
		if (!config || config.enabled !== true || suppressed) return;
		await initSdks(config);
	} catch (error) {
		console.warn("Session replay could not start", error);
	}
};

/** Stops recording for the rest of the page load (used on credential pages). */
export const suppressSessionReplay = () => {
	suppressed = true;
	for (const stop of stoppers.splice(0)) {
		try {
			void Promise.resolve(stop()).catch(() => {});
		} catch {}
	}
};
