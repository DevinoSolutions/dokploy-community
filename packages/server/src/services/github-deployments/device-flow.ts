import {
	GITHUB_DEVICE_DEFAULT_CLIENT_ID,
	GITHUB_DEVICE_SCOPE,
} from "@dokploy/server/db/schema/github-deployment";

/**
 * GitHub OAuth device flow (RFC 8628) for the public OAuth App
 * "Dokploy Community". There is no client secret and the tokens do not expire.
 *
 * Everything here is a pure state machine over an injected `fetch` and clock,
 * so the whole protocol is unit tested without a network. The `device_code`
 * never leaves the server: callers get a `flowId` and the user-facing code.
 */

export type FetchLike = (
	input: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<{
	ok: boolean;
	status: number;
	headers: { get(name: string): string | null };
	json(): Promise<unknown>;
	text(): Promise<string>;
}>;

/** No GitHub request waits longer than this: a hung connection must not stall a poll tick or a dashboard call. */
export const GITHUB_FETCH_TIMEOUT_MS = 15_000;

/**
 * The real `fetch` for GitHub: every request is cut off after
 * GITHUB_FETCH_TIMEOUT_MS. A timeout rejects like any network failure, which
 * every caller already handles.
 */
export const createGithubFetch =
	(
		base: (url: string, init?: RequestInit) => Promise<Response> = (
			url,
			init,
		) => fetch(url, init),
		timeoutMs: number = GITHUB_FETCH_TIMEOUT_MS,
	): FetchLike =>
	(url, init) =>
		base(url, {
			...(init as RequestInit | undefined),
			signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
		});

/** The page the user is sent to is rendered as a link: it has to be on github.com. */
export const VERIFICATION_URI_PREFIX = "https://github.com/";

export const DEVICE_CODE_URL = "https://github.com/login/device/code";
export const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** Client id of the public OAuth App; override with DOKPLOY_GITHUB_DEVICE_CLIENT_ID. */
export const getDeviceClientId = (
	env: Record<string, string | undefined> = process.env,
): string => {
	const override = env.DOKPLOY_GITHUB_DEVICE_CLIENT_ID?.trim();
	return override && /^[A-Za-z0-9._-]{8,64}$/.test(override)
		? override
		: GITHUB_DEVICE_DEFAULT_CLIENT_ID;
};

/** GitHub asks clients to wait at least `interval` seconds; never go below 1. */
const MIN_INTERVAL_SECONDS = 1;
/** A slow_down answer without its own interval adds 5 seconds (RFC 8628 3.5). */
const SLOW_DOWN_STEP_SECONDS = 5;

export interface DeviceFlowState {
	/** Secret; stays on the server. */
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	intervalSeconds: number;
	/** Epoch ms before which no poll is made. */
	nextPollAt: number;
	/** Epoch ms at which the codes stop working. */
	expiresAt: number;
}

export type StartResult =
	| { ok: true; state: DeviceFlowState }
	| { ok: false; message: string };

const asRecord = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};

const formBody = (fields: Record<string, string>) =>
	new URLSearchParams(fields).toString();

const GITHUB_HEADERS = {
	Accept: "application/json",
	"Content-Type": "application/x-www-form-urlencoded",
	"User-Agent": "dokploy-community",
};

