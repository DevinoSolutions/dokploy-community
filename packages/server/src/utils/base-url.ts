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

/**
 * Whether two integration base URLs point at the same API. Integrations store
 * a write-only credential that is sent as a Bearer token to their base URL, so
 * the stored credential may only be reused against an unchanged URL.
 */
export const isSameBaseUrl = (a: string, b: string) =>
	normalizeBaseUrl(a) === normalizeBaseUrl(b);
