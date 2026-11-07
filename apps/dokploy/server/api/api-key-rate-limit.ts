import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Body `code` of the 429 a throttled API key gets. A throttled key is still a
 * good key: answering 401 made CI pollers treat a busy key as a lost login.
 */
export const API_KEY_RATE_LIMITED_CODE = "RATE_LIMITED";

export interface ApiKeyRateLimitInfo {
	retryAfterSeconds: number;
	/** First 8 characters of the key id; never the key value. */
	keyIdPrefix?: string;
}

const routeOf = (req: Pick<IncomingMessage, "url">) =>
	(req.url ?? "").split("?")[0] || "<unknown>";

/** One warn line per throttled request: key id prefix, route, remaining window. */
export const logApiKeyRateLimited = (
	req: Pick<IncomingMessage, "url">,
	info: ApiKeyRateLimitInfo,
) => {
	console.warn(
		`[api-key] rate limited: keyId=${info.keyIdPrefix ?? "unknown"} route=${routeOf(req)} retryAfter=${info.retryAfterSeconds}s`,
	);
};

export const apiKeyRateLimitedMessage = (retryAfterSeconds: number) =>
	`Rate limit exceeded for this API key. Retry in ${retryAfterSeconds}s.`;

/** Sets `Retry-After`; skips transports without HTTP headers (websocket). */
export const setRetryAfter = (res: unknown, retryAfterSeconds: number) => {
	const target = res as Partial<Pick<ServerResponse, "setHeader">> | undefined;
	if (typeof target?.setHeader === "function") {
		target.setHeader("Retry-After", String(retryAfterSeconds));
	}
};

/**
 * Answers 429 + `Retry-After` + `{ code: "RATE_LIMITED", message }` and logs
 * the throttle once.
 */
export const respondApiKeyRateLimited = (
	req: IncomingMessage,
	res: ServerResponse,
	info: ApiKeyRateLimitInfo,
) => {
	logApiKeyRateLimited(req, info);
	res.statusCode = 429;
	res.setHeader("Retry-After", String(info.retryAfterSeconds));
	res.setHeader("Content-Type", "application/json");
	res.end(
		JSON.stringify({
			code: API_KEY_RATE_LIMITED_CODE,
			message: apiKeyRateLimitedMessage(info.retryAfterSeconds),
		}),
	);
};
