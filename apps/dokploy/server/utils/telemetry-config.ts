import { isTelemetryOptedOut, SENTRY_DSN } from "../sentry-config";

export const DEFAULT_SESSION_SAMPLE_RATE = 0.1;
export const DEFAULT_ON_ERROR_SAMPLE_RATE = 1;

export type TelemetryConfig =
	| { enabled: false }
	| {
			enabled: true;
			sentry: {
				dsn: string;
				release: string;
				sessionSampleRate: number;
				onErrorSampleRate: number;
			} | null;
			posthog: { key: string; host: string; sampleRate: number } | null;
	  };

const DISABLED: TelemetryConfig = { enabled: false };

/** Parses a rate defensively: anything unusable falls back, the rest is clamped to [0, 1]. */
export const parseSampleRate = (
	raw: string | undefined,
	fallback: number,
): number => {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) return fallback;
	return Math.min(1, Math.max(0, value));
};

/**
 * DOKPLOY_SESSION_REPLAY_SENTRY_DSN lets an operator send replays and browser
 * errors to their own Sentry. Unset means the built-in DSN. A set but invalid
 * value yields null (no Sentry replay) rather than silently falling back to the
 * built-in DSN, which would send the operator's sessions to the fork maintainers.
 */
export const resolveReplayDsn = (env: NodeJS.ProcessEnv): string | null => {
	const override = env.DOKPLOY_SESSION_REPLAY_SENTRY_DSN?.trim();
	if (!override) {
		return SENTRY_DSN.startsWith("https://") ? SENTRY_DSN : null;
	}
	try {
		const url = new URL(override);
		if (
			url.protocol === "https:" &&
			url.username &&
			url.hostname &&
			/\/\d+$/.test(url.pathname)
		) {
			return override;
		}
	} catch {}
	return null;
};

const parseHost = (raw: string | undefined): string | null => {
	const value = raw?.trim();
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return value.replace(/\/+$/, "");
	} catch {
		return null;
	}
};

/**
 * Browser session replay is opt-in per instance. It records what the dashboard
 * renders (deploy logs, env values, container output), so it must never turn on
 * for an install just because the built-in server Sentry DSN is present: the
 * operator has to set DOKPLOY_SESSION_REPLAY=true at runtime. The existing
 * Sentry opt-outs and non-production builds force it off.
 *
 * The result is served unauthenticated; when disabled it carries nothing else.
 */
export const buildTelemetryConfig = (
	env: NodeJS.ProcessEnv,
	release: string,
): TelemetryConfig => {
	if (
		env.DOKPLOY_SESSION_REPLAY !== "true" ||
		env.NODE_ENV !== "production" ||
		isTelemetryOptedOut(env)
	) {
		return DISABLED;
	}

	const sessionSampleRate = parseSampleRate(
		env.DOKPLOY_SESSION_REPLAY_SAMPLE_RATE,
		DEFAULT_SESSION_SAMPLE_RATE,
	);
	const onErrorSampleRate = parseSampleRate(
		env.DOKPLOY_SESSION_REPLAY_ON_ERROR_SAMPLE_RATE,
		DEFAULT_ON_ERROR_SAMPLE_RATE,
	);

	const dsn = resolveReplayDsn(env);
	const sentry = dsn
		? { dsn, release, sessionSampleRate, onErrorSampleRate }
		: null;

	const posthogKey = env.DOKPLOY_POSTHOG_KEY?.trim();
	const posthogHost = parseHost(env.DOKPLOY_POSTHOG_HOST);
	const posthog =
		posthogKey && posthogHost
			? { key: posthogKey, host: posthogHost, sampleRate: sessionSampleRate }
			: null;

	if (!sentry && !posthog) return DISABLED;
	return { enabled: true, sentry, posthog };
};
