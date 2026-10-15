// Opt-in browser session replay. The instance operator enables it at runtime
// (DOKPLOY_SESSION_REPLAY=true), so the SDKs are only ever loaded through the
// dynamic imports below: an install with it off never downloads them. Nothing
// here may import @sentry/browser or posthog-js statically.

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

let started = false;

const initSentry = async (config: SentryReplayConfig) => {
	const Sentry = await import("@sentry/browser");
	Sentry.init({
		dsn: config.dsn,
		release: config.release,
		environment: "production",
		sendDefaultPii: false,
		tracesSampleRate: 0,
		replaysSessionSampleRate: config.sessionSampleRate,
		replaysOnErrorSampleRate: config.onErrorSampleRate,
		// Console output can carry deployment logs.
		beforeBreadcrumb: (breadcrumb) =>
			breadcrumb.category === "console" ? null : breadcrumb,
		integrations: [
			Sentry.replayIntegration({
				// Dokploy renders secrets (env values, logs) as text, not only in inputs.
				maskAllText: true,
				maskAllInputs: true,
				blockAllMedia: true,
				mask: [".ph-sensitive"],
				block: [".ph-no-capture"],
				networkDetailAllowUrls: [],
			}),
		],
	});
};

const initPostHog = async (config: PostHogReplayConfig) => {
	const { default: posthog } = await import("posthog-js");
	posthog.init(config.key, {
		api_host: config.host,
		autocapture: false,
		// Pages router navigations are history changes, not page loads.
		capture_pageview: "history_change",
		person_profiles: "identified_only",
		respect_dnt: true,
		disable_session_recording: false,
		enable_recording_console_log: false,
		session_recording: {
			maskAllInputs: true,
			maskTextSelector: "*",
			// A client-side rate takes precedence over the project setting.
			sampleRate: config.sampleRate,
		},
	});
};

/**
 * Fetches the runtime telemetry config once and, only when the operator has
 * enabled replay, loads and initialises the SDKs. Failures are swallowed:
 * telemetry must never break the dashboard.
 */
export const startSessionReplay = async () => {
	if (started) return;
	started = true;
	try {
		const response = await fetch("/api/telemetry/config", {
			cache: "no-store",
		});
		if (!response.ok) return;
		const config = (await response.json()) as TelemetryConfigResponse;
		if (config.enabled !== true) return;

		const tasks: Promise<void>[] = [];
		if (config.sentry) tasks.push(initSentry(config.sentry));
		if (config.posthog) tasks.push(initPostHog(config.posthog));
		for (const result of await Promise.allSettled(tasks)) {
			if (result.status === "rejected") {
				console.warn("Session replay could not start", result.reason);
			}
		}
	} catch (error) {
		console.warn("Session replay could not start", error);
	}
};
