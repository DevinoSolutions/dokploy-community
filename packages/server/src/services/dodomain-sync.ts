import { db } from "@dokploy/server/db";
import {
	type DnsVerificationStatus,
	dodomainConnectSession,
	dodomainIntegration,
	domains,
} from "@dokploy/server/db/schema";
import {
	DoDomainError,
	isDoDomainRateLimited,
} from "@dokploy/server/utils/dodomain/client";
import { reportUnexpectedError } from "@dokploy/server/utils/process/background";
import { TRPCError } from "@trpc/server";
import {
	and,
	eq,
	exists,
	gt,
	inArray,
	isNotNull,
	isNull,
	or,
} from "drizzle-orm";
import {
	assertSameOrganization,
	type DoDomainConnectSession,
	type DoDomainIntegration,
	type DoDomainServiceContext,
	dodomainClientFor,
	expireStaleDoDomainSessions,
	findDoDomainByOrganizationId,
	findLatestDoDomainSession,
	getDoDomainConnectionStatus,
	loadConnectableDomain,
	resolveDoDomainService,
} from "./dodomain";
import {
	applyDoDomainTransition,
	DODOMAIN_DISCONNECTED_REASON,
	type DoDomainTransition,
	doDomainConnectFailedReason,
	doDomainDriftReason,
} from "./dodomain-transition";
import type { Domain } from "./domain";

/**
 * Outbound status sync: the panel asks DoDomain what happened instead of
 * waiting for DoDomain to call it. This is the always-on status source;
 * webhooks (services/dodomain.ts) are an optional fast path for panels DoDomain
 * can reach. Both feed `applyDoDomainTransition`, which is idempotent, so the
 * two can run side by side without double notifications or regressions.
 *
 * `syncDoDomainDomain` handles one domain; `runDoDomainSyncCycle` is what the
 * cron jobs call. Nothing here logs or returns a session token or secret key.
 */

export const DODOMAIN_SYNC_FAST_CRON = "*/2 * * * *";
export const DODOMAIN_SYNC_SLOW_CRON = "7,37 * * * *";

export type DoDomainSyncOutcome =
	| "verified"
	| "failed"
	| "reset"
	| "linked"
	| "unchanged"
	| "waiting"
	| "rate_limited"
	| "skipped";

export type DoDomainSyncSkipReason =
	| "not_found"
	| "not_connectable"
	| "no_integration"
	| "not_tracked"
	| "no_live_session"
	| "backoff";

export interface DoDomainSyncResult {
	outcome: DoDomainSyncOutcome;
	reason?: DoDomainSyncSkipReason;
	/** Set with `rate_limited`: seconds until DoDomain should be asked again. */
	retryAfterSeconds?: number;
}

export interface DoDomainSyncOptions {
	/** Skip organizations that are backing off after a rate limit (cron use). */
	respectBackoff?: boolean;
	now?: () => number;
}

// ---------------------------------------------------------------------------
// Backoff (per integration, in memory)
// ---------------------------------------------------------------------------

const MIN_BACKOFF_SECONDS = 30;
const DEFAULT_BACKOFF_SECONDS = 120;
const MAX_BACKOFF_SECONDS = 15 * 60;
/** After a timeout, a refused connection or a 5xx: the instance is unhealthy. */
const UNREACHABLE_BACKOFF_SECONDS = 5 * 60;

const backoffUntil = new Map<string, number>();

const backoffSecondsFor = (error: DoDomainError) =>
	Math.min(
		MAX_BACKOFF_SECONDS,
		Math.max(
			MIN_BACKOFF_SECONDS,
			error.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS,
		),
	);

/**
 * Domains whose last cycle failed with an unexpected (non-DoDomain) error and
 * were already reported, so a persistent failure reaches Sentry once instead of
 * every cycle. Cleared per domain on its next successful sync.
 */
const reportedFailures = new Set<string>();

export const resetDoDomainSyncState = () => {
	backoffUntil.clear();
	reportedFailures.clear();
};

/** Network failure (status 0) or a 5xx: DoDomain, or this base URL, is down. */
const isUnreachable = (error: unknown) =>
	error instanceof DoDomainError && (error.status === 0 || error.status >= 500);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_TOKEN_PATTERN = /dd_sess_[A-Za-z0-9_-]+/;
