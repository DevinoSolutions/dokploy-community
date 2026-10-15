// Public ingest-only DSN for the fork's error tracker. A DSN can only submit
// events — it grants no read access to the project — so it is safe in source.
// Shared by the server SDK (sentry.ts) and the opt-in browser config
// (utils/telemetry-config.ts) so the string lives in exactly one place.
export const SENTRY_DSN =
	"https://d98cecf413db8997128f3519f26e3620@sentry.devino.ca/59";

/** The operator opt-outs: DOKPLOY_DISABLE_SENTRY=true or DO_NOT_TRACK=1/true. */
export const isTelemetryOptedOut = (env: NodeJS.ProcessEnv) =>
	env.DOKPLOY_DISABLE_SENTRY === "true" ||
	env.DO_NOT_TRACK === "1" ||
	env.DO_NOT_TRACK === "true";
