import { db } from "@dokploy/server/db";
import { type DnsVerificationStatus, domains } from "@dokploy/server/db/schema";
import { sendDomainVerificationFailedNotifications } from "@dokploy/server/utils/notifications/domain-verification";
import { manageDomain } from "@dokploy/server/utils/traefik/domain";
import { and, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import { getDokployUrl } from "./admin";
import type { DoDomainServiceContext } from "./dodomain";
import type { Domain } from "./domain";

/**
 * The ONE place a DoDomain verification state change is applied. The webhook
 * receiver and the outbound poller both describe what they learned as a
 * {@link DoDomainTransition} and hand it here, so the two sources can never
 * disagree about what a change does (status, connection id, Traefik re-apply,
 * the failure notification).
 *
 * Idempotency lives in SQL: every transition is a single conditional UPDATE
 * (`... WHERE status IS DISTINCT FROM <target>`) and its side effects run only
 * when that UPDATE changed a row. A webhook and a poll reporting the same event
 * race on the same row; exactly one of them changes it, the other sees zero
 * rows and does nothing, so the notification fires once and a late duplicate
 * can never regress a newer state. The poller additionally passes
 * `expectedStatus` (compare-and-set): a verdict it computed from a read that is
 * seconds old is dropped when a webhook has moved the domain in the meantime.
 */
export type DoDomainTransition =
	| { kind: "verified"; connectionId?: string | null; verifiedAt?: Date }
	| {
			kind: "failed";
			/** Human-readable cause, used only in the notification. */
			reason: string;
			connectionId?: string | null;
			/** The connection is gone (disconnected): forget its id. */
			dropConnection?: boolean;
	  }
	| { kind: "linked"; connectionId: string }
	| { kind: "abandoned"; sessionId: string };

export interface DoDomainTransitionOptions {
	/**
	 * Apply only while the domain still has this verification status (`null`
	 * meaning never used). Set by the poller; webhooks are authoritative events
	 * and rely on the idempotency guard alone.
	 */
	expectedStatus?: DnsVerificationStatus | null;
}

export type DoDomainTransitionResult =
	| { applied: true; domain: Domain }
	| { applied: false; reason: "unchanged" | "stale_session" };

export const DODOMAIN_DISCONNECTED_REASON =
	"The DoDomain connection was disconnected; DoDomain no longer monitors this domain's DNS.";

export const doDomainDriftReason = (what: string) =>
	`The DNS records for ${what} no longer match what Dokploy expects (DNS drift).`;

export const doDomainConnectFailedReason = (
	step: string,
	error?: string | null,
) =>
	`The domain owner's connect attempt failed at ${step}${
		error ? `: ${error}` : "."
	} They can retry from the same connect link.`;

const statusIsNot = (target: DnsVerificationStatus) =>
	sql`${domains.dnsVerificationStatus} IS DISTINCT FROM ${target}`;

const statusIs = (expected: DnsVerificationStatus | null) =>
	sql`${domains.dnsVerificationStatus} IS NOT DISTINCT FROM ${expected}`;

const connectionIsNot = (connectionId: string) =>
	sql`${domains.dodomainConnectionId} IS DISTINCT FROM ${connectionId}`;

const updateDomainWhere = (
	domainId: string,
	values: Partial<typeof domains.$inferInsert>,
	...guards: (SQL | undefined)[]
) =>
	db
		.update(domains)
		.set(values)
		.where(and(eq(domains.domainId, domainId), ...guards))
		.returning();

export const domainsLink = async (service: DoDomainServiceContext) =>
	`${await getDokployUrl()}/dashboard/project/${service.projectId}/environment/${service.environmentId}/services/${service.kind}/${service.serviceId}?tab=domains`;

/** Re-applies a verified domain the same way saving it does. */
const applyVerifiedDomain = async (
	service: DoDomainServiceContext,
	domain: Domain,
) => {
	// Applications route through Traefik's file provider: rewriting the router
	// (with its certResolver when https) makes Traefik request the certificate
	// now that DNS points here. Compose domains are docker labels and only
	// change on the next deploy.
	if (service.kind === "application" && service.application) {
		await manageDomain(service.application, domain);
	}
};

export const applyDoDomainTransition = async (params: {
	service: DoDomainServiceContext;
	/** The row as the caller read it; only `host` and the pre-image are used. */
	domain: Domain;
	transition: DoDomainTransition;
	options?: DoDomainTransitionOptions;
}): Promise<DoDomainTransitionResult> => {
	const { service, domain, transition, options } = params;
	const expected =
		options && "expectedStatus" in options
			? statusIs(options.expectedStatus ?? null)
			: undefined;
	const unchanged = { applied: false, reason: "unchanged" } as const;

	switch (transition.kind) {
		case "verified": {
			const [updated] = await updateDomainWhere(
				domain.domainId,
				{
					dnsVerificationStatus: "verified",
					dnsVerifiedAt: transition.verifiedAt ?? new Date(),
					...(transition.connectionId
						? { dodomainConnectionId: transition.connectionId }
						: {}),
				},
				statusIsNot("verified"),
				expected,
			);
			if (!updated) {
				// Already verified (the other source got there first). A webhook
				// may still carry a newer connection id (the owner reconnected).
				if (transition.connectionId && !expected) {
					await updateDomainWhere(
						domain.domainId,
						{ dodomainConnectionId: transition.connectionId },
						eq(domains.dnsVerificationStatus, "verified"),
						connectionIsNot(transition.connectionId),
					);
				}
				return unchanged;
			}
			try {
				await applyVerifiedDomain(service, { ...domain, ...updated });
			} catch (error) {
				// Not applied: put the previous state back so the next delivery or
				// poll runs the whole transition again instead of seeing it done.
				await updateDomainWhere(
					domain.domainId,
					{
						dnsVerificationStatus: domain.dnsVerificationStatus ?? null,
						dnsVerifiedAt: domain.dnsVerifiedAt ?? null,
						dodomainConnectionId: domain.dodomainConnectionId ?? null,
					},
					eq(domains.dnsVerificationStatus, "verified"),
				).catch(() => {});
				throw error;
			}
			return { applied: true, domain: { ...domain, ...updated } };
		}
		case "failed": {
			const [updated] = await updateDomainWhere(
				domain.domainId,
				{
					dnsVerificationStatus: "failed",
					...(transition.dropConnection
						? { dodomainConnectionId: null }
						: transition.connectionId
							? { dodomainConnectionId: transition.connectionId }
							: {}),
				},
				statusIsNot("failed"),
				expected,
			);
			if (!updated) {
				// Already failed. Neither follow-up is a status change, so both are
				// safe for the poller too (they guard on the row, not on a read):
				// - a disconnect still has to forget the dead connection, or the slow
				//   poll would ask DoDomain about it forever;
				// - a webhook may carry a newer connection id than the stored one.
				if (transition.dropConnection) {
					await updateDomainWhere(
						domain.domainId,
						{ dodomainConnectionId: null },
						eq(domains.dnsVerificationStatus, "failed"),
						// Only the connection that was disconnected, never a newer one.
						transition.connectionId
							? eq(domains.dodomainConnectionId, transition.connectionId)
							: isNotNull(domains.dodomainConnectionId),
					);
				} else if (transition.connectionId && !expected) {
					await updateDomainWhere(
						domain.domainId,
						{ dodomainConnectionId: transition.connectionId },
						eq(domains.dnsVerificationStatus, "failed"),
						connectionIsNot(transition.connectionId),
					);
				}
				return unchanged;
			}
			await sendDomainVerificationFailedNotifications({
				organizationId: service.organizationId,
				projectName: service.projectName,
				serviceName: service.serviceName,
				host: domain.host,
				reason: transition.reason,
				domainLink: await domainsLink(service),
			}).catch((error) => {
				console.error("[dodomain] failure notification error:", error);
			});
			return { applied: true, domain: { ...domain, ...updated } };
		}
		case "linked": {
			const [updated] = await updateDomainWhere(
				domain.domainId,
				{ dodomainConnectionId: transition.connectionId },
				connectionIsNot(transition.connectionId),
				expected,
			);
			return updated
				? { applied: true, domain: { ...domain, ...updated } }
				: unchanged;
		}
		case "abandoned": {
			// Strict: only the domain still carrying THIS session is reset, so a
			// stale event cannot clear a newer session.
			if (domain.dodomainSessionId !== transition.sessionId) {
				return { applied: false, reason: "stale_session" };
			}
			const [updated] = await updateDomainWhere(
				domain.domainId,
				{
					dodomainSessionId: null,
					...(domain.dnsVerificationStatus === "pending"
						? { dnsVerificationStatus: "unverified" as const }
						: {}),
				},
				eq(domains.dodomainSessionId, transition.sessionId),
				expected,
			);
			return updated
				? { applied: true, domain: { ...domain, ...updated } }
				: { applied: false, reason: "stale_session" };
		}
	}
};
