/**
 * Minimal DoDomain REST client + webhook signature verification.
 *
 * DoDomain publishes `@dodomain/node`, but the fork keeps integrations
 * dependency-free (no lockfile churn across parallel integration branches), so
 * this is a small typed fetch wrapper over the same endpoints. Shapes and
 * behaviour follow the DoDomain sources:
 *
 * - `packages/node/src/index.ts` (`DoDomain` class): bearer `dd_sk_…` auth,
 *   `POST /api/v1/domains/check`, `POST /api/v1/sessions`,
 *   `GET /api/v1/apps`, `GET|POST /api/v1/webhook-endpoints`,
 *   `PATCH|DELETE /api/v1/webhook-endpoints/:id`,
 *   `POST /api/v1/webhook-endpoints/:id/rotate-secret`,
 *   `GET /api/v1/connections/:id`, `POST /api/v1/connections/:id/reverify`.
 * - `packages/node/src/public-types.ts`: request/response types.
 * - `packages/core/src/webhook.ts`: `verifyWebhook` (Stripe-style
 *   `t=<unixMs>,v1=<hex hmac of "${t}.${body}">`, 5 minute tolerance), copied
 *   below as `verifyDoDomainSignature`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DoDomainRecord } from "@dokploy/server/db/schema";

export const DODOMAIN_REQUEST_TIMEOUT_MS = 15_000;
export const DODOMAIN_SIGNATURE_HEADER = "x-dodomain-signature";
export const DODOMAIN_DELIVERY_ID_HEADER = "x-dodomain-delivery-id";
/** Replay window of a signature timestamp (DoDomain's own default). */
export const DODOMAIN_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export class DoDomainError extends Error {
	/** HTTP status; 0 when no request was sent. */
	readonly status: number;
	readonly body: unknown;

	constructor(message: string, status: number, body: unknown = null) {
		super(message);
		this.name = "DoDomainError";
		this.status = status;
		this.body = body;
	}
}

export interface DoDomainCheckResult {
	domain: string;
	/** The zone that owns the records (registrable apex or delegated subzone). */
	zone: string;
	provider: string;
	label: string;
	/** 1 = Cloudflare one-click, 2 = Domain Connect, 3 = guided manual. */
	tier: 1 | 2 | 3;
	method: "oauth" | "domain-connect" | "guided";
	confidence: "high" | "medium" | "low";
	nameServers: string[];
	domainConnect: {
		discovered: boolean;
		providerId?: string;
		providerName?: string;
	};
	guide: {
		provider: string;
		label: string;
		dashboardUrl?: string;
		hostFormat: string;
		apexToken: string;
		steps: string[];
		notes?: string[];
	};
}

export interface DoDomainSession {
	id: string;
	token: string;
	expiresAt: string;
	connectUrl: string;
	records: { type: string; host: string; fqdn: string }[];
	warnings?: { code: string; message: string; host: string; fqdn: string }[];
}

export interface DoDomainApp {
	id: string;
	name: string;
	publicKey: string;
	sandbox: boolean;
}

export interface DoDomainWebhookEndpoint {
	id: string;
	appId: string;
	url: string;
	createdAt: string;
}

export interface DoDomainWebhookEndpointWithSecret
	extends DoDomainWebhookEndpoint {
	/** `whsec_…`, returned once. */
	secret: string;
}

export interface DoDomainConnection {
	id: string;
	appId: string;
	sessionId: string;
	domain: string;
	recordFqdns: string[];
	status: "active" | "broken";
	verifiedAt: string | null;
	lastCheckedAt: string | null;
	brokenAt: string | null;
	disconnectedAt: string | null;
	createdAt: string;
}

