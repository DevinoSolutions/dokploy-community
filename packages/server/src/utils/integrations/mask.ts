import { trimTrailingSlashes } from "./base-url";

/**
 * Masks a stored API key down to its last four characters. A shorter value
 * would mostly give itself away, so it is hidden entirely.
 */
export const maskApiKey = (apiKey: string) =>
	apiKey.length >= 12 ? `••••${apiKey.slice(-4)}` : "••••";

/**
 * Masks a webhook URL (where the URL itself is the credential) down to its
 * scheme, host and the last four characters, e.g.
 * `https://hooks.slack.com/…abcd`, so the webhook stays recognizable. Userinfo,
 * path and query never survive.
 */
export const maskWebhookUrl = (webhookUrl: string) => {
	const trimmed = webhookUrl.trim();
	try {
		const url = new URL(trimmed);
		const tail = trimmed.length > 8 ? trimmed.slice(-4) : "";
		return `${url.protocol}//${url.host}/…${tail}`;
	} catch {
		return maskApiKey(trimmed);
	}
};

/**
 * Masks every value of a header map; the header names stay visible. The column
 * is untyped JSON, so a value that is not a string (null, a number) is fully
 * hidden instead of throwing.
 */
export const maskHeaderValues = (
	headers: Record<string, string | null> | null,
) =>
	Object.fromEntries(
		Object.entries(headers ?? {}).map(([name, value]) => [
			name,
			typeof value === "string" ? maskApiKey(value) : "••••",
		]),
	);

const URL_REDACTION = "••••";

const redactQuery = (query: string) =>
	query
		.split("&")
		.map((pair) => {
			const equals = pair.indexOf("=");
			// A bare `?token` is a value without a name.
			if (equals === -1) return pair ? URL_REDACTION : pair;
			const key = pair.slice(0, equals);
			return pair.length > equals + 1 ? `${key}=${URL_REDACTION}` : pair;
		})
		.join("&");

/**
 * Hides what a pasted non-secret URL may carry besides its address: the
 * userinfo (`https://user:pass@host`), the query values (`?token=...`) and the
 * fragment. Scheme, host, port, path and the query keys stay, and a URL
 * without any of them comes back exactly as stored, so the edit form shows it
 * as is. Idempotent.
 *
 * An http(s) URL is split the way `fetch` splits it (WHATWG, so `\` ends the
 * host like `/` does), and the shown host is the one that is called. Anything
 * else fails closed: a value that does not parse is returned as is only when
 * it has no character that could carry a secret (`@ ? # \`), and fully masked
 * otherwise. No regular expression runs over the value, so a huge or hostile
 * value costs linear time.
 */
export const redactUrl = (value: string) => {
	if (value === "") return value;
	let url: URL | undefined;
	try {
		url = new URL(value);
	} catch {
		url = undefined;
	}
	if (url && (url.protocol === "http:" || url.protocol === "https:")) {
		const userinfo = url.username || url.password ? `${URL_REDACTION}@` : "";
		const search =
			url.search.length > 1 ? `?${redactQuery(url.search.slice(1))}` : "";
		const hash = url.hash.length > 1 ? `#${URL_REDACTION}` : "";
		if (
			!userinfo &&
			!hash &&
			search === (url.search.length > 1 ? url.search : "")
		) {
			return value;
		}
		return `${url.protocol}//${userinfo}${url.host}${url.pathname}${search}${hash}`;
	}
	return /[@?#\\]/.test(value) ? URL_REDACTION : value;
};

/** Whether a URL carries the redaction mark, i.e. is (an edit of) a redacted one. */
export const containsUrlRedaction = (value: string) =>
	value.includes(URL_REDACTION);

const withoutTrailingSlashes = (value: string) =>
	trimTrailingSlashes(value.trim());

/**
 * The edit form shows the redacted URL and sends it back when it was not
 * edited. That echo means "keep the stored URL": it is not a change, and must
 * never be written over the stored one. A stored URL with nothing to redact
 * has no such echo: what comes back is simply what was typed.
 */
export const isRedactedUrlEcho = (input: string, stored: string) => {
	const redacted = redactUrl(stored);
	return (
		redacted !== stored &&
		withoutTrailingSlashes(input) === withoutTrailingSlashes(redacted)
	);
};