const SESSION_TOKEN_EXACT = new RegExp(`^${SESSION_TOKEN_PATTERN.source}$`);

/**
 * The token to verify a session with. Sessions created after the token column
 * existed carry it, but a column that failed to decrypt (the encryption secret
 * changed) comes back as ciphertext, so it is only trusted when it looks like a
 * token. Otherwise the token is read from the connect URL: DoDomain's hosted
 * link is `/connect/<token>`, so it is there for every session, old or new.
 */
const sessionTokenOf = (session: DoDomainConnectSession) =>
	(session.token && SESSION_TOKEN_EXACT.test(session.token)
		? session.token
		: null) ||
	SESSION_TOKEN_PATTERN.exec(session.connectUrl)?.[0] ||
	null;

/** Short, secret-free description of a failure for logs. */
export const describeDoDomainSyncError = (error: unknown) =>
	error instanceof DoDomainError
		? `DoDomainError (HTTP ${error.status})`
		: error instanceof Error
			? error.name
			: typeof error;

interface SyncContext {
	integration: DoDomainIntegration;
	client: ReturnType<typeof dodomainClientFor>;
	service: DoDomainServiceContext;
	domain: Domain;
	/** What the transition's compare-and-set expects the row to still hold. */
	expectedStatus: DnsVerificationStatus | null;
}

const transitionOutcome = async (
	ctx: SyncContext,
	transition: DoDomainTransition,
	outcome: DoDomainSyncOutcome,
): Promise<DoDomainSyncResult> => {
	const result = await applyDoDomainTransition({
		service: ctx.service,
		domain: ctx.domain,
		transition,
		options: { expectedStatus: ctx.expectedStatus },
	});
	return { outcome: result.applied ? outcome : "unchanged" };
};

/** A 404 means DoDomain does not know it (or it belongs to another app). */
const orNull = async <T>(request: Promise<T>): Promise<T | null> => {
	try {
		return await request;
	} catch (error) {
		if (error instanceof DoDomainError && error.status === 404) return null;
		throw error;
	}
};

// ---------------------------------------------------------------------------
// Connection health (verified / failed domains, and pending ones with a connection)
// ---------------------------------------------------------------------------

const syncFromConnection = async (
	ctx: SyncContext,
	connectionId: string,
): Promise<DoDomainSyncResult> => {
	const { domain } = ctx;
	const connection = await orNull(ctx.client.connections.get(connectionId));
	if (!connection) return { outcome: "unchanged" };
	const status = domain.dnsVerificationStatus ?? null;

	if (connection.disconnectedAt) {
		if (status === "failed" && !domain.dodomainConnectionId) {
			return { outcome: "unchanged" };
		}
		return transitionOutcome(
			ctx,
			{
				kind: "failed",
				reason: DODOMAIN_DISCONNECTED_REASON,
				connectionId: connection.id,
				dropConnection: true,
			},
			"failed",
		);
	}
	if (connection.status === "broken") {
		if (status === "failed") return { outcome: "unchanged" };
		return transitionOutcome(
			ctx,
			{
				kind: "failed",
				reason: doDomainDriftReason(domain.host),
				connectionId: connection.id,
			},
			"failed",
		);
	}
	// Active. A connection that has not verified yet (no `verifiedAt`) leaves a
	// pending domain waiting; it never downgrades a verified one.
	if (!connection.verifiedAt && status !== "verified") {
		if (domain.dodomainConnectionId === connection.id) {
			return { outcome: "waiting" };
		}
		return transitionOutcome(
			ctx,
			{ kind: "linked", connectionId: connection.id },
			"linked",
		);
	}
	if (status === "verified" && domain.dodomainConnectionId === connection.id) {
		return { outcome: "unchanged" };
	}
	return transitionOutcome(
		ctx,
		{
			kind: "verified",
			connectionId: connection.id,
			verifiedAt: connection.verifiedAt
				? new Date(connection.verifiedAt)
				: undefined,
		},
		"verified",
	);
};

// ---------------------------------------------------------------------------
// Connect sessions (pending domains, and failed ones still holding a live session)
// ---------------------------------------------------------------------------

/** Treats the session as expired even if the local clock disagrees. */
const forceExpireSession = async (sessionId: string) => {
	await db
		.update(dodomainConnectSession)
		.set({ expiresAt: new Date() })
		.where(eq(dodomainConnectSession.sessionId, sessionId));
};

