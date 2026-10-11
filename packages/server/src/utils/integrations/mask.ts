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

const URL_PARTS =
	/^((?:[a-z][a-z\d+.-]*:)?\/\/)?([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i;

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
 * as is. Idempotent. It works on the text, not on a parsed URL, so a value that
 * is not a valid URL is redacted the same way and nothing is normalized.
 */
export const redactUrl = (value: string) => {
	const parts = URL_PARTS.exec(value);
	if (!parts) return value;
	const [, prefix = "", authority = "", path = "", query, fragment] = parts;

	const at = authority.lastIndexOf("@");
	const host =
		at === -1 ? authority : `${URL_REDACTION}@${authority.slice(at + 1)}`;
	return [
		prefix,
		host,
		path,
		query === undefined ? "" : `?${redactQuery(query)}`,
		fragment === undefined ? "" : `#${fragment && URL_REDACTION}`,
	].join("");
};

/** Whether a URL carries the redaction mark, i.e. is (an edit of) a redacted one. */
export const containsUrlRedaction = (value: string) =>
	value.includes(URL_REDACTION);

const withoutTrailingSlashes = (value: string) =>
	value.trim().replace(/\/+$/, "");

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
