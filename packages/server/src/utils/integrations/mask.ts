/** Masks a stored API key down to its last four characters. */
export const maskApiKey = (apiKey: string) =>
	apiKey.length > 4 ? `••••${apiKey.slice(-4)}` : "••••";

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
