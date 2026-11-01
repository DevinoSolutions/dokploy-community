import type { FetchLike } from "./device-flow";

/**
 * The few GitHub REST calls the pull flow makes, over an injected `fetch`.
 * Nothing here logs, throws with, or returns the token.
 */

export const GITHUB_API = "https://api.github.com";

const headers = (token: string, extra: Record<string, string> = {}) => ({
	Accept: "application/vnd.github+json",
	Authorization: `Bearer ${token}`,
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "dokploy-community",
	...extra,
});

export interface GithubDeployment {
	id: number;
	sha?: string;
	environment?: string;
	payload?: unknown;
	creator?: { login?: string } | null;
}

export type ListResult =
	| { kind: "not-modified" }
	| { kind: "ok"; deployments: GithubDeployment[]; etag: string | null }
	| { kind: "rate-limited"; retryAt: number }
	| { kind: "unauthorized" }
	| { kind: "forbidden"; message: string }
	| { kind: "not-found" }
	| { kind: "error"; status: number };

const num = (value: string | null): number | null => {
	if (value === null || value.trim() === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
};

/** Fallback wait when GitHub says "slow down" without telling us how long. */
export const DEFAULT_SECONDARY_BACKOFF_MS = 60_000;
/** Longest we ever sleep on a rate limit answer. */
export const MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * When may the next request go out, given a 403 or 429?
 * Returns the epoch ms, or null when the answer is not a rate limit at all
 * (a plain permission error), which the caller must not retry in a loop.
 */
export const rateLimitRetryAt = (
	status: number,
	h: { get(name: string): string | null },
	body: string,
	now: number,
): number | null => {
	if (status !== 403 && status !== 429) return null;
	const retryAfter = num(h.get("retry-after"));
	if (retryAfter !== null) {
		return now + Math.min(MAX_BACKOFF_MS, Math.max(1, retryAfter) * 1000);
	}
	const remaining = num(h.get("x-ratelimit-remaining"));
	const reset = num(h.get("x-ratelimit-reset"));
	if (remaining === 0 && reset !== null) {
		// +1s: the reset second itself is still inside the old window.
		return Math.min(
			now + MAX_BACKOFF_MS,
			Math.max(now + 1000, reset * 1000 + 1000),
		);
	}
	if (status === 429 || /rate limit|abuse/i.test(body)) {
		return now + DEFAULT_SECONDARY_BACKOFF_MS;
	}
	return null;
};

/**
 * `GET /repos/{owner}/{repo}/deployments?environment=&per_page=5` with
 * If-None-Match. A 304 does not count against the rate limit.
 */
export const listDeployments = async (
	deps: { fetch: FetchLike; now: () => number },
	args: {
		token: string;
		owner: string;
		repo: string;
		environment: string;
		etag?: string | null;
	},
): Promise<ListResult> => {
	const url =
		`${GITHUB_API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}` +
		`/deployments?environment=${encodeURIComponent(args.environment)}&per_page=5`;
	let response: Awaited<ReturnType<FetchLike>>;
	try {
		response = await deps.fetch(url, {
			method: "GET",
			headers: headers(
				args.token,
				args.etag ? { "If-None-Match": args.etag } : {},
			),
		});
	} catch {
		return { kind: "error", status: 0 };
	}
	if (response.status === 304) return { kind: "not-modified" };
	if (response.status === 401) return { kind: "unauthorized" };
	if (response.status === 404) return { kind: "not-found" };
	if (response.status === 403 || response.status === 429) {
		const body = await response.text().catch(() => "");
		const retryAt = rateLimitRetryAt(
			response.status,
			response.headers,
			body,
			deps.now(),
		);
		return retryAt !== null
			? { kind: "rate-limited", retryAt }
			: {
					kind: "forbidden",
					message: "GitHub refused access to this repository",
				};
	}
	if (!response.ok) return { kind: "error", status: response.status };
	const body = await response.json().catch(() => null);
	if (!Array.isArray(body)) return { kind: "error", status: response.status };
	const deployments = body.filter(
		(item): item is GithubDeployment =>
			item !== null &&
			typeof item === "object" &&
			Number.isSafeInteger((item as GithubDeployment).id),
	);
	return { kind: "ok", deployments, etag: response.headers.get("etag") };
};

export type DeploymentState = "in_progress" | "success" | "failure" | "error";

/** GitHub caps a status description at 140 characters. */
export const clampDescription = (text: string) =>
	text.length <= 140 ? text : `${text.slice(0, 137)}...`;

export type StatusResult =
	| { ok: true }
	| { ok: false; status: number; rateLimitedUntil?: number };

/** `POST /repos/{owner}/{repo}/deployments/{id}/statuses`. */
export const createDeploymentStatus = async (
	deps: { fetch: FetchLike; now: () => number },
	args: {
		token: string;
		owner: string;
		repo: string;
		deploymentId: number;
		state: DeploymentState;
		description: string;
		logUrl?: string;
	},
): Promise<StatusResult> => {
	const url = `${GITHUB_API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/deployments/${args.deploymentId}/statuses`;
	let response: Awaited<ReturnType<FetchLike>>;
	try {
		response = await deps.fetch(url, {
			method: "POST",
			headers: headers(args.token, { "Content-Type": "application/json" }),
			body: JSON.stringify({
				state: args.state,
				description: clampDescription(args.description),
				...(args.logUrl ? { log_url: args.logUrl } : {}),
			}),
		});
	} catch {
		return { ok: false, status: 0 };
	}
	if (response.status === 201 || response.status === 200) return { ok: true };
	const body = await response.text().catch(() => "");
	const retryAt = rateLimitRetryAt(
		response.status,
		response.headers,
		body,
		deps.now(),
	);
	return {
		ok: false,
		status: response.status,
		...(retryAt !== null ? { rateLimitedUntil: retryAt } : {}),
	};
};

/** `GET /user`: who the token belongs to, and the scopes GitHub granted it. */
export const fetchTokenOwner = async (
	deps: { fetch: FetchLike },
	token: string,
): Promise<
	| { ok: true; login: string; userId: string; scopes: string }
	| { ok: false; status: number }
> => {
	let response: Awaited<ReturnType<FetchLike>>;
	try {
		response = await deps.fetch(`${GITHUB_API}/user`, {
			method: "GET",
			headers: headers(token),
		});
	} catch {
		return { ok: false, status: 0 };
	}
	if (!response.ok) return { ok: false, status: response.status };
	const body = (await response.json().catch(() => null)) as {
		login?: unknown;
		id?: unknown;
	} | null;
	if (!body || typeof body.login !== "string" || typeof body.id !== "number") {
		return { ok: false, status: response.status };
	}
	const scopes = (response.headers.get("x-oauth-scopes") ?? "")
		.split(",")
		.map((scope) => scope.trim())
		.filter(Boolean)
		.join(",");
	return { ok: true, login: body.login, userId: String(body.id), scopes };
};
