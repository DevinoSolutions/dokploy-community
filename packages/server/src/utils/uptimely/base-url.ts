/**
 * The stored Uptimely API key is write-only and is sent as a Bearer token to
 * the configured base URL. Reusing it against a different URL would hand it to
 * whoever runs that URL, so a changed URL always needs the key typed again.
 */
export const UPTIMELY_URL_CHANGE_NEEDS_KEY_MESSAGE =
	"Enter the API key again to change the Uptimely URL.";

/** Scheme, lowercased host and path without trailing slashes. */
const normalizeBaseUrl = (value: string) => {
	const trimmed = value.trim();
	try {
		const url = new URL(trimmed);
		return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		return trimmed.replace(/\/+$/, "").toLowerCase();
	}
};

export const isSameUptimelyBaseUrl = (a: string, b: string) =>
	normalizeBaseUrl(a) === normalizeBaseUrl(b);