const resetExpiredSession = async (
	ctx: SyncContext,
): Promise<DoDomainSyncResult> => {
	const reset = await expireStaleDoDomainSessions([ctx.domain.domainId]);
	return { outcome: reset.length > 0 ? "reset" : "unchanged" };
};

const syncFromSession = async (
	ctx: SyncContext,
	canReset: boolean,
): Promise<DoDomainSyncResult> => {
	const { domain, client } = ctx;

	// A connection id is already known (session.completed, or an earlier tick):
	// the connection is authoritative.
	if (domain.dodomainConnectionId) {
		const result = await syncFromConnection(ctx, domain.dodomainConnectionId);
		if (result.outcome !== "waiting") return result;
	}

	const sessionId = domain.dodomainSessionId;
	const latest = sessionId
		? await findLatestDoDomainSession(domain.domainId)
		: null;
	const session = latest && latest.sessionId === sessionId ? latest : null;
	const locallyExpired = !session || session.expiresAt.getTime() <= Date.now();
	if (!sessionId || (locallyExpired && !canReset)) {
		return { outcome: "skipped", reason: "no_live_session" };
	}

	// By ID with the secret key: reports the connection once it exists and
	// whether the session expired. Works for sessions created before tokens
	// were stored.
	const state = await orNull(client.sessions.get(sessionId));
	if (state?.connectionId) {
		return syncFromConnection(ctx, state.connectionId);
	}
	if (state && (state.expired || state.status === "expired")) {
		if (!canReset) return { outcome: "skipped", reason: "no_live_session" };
		await forceExpireSession(sessionId);
		return resetExpiredSession(ctx);
	}
	if (locallyExpired) {
		return canReset ? resetExpiredSession(ctx) : { outcome: "unchanged" };
	}
	if (state?.status === "failed") {
		if (!canReset) return { outcome: "waiting" };
		return transitionOutcome(
			ctx,
			{
				kind: "failed",
				reason: doDomainConnectFailedReason("the connect flow"),
			},
			"failed",
		);
	}

	// Live and unfinished: ask DoDomain to run the DNS check now (what the
	// hosted page does while its owner waits), then see whether it finalized.
	const token = session ? sessionTokenOf(session) : null;
	if (token) {
		try {
			const verification = await client.sessions.verify(token);
			if (!verification.verified) return { outcome: "waiting" };
		} catch (error) {
			if (error instanceof DoDomainError && error.status === 410) {
				if (!canReset) return { outcome: "unchanged" };
				await forceExpireSession(sessionId);
				return resetExpiredSession(ctx);
			}
			// 404: DoDomain does not know this token; map the session through the
			// listing instead.
			if (error instanceof DoDomainError && error.status === 404) {
				return syncFromListing(ctx, sessionId);
			}
			throw error;
		}
		const finalized = await orNull(client.sessions.get(sessionId));
		if (finalized?.connectionId) {
			return syncFromConnection(ctx, finalized.connectionId);
		}
		return { outcome: "waiting" };
	}

	// No token (a stored one that no longer decrypts and a URL that does not
	// carry one): the listing maps the session to its connection without one.
	return syncFromListing(ctx, sessionId);
};

/**
 * The connection list is keyed by session, so the connection of this very
 * session is found without a token (and without trusting the hostname alone).
 */
