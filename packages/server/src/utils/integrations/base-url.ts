/**
 * Integration API keys are write-only and are sent as a Bearer token to the
 * configured base URL. Reusing a stored key against a different URL would hand
 * it to whoever runs that URL, so a changed URL always needs the key typed
 * again. Shared by every integration that stores a key next to a base URL.
 */

/** Scheme, lowercased host (with port) and path without trailing slashes. */
const normalizeBaseUrl = (value: string) => {
	const trimmed = value.trim();
	try {
		const url = new URL(trimmed);
		return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		return trimmed.replace(/\/+$/, "").toLowerCase();
	}
};

/** Userinfo, query, hash, trailing slashes and host case do not count. */
export const isSameIntegrationBaseUrl = (a: string, b: string) =>
	normalizeBaseUrl(a) === normalizeBaseUrl(b);

/** The BAD_REQUEST message for a URL change submitted without the key. */
export const integrationUrlChangeNeedsKeyMessage = (
	integration: string,
	credential = "API key",
) => `Enter the ${credential} again to change the ${integration} URL.`;