/** Step 1: ask GitHub for a device code and the code the user types. */
export const startDeviceFlow = async (deps: {
	fetch: FetchLike;
	now: () => number;
	clientId?: string;
	scope?: string;
}): Promise<StartResult> => {
	let response: Awaited<ReturnType<FetchLike>>;
	try {
		response = await deps.fetch(DEVICE_CODE_URL, {
			method: "POST",
			headers: GITHUB_HEADERS,
			body: formBody({
				client_id: deps.clientId ?? getDeviceClientId(),
				scope: deps.scope ?? GITHUB_DEVICE_SCOPE,
			}),
		});
	} catch {
		return { ok: false, message: "Could not reach github.com" };
	}
	const body = asRecord(await response.json().catch(() => null));
	if (!response.ok || typeof body.error === "string") {
		const reason =
			typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
		return {
			ok: false,
			message:
				body.error === "device_flow_disabled"
					? "Device flow is not enabled for the GitHub OAuth App"
					: `GitHub refused the device code request (${reason})`,
		};
	}
	const { device_code, user_code, verification_uri, expires_in, interval } =
		body;
	if (
		typeof device_code !== "string" ||
		typeof user_code !== "string" ||
		typeof verification_uri !== "string" ||
		!verification_uri.startsWith(VERIFICATION_URI_PREFIX) ||
		typeof expires_in !== "number"
	) {
		return { ok: false, message: "GitHub answered with an unexpected body" };
	}
	const intervalSeconds = Math.max(
		MIN_INTERVAL_SECONDS,
		typeof interval === "number" ? Math.floor(interval) : 5,
	);
	const now = deps.now();
	return {
		ok: true,
		state: {
			deviceCode: device_code,
			userCode: user_code,
			verificationUri: verification_uri,
			intervalSeconds,
			nextPollAt: now + intervalSeconds * 1000,
			expiresAt: now + expires_in * 1000,
		},
	};
};

export type StepResult =
	| { status: "pending"; state: DeviceFlowState; retryAfterSeconds: number }
	| { status: "authorized"; accessToken: string; scope: string }
	| { status: "expired" }
	| { status: "denied" }
	| { status: "failed"; message: string };

/**
 * Step 2, repeated: one poll of the token endpoint, at most once per interval.
 * Called too early it answers "pending" without touching the network, so a
 * browser polling faster than GitHub allows cannot cause a slow_down.
 */
export const stepDeviceFlow = async (
	state: DeviceFlowState,
	deps: { fetch: FetchLike; now: () => number; clientId?: string },
): Promise<StepResult> => {
	const now = deps.now();
	if (now >= state.expiresAt) return { status: "expired" };
	if (now < state.nextPollAt) {
		return {
			status: "pending",
			state,
			retryAfterSeconds: Math.ceil((state.nextPollAt - now) / 1000),
		};
	}

	const pendingAfter = (intervalSeconds: number): StepResult => ({
		status: "pending",
		state: {
			...state,
			intervalSeconds,
			nextPollAt: now + intervalSeconds * 1000,
		},
		retryAfterSeconds: intervalSeconds,
	});

	let response: Awaited<ReturnType<FetchLike>>;
	try {
		response = await deps.fetch(ACCESS_TOKEN_URL, {
			method: "POST",
			headers: GITHUB_HEADERS,
			body: formBody({
				client_id: deps.clientId ?? getDeviceClientId(),
				device_code: state.deviceCode,
				grant_type: DEVICE_GRANT_TYPE,
			}),
		});
	} catch {
		// A network blip is not the user's fault: keep waiting.
		return pendingAfter(state.intervalSeconds);
	}
	const body = asRecord(await response.json().catch(() => null));

	if (typeof body.access_token === "string" && body.access_token.length > 0) {
		return {
			status: "authorized",
			accessToken: body.access_token,
			scope: typeof body.scope === "string" ? body.scope : "",
		};
	}

	switch (body.error) {
		case "authorization_pending":
			return pendingAfter(state.intervalSeconds);
		case "slow_down": {
			const given =
				typeof body.interval === "number" ? Math.floor(body.interval) : 0;
			return pendingAfter(
				Math.max(given, state.intervalSeconds + SLOW_DOWN_STEP_SECONDS),
			);
		}
		case "expired_token":
			return { status: "expired" };
		case "access_denied":
			return { status: "denied" };
		case "device_flow_disabled":
			return {
				status: "failed",
				message: "Device flow is not enabled for the GitHub OAuth App",
			};
		case "incorrect_client_credentials":
		case "unsupported_grant_type":
		case "incorrect_device_code":
			return {
				status: "failed",
				message: `GitHub rejected the request (${String(body.error)})`,
			};
		default:
			return response.status >= 500
				? pendingAfter(state.intervalSeconds)
				: {
						status: "failed",
						message: `Unexpected answer from GitHub (HTTP ${response.status})`,
					};
	}
};
