import * as Sentry from "@sentry/node";
import packageInfo from "../package.json";

// Public ingest-only DSN for the fork's error tracker. A DSN can only submit
// events — it grants no read access to the project — so it is safe in source.
const SENTRY_DSN = "https://d98cecf413db8997128f3519f26e3620@sentry.devino.ca/59";

const optedOut =
	process.env.DOKPLOY_DISABLE_SENTRY === "true" ||
	process.env.DO_NOT_TRACK === "1" ||
	process.env.DO_NOT_TRACK === "true";

export const isSentryEnabled =
	process.env.NODE_ENV === "production" &&
	!optedOut &&
	SENTRY_DSN.startsWith("https://");

if (isSentryEnabled) {
	Sentry.init({
		dsn: SENTRY_DSN,
		release: packageInfo.version,
		environment: "production",
		sendDefaultPii: false,
		tracesSampleRate: 0,
		// Console breadcrumbs can carry deployment output, and the process-level
		// handlers are managed explicitly in server.ts so its exit semantics
		// (see issue #4253) stay intact.
		integrations: (defaults) =>
			defaults.filter(
				(integration) =>
					!["Console", "OnUncaughtException", "OnUnhandledRejection"].includes(
						integration.name,
					),
			),
		beforeSend(event) {
			// The reporting instance's hostname identifies a user's server — drop it.
			event.server_name = undefined;
			return event;
		},
	});
}

export const captureError = (error: unknown, tags?: Record<string, string>) => {
	if (!isSentryEnabled) return;
	Sentry.captureException(error, tags ? { tags } : undefined);
};

/** Best-effort flush with a hard cap so crash paths still exit promptly. */
export const flushSentry = async (timeoutMs = 2000) => {
	if (!isSentryEnabled) return;
	try {
		await Sentry.flush(timeoutMs);
	} catch {}
};
