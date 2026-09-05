type Query = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

/** Same-origin relative path: starts with a single `/`, never `//` or `/\`. */
export const isSafeRelativePath = (
	value: string | undefined,
): value is string => typeof value === "string" && /^\/(?![\/\\])/.test(value);

const OAUTH_KEYS = [
	"client_id",
	"redirect_uri",
	"response_type",
	"state",
	"scope",
	"code_challenge",
	"code_challenge_method",
	"resource",
] as const;

/**
 * Where to send the user after a successful sign-in:
 * 1. a validated `redirect` query (set by pages that need the user back),
 * 2. the OAuth authorize parameters (better-auth's own login fallback shape) →
 *    the fork's consent page,
 * 3. the dashboard.
 */
export const getPostLoginDestination = (query: Query): string => {
	const redirect = first(query.redirect);
	if (isSafeRelativePath(redirect)) return redirect;
	const clientId = first(query.client_id);
	const redirectUri = first(query.redirect_uri);
	const responseType = first(query.response_type);
	if (clientId && redirectUri && responseType) {
		const params = new URLSearchParams();
		for (const key of OAUTH_KEYS) {
			const value = first(query[key]);
			if (value) params.set(key, value);
		}
		return `/mcp/authorize?${params.toString()}`;
	}
	return "/dashboard/home";
};
