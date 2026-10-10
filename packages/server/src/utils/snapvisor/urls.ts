import {
	integrationUrlChangeNeedsKeyMessage,
	isSameIntegrationBaseUrl,
} from "../integrations/base-url";

/** Snapvisor hosts. The API and the web app live on different hosts. */
export const SNAPVISOR_DEFAULT_BASE_URL = "https://api.snapvisor.io";
export const SNAPVISOR_WEB_URL = "https://app.snapvisor.io";

const stripTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

/**
 * Integrations saved before the default moved to the API host store
 * `https://app.snapvisor.io`, which serves the web SPA (HTML) for `/v2/*`.
 * Treat exactly that value (with or without trailing slash) as the API host.
 */
export const normalizeSnapvisorApiBaseUrl = (baseUrl: string) => {
	const trimmed = stripTrailingSlashes(baseUrl.trim());
	return trimmed.toLowerCase() === SNAPVISOR_WEB_URL
		? SNAPVISOR_DEFAULT_BASE_URL
		: trimmed;
};

/**
 * Host that serves the Snapvisor web app (build/project pages) for a stored
 * API base URL: `api.snapvisor.io` and the legacy `app.snapvisor.io` map to
 * the web app, any other (self-hosted) base URL is used as-is.
 */
export const snapvisorWebBaseUrl = (baseUrl: string) => {
	const api = normalizeSnapvisorApiBaseUrl(baseUrl);
	return api === SNAPVISOR_DEFAULT_BASE_URL ? SNAPVISOR_WEB_URL : api;
};

/**
 * The stored Snapvisor access token is write-only and is sent as a Bearer
 * token to the configured base URL. Reusing it against a different URL would
 * hand it to whoever runs that URL, so a changed URL always needs the token
 * typed again.
 */
export const SNAPVISOR_URL_CHANGE_NEEDS_TOKEN_MESSAGE =
	integrationUrlChangeNeedsKeyMessage("Snapvisor", "access token");

/**
 * Same API host after normalization: the legacy `app.snapvisor.io` value and
 * the `api.snapvisor.io` default are one host for token purposes.
 */
export const isSameSnapvisorBaseUrl = (a: string, b: string) =>
	isSameIntegrationBaseUrl(
		normalizeSnapvisorApiBaseUrl(a),
		normalizeSnapvisorApiBaseUrl(b),
	);