const syncFromListing = async (
	ctx: SyncContext,
	sessionId: string,
): Promise<DoDomainSyncResult> => {
	const { connections } = await ctx.client.connections.list({
		appId: ctx.integration.appId,
		domain: ctx.domain.host.toLowerCase(),
		limit: 100,
	});
	const match = connections.find(
		(connection) =>
			connection.sessionId === sessionId && !connection.disconnectedAt,
	);
	return match ? syncFromConnection(ctx, match.id) : { outcome: "waiting" };
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Brings one domain's verification state in line with what DoDomain reports.
 *
 * - pending: look for the connection (known id, the session by ID, the listing)
 *   and run the live DNS check with the stored session token; an expired
 *   session resets the domain exactly like the expired-session sweep does.
 * - verified / failed with a connection: read the connection; active keeps or
 *   restores `verified`, broken or disconnected becomes `failed`.
 *
 * Every state change goes through `applyDoDomainTransition`, the same function
 * the webhook receiver uses. Domains of other organizations are never mixed up:
 * the integration used is the one of the domain's own organization.
 */
export const syncDoDomainDomain = async (
	domainId: string,
	options: DoDomainSyncOptions = {},
): Promise<DoDomainSyncResult> => {
	const now = options.now ?? Date.now;
	const domain = await db.query.domains.findFirst({
		where: eq(domains.domainId, domainId),
	});
	if (!domain) return { outcome: "skipped", reason: "not_found" };
	const service = await resolveDoDomainService(domain);
	if (!service) return { outcome: "skipped", reason: "not_connectable" };
	const integration = await findDoDomainByOrganizationId(
		service.organizationId,
	);
	if (!integration) return { outcome: "skipped", reason: "no_integration" };

	if (
		options.respectBackoff &&
		(backoffUntil.get(integration.dodomainId) ?? 0) > now()
	) {
		return { outcome: "skipped", reason: "backoff" };
	}

	const status = domain.dnsVerificationStatus ?? null;
	const ctx: SyncContext = {
		integration,
		client: dodomainClientFor(integration),
		service,
		domain,
		expectedStatus: status,
	};
	try {
		if (status === "pending") return await syncFromSession(ctx, true);
		if (status === "verified" || status === "failed") {
			if (domain.dodomainConnectionId) {
				return await syncFromConnection(ctx, domain.dodomainConnectionId);
			}
			// A failed connect attempt whose link is still open can still succeed.
			return status === "failed" && domain.dodomainSessionId
				? await syncFromSession(ctx, false)
				: { outcome: "skipped", reason: "not_tracked" };
		}
		return { outcome: "skipped", reason: "not_tracked" };
	} catch (error) {
		if (isDoDomainRateLimited(error)) {
			const seconds = backoffSecondsFor(error as DoDomainError);
			backoffUntil.set(integration.dodomainId, now() + seconds * 1000);
			return { outcome: "rate_limited", retryAfterSeconds: seconds };
		}
		// A dead or erroring instance (for example a custom base URL that times
		// out) would otherwise cost every cycle one slow failure per domain, so
		// the cron leaves this organization alone for a while.
		if (options.respectBackoff && isUnreachable(error)) {
			backoffUntil.set(
				integration.dodomainId,
				now() + UNREACHABLE_BACKOFF_SECONDS * 1000,
			);
		}
		throw error;
	}
};

export const DODOMAIN_RECHECK_RATE_LIMITED_MESSAGE =
	"DoDomain checked this domain less than 10 minutes ago. Try again later.";

/**
 * "Check now": asks DoDomain for a fresh DNS check of an existing connection
 * (it runs asynchronously and answers 429 within 10 minutes of the last one),
 * syncs the domain right away and returns the status as it now stands, so the
 * UI does not wait for a webhook. A 429 on the recheck is not fatal: the
 * connection was just checked, so the synced status is already current.
 */
export const reverifyDoDomainDomain = async (params: {
	integration: DoDomainIntegration;
	domainId: string;
}) => {
	const { domain, service } = await loadConnectableDomain(params.domainId);
	assertSameOrganization(params.integration, service);
	if (!domain.dodomainConnectionId && !domain.dodomainSessionId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"This domain has no DoDomain connection yet. Send a connect link and let the domain owner finish it first.",
		});
	}

	// Sync first: it learns whether the connection is still there. A
	// disconnected one is dropped by the sync, and DoDomain refuses to recheck it.
	let sync: DoDomainSyncResult;
	try {
		sync = await syncDoDomainDomain(domain.domainId);
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				error instanceof Error ? error.message : "Error checking with DoDomain",
			cause: error,
		});
	}
	if (sync.outcome === "rate_limited") {
		throw new TRPCError({
			code: "TOO_MANY_REQUESTS",
			message: DODOMAIN_RECHECK_RATE_LIMITED_MESSAGE,
		});
	}

	// Only a connection that existed and survived the sync is rechecked; one
	// that was just verified by the sync was checked a moment ago.
	let recheck: "requested" | "rate_limited" | "not_needed" = "not_needed";
	const connectionId = domain.dodomainConnectionId
		? (await loadConnectableDomain(domain.domainId)).domain.dodomainConnectionId
		: null;
	if (connectionId) {
		try {
			await dodomainClientFor(params.integration).connections.reverify(
				connectionId,
			);
			recheck = "requested";
		} catch (error) {
			if (isDoDomainRateLimited(error)) {
				recheck = "rate_limited";
			} else if (
				!(
					error instanceof DoDomainError &&
					(error.status === 404 || error.status === 410)
				)
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Error requesting a DoDomain recheck",
					cause: error,
				});
			}
		}
	}

	return {
		...(await getDoDomainConnectionStatus({
			integration: params.integration,
			domainId: domain.domainId,
		})),
		recheck,
		sync: sync.outcome,
		message:
			recheck === "rate_limited" ? DODOMAIN_RECHECK_RATE_LIMITED_MESSAGE : null,
	};
};

