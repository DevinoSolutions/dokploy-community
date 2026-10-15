// Pure helpers shared by the opt-in browser session replay. URLs in this app can
// carry secrets in the query string or hash (reset and invitation tokens, OAuth
// code/state, tRPC GET inputs), so every URL that leaves the browser through the
// replay SDKs goes through stripUrl first.

/** Drops credentials, query and hash. Tolerates relative URLs and non-URLs. */
export const stripUrl = (url: string): string => {
	if (typeof url !== "string") return url;
	const withoutQuery = url.split(/[?#]/, 1)[0] ?? "";
	return withoutQuery.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
};

const URL_WITH_QUERY_IN_TEXT =
	/((?:https?:\/\/[^\s"'<>`?#]+)|(?:\/api\/[^\s"'<>`?#]*))[?#](?:\{[^}]*\}|[^\s"'<>`])*/g;

/** Strips the query and hash from URLs embedded in free text such as error messages. */
export const stripUrlsInText = (text: string): string =>
	typeof text === "string" ? text.replace(URL_WITH_QUERY_IN_TEXT, "$1") : text;

// Pages whose URL or content carries a credential: password reset, invitations,
// registration and the MCP OAuth consent screen. Replay never starts on them.
const SENSITIVE_PATH_PREFIXES = [
	"/reset-password",
	"/send-reset-password",
	"/invitation",
	"/accept-invitation",
	"/register",
	"/mcp",
];

const SENSITIVE_PARAMS = new Set([
	"token",
	"code",
	"state",
	"access_token",
	"id_token",
	"refresh_token",
	"password",
	"secret",
	"client_secret",
	"code_challenge",
	"invitation",
]);

/**
 * True when the path or the query/hash parameters of a URL (absolute, or a
 * path with an optional query) mean the page must not be recorded.
 */
export const isSensitiveLocation = (url: string): boolean => {
	const relative = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
	const hashIndex = relative.indexOf("#");
	const beforeHash = hashIndex === -1 ? relative : relative.slice(0, hashIndex);
	const hash = hashIndex === -1 ? "" : relative.slice(hashIndex + 1);
	const queryIndex = beforeHash.indexOf("?");
	const rawPath =
		queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
	const query = queryIndex === -1 ? "" : beforeHash.slice(queryIndex + 1);

	const path = rawPath.toLowerCase().replace(/\/+$/, "") || "/";
	if (
		SENSITIVE_PATH_PREFIXES.some(
			(prefix) => path === prefix || path.startsWith(`${prefix}/`),
		)
	) {
		return true;
	}

	for (const source of [query, hash]) {
		if (!source) continue;
		for (const key of new URLSearchParams(source).keys()) {
			if (SENSITIVE_PARAMS.has(key.toLowerCase())) return true;
		}
	}
	return false;
};

// $current_url, $referrer, $initial_*, $session_entry_* and similar.
const URL_PROPERTY = /url|referrer|href/i;

/** Strips the query and hash from every URL-like property of a PostHog event. */
export const scrubUrlProperties = <T extends Record<string, unknown>>(
	properties: T,
): T => {
	for (const key of Object.keys(properties)) {
		const value = properties[key];
		if (typeof value === "string" && URL_PROPERTY.test(key)) {
			(properties as Record<string, unknown>)[key] = stripUrl(value);
		}
	}
	return properties;
};