export interface DoDomainClientOptions {
	secretKey: string;
	baseUrl: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

/** Percent-encodes one path segment and refuses a blank id (SDK behaviour). */
const segment = (field: string, value: string) => {
	if (typeof value !== "string" || value.trim() === "") {
		throw new DoDomainError(`A non-empty ${field} is required`, 0);
	}
	return encodeURIComponent(value);
};

export const createDoDomainClient = (options: DoDomainClientOptions) => {
	if (!options.secretKey?.startsWith("dd_sk_")) {
		throw new DoDomainError("A DoDomain secret key (dd_sk_…) is required", 0);
	}
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const timeoutMs = options.timeoutMs ?? DODOMAIN_REQUEST_TIMEOUT_MS;

	const request = async <T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> => {
		const fetchImpl = options.fetchImpl ?? fetch;
		let response: Response;
		try {
			response = await fetchImpl(`${baseUrl}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${options.secretKey}`,
					"content-type": "application/json",
					accept: "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			throw new DoDomainError(
				`Could not reach DoDomain at ${baseUrl}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				0,
			);
		}
		const text = await response.text();
		let json: unknown = {};
		if (text) {
			try {
				json = JSON.parse(text);
			} catch {
				throw new DoDomainError(
					`DoDomain returned a non-JSON response (HTTP ${response.status})`,
					response.status,
				);
			}
		}
		if (!response.ok) {
			const errorBody = json as { error?: string; message?: string };
			const detail = errorBody.message || errorBody.error;
			throw new DoDomainError(
				response.status === 401
					? "DoDomain rejected the secret key"
					: detail
						? `DoDomain: ${detail}`
						: `DoDomain request failed (HTTP ${response.status})`,
				response.status,
				json,
			);
		}
		return json as T;
	};

	return {
		apps: {
			list: () => request<{ apps: DoDomainApp[] }>("GET", "/api/v1/apps"),
		},
		domains: {
			check: (domain: string) =>
				request<DoDomainCheckResult>("POST", "/api/v1/domains/check", {
					domain,
				}),
		},
		sessions: {
			create: (input: {
				domain: string;
				records: DoDomainRecord[];
				returnUrl?: string;
			}) => request<DoDomainSession>("POST", "/api/v1/sessions", input),
		},
		connections: {
			get: (connectionId: string) =>
				request<DoDomainConnection>(
					"GET",
					`/api/v1/connections/${segment("connection id", connectionId)}`,
				),
			reverify: (connectionId: string) =>
				request<{ accepted: true }>(
					"POST",
					`/api/v1/connections/${segment("connection id", connectionId)}/reverify`,
				),
		},
		webhookEndpoints: {
			list: () =>
				request<{ endpoints: DoDomainWebhookEndpoint[] }>(
					"GET",
					"/api/v1/webhook-endpoints",
				),
			create: (url: string) =>
				request<DoDomainWebhookEndpointWithSecret>(
					"POST",
					"/api/v1/webhook-endpoints",
					{ url },
				),
			update: (endpointId: string, url: string) =>
				request<DoDomainWebhookEndpoint>(
					"PATCH",
					`/api/v1/webhook-endpoints/${segment("webhook endpoint id", endpointId)}`,
					{ url },
				),
			delete: (endpointId: string) =>
				request<{ id: string; deleted: true }>(
					"DELETE",
					`/api/v1/webhook-endpoints/${segment("webhook endpoint id", endpointId)}`,
				),
			rotateSecret: (endpointId: string) =>
				request<DoDomainWebhookEndpointWithSecret>(
					"POST",
					`/api/v1/webhook-endpoints/${segment("webhook endpoint id", endpointId)}/rotate-secret`,
				),
		},
	};
};

export type DoDomainClient = ReturnType<typeof createDoDomainClient>;

/**
 * Verifies a DoDomain webhook signature over the RAW request body.
 *
 * Header format: `t=<unixMs>,v1=<64 lowercase hex>` where v1 is
 * HMAC-SHA256(secret, `${t}.${rawBody}`). Copied from DoDomain's
 * `packages/core/src/webhook.ts` (`verifyWebhook`): the timestamp bounds
 * replays, the v1 value is shape-gated before any buffer is built (so a
 * multi-byte or odd-length value is a failed verification, never a thrown
 * RangeError), and the digests are compared with `timingSafeEqual`.
 */
export const verifyDoDomainSignature = (
	secret: string,
	rawBody: string,
	header: string | null | undefined,
	toleranceMs = DODOMAIN_SIGNATURE_TOLERANCE_MS,
	nowMs = Date.now(),
): boolean => {
	if (!secret || !header) return false;
	const parts: Record<string, string> = {};
	for (const pair of header.split(",")) {
		const index = pair.indexOf("=");
		if (index === -1) continue;
		parts[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
	}
	const timestamp = Number(parts.t);
	if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
	if (Math.abs(nowMs - timestamp) > toleranceMs) return false;
	const received = parts.v1 ?? "";
	if (!/^[0-9a-f]{64}$/.test(received)) return false;
	const expected = createHmac("sha256", secret)
		.update(`${timestamp}.${rawBody}`)
		.digest("hex");
	return timingSafeEqual(
		Buffer.from(received, "hex"),
		Buffer.from(expected, "hex"),
	);
};

/** Produces a signature header the way DoDomain does (tests + tooling). */
export const signDoDomainPayload = (
	secret: string,
	rawBody: string,
	timestampMs = Date.now(),
) =>
	`t=${timestampMs},v1=${createHmac("sha256", secret)
		.update(`${timestampMs}.${rawBody}`)
		.digest("hex")}`;