// ---------------------------------------------------------------------------
// Background cycle
// ---------------------------------------------------------------------------

export type DoDomainSyncCycleKind = "fast" | "slow";

/**
 * Which domains a cycle looks at.
 * - fast (every ~2 minutes): pending domains, plus failed ones whose connect
 *   link is still open (the owner can retry from the same link).
 * - slow (every ~30 minutes): domains with a connection, verified or failed,
 *   so a broken connection is noticed and a repaired one is restored.
 */
export const findDoDomainSyncCandidates = async (
	kind: DoDomainSyncCycleKind,
): Promise<string[]> => {
	const condition =
		kind === "fast"
			? or(
					eq(domains.dnsVerificationStatus, "pending"),
					and(
						eq(domains.dnsVerificationStatus, "failed"),
						isNull(domains.dodomainConnectionId),
						exists(
							db
								.select({ live: dodomainConnectSession.sessionId })
								.from(dodomainConnectSession)
								.where(
									and(
										eq(
											dodomainConnectSession.sessionId,
											domains.dodomainSessionId,
										),
										gt(dodomainConnectSession.expiresAt, new Date()),
									),
								),
						),
					),
				)
			: and(
					inArray(domains.dnsVerificationStatus, ["verified", "failed"]),
					isNotNull(domains.dodomainConnectionId),
				);
	const rows = await db
		.select({ domainId: domains.domainId })
		.from(domains)
		.where(condition);
	return rows.map((row) => row.domainId);
};

export interface DoDomainSyncCycleSummary {
	checked: number;
	changed: number;
	skipped: number;
	rateLimited: number;
	failed: number;
}

/**
 * One pass of the background sync. Domains are synced one at a time, a failure
 * of one never stops the others, and an organization that hit a rate limit is
 * left alone until its backoff passes. Logs carry domain ids and error classes
 * only.
 */
export const runDoDomainSyncCycle = async (
	kind: DoDomainSyncCycleKind,
	options: Pick<DoDomainSyncOptions, "now"> = {},
): Promise<DoDomainSyncCycleSummary> => {
	const summary: DoDomainSyncCycleSummary = {
		checked: 0,
		changed: 0,
		skipped: 0,
		rateLimited: 0,
		failed: 0,
	};
	// No DoDomain integration anywhere: nothing to ask, nothing to load.
	const anyIntegration = await db
		.select({ id: dodomainIntegration.dodomainId })
		.from(dodomainIntegration)
		.limit(1);
	if (anyIntegration.length === 0) return summary;

	for (const domainId of await findDoDomainSyncCandidates(kind)) {
		try {
			const result = await syncDoDomainDomain(domainId, {
				respectBackoff: true,
				now: options.now,
			});
			if (result.outcome === "skipped") {
				summary.skipped += 1;
				continue;
			}
			summary.checked += 1;
			if (result.outcome === "rate_limited") {
				summary.rateLimited += 1;
				console.warn(
					`[dodomain] rate limited; pausing this organization for ${result.retryAfterSeconds}s`,
				);
			} else if (
				["verified", "failed", "reset", "linked"].includes(result.outcome)
			) {
				summary.changed += 1;
			}
			reportedFailures.delete(domainId);
		} catch (error) {
			summary.failed += 1;
			console.error(
				`[dodomain] sync failed for domain ${domainId}: ${describeDoDomainSyncError(error)}`,
			);
			// Once per domain until it succeeds again: a persistent failure (for
			// example Traefik rejecting the config) would repeat every 2 minutes.
			if (
				!(error instanceof DoDomainError) &&
				!reportedFailures.has(domainId)
			) {
				reportedFailures.add(domainId);
				reportUnexpectedError(error, { handler: "dodomainSync" });
			}
		}
	}
	return summary;
};
