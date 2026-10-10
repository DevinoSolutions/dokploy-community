import { db } from "@dokploy/server/db";
import {
	notifications,
	type UptimelyServiceType,
	uptimelyChannelIncident,
	uptimelyMonitorLink,
} from "@dokploy/server/db/schema";
import {
	createUptimelyClient,
	type UptimelyClient,
	UptimelyError,
} from "@dokploy/server/utils/uptimely/client";
import { pingUptimelyHeartbeat } from "@dokploy/server/utils/uptimely/heartbeat";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";

/**
 * Deploy-time Uptimely hooks: the heartbeat ping and the incident channel.
 *
 * Everything exported here as `report*` is called from the build
 * success/failure notification senders, after the deployment has already been
 * settled. They are fire-and-forget by contract: they never throw, and callers
 * do not await them, so a slow or broken Uptimely can neither fail nor delay a
 * deploy. This file deliberately imports no other service, because the
 * notification senders it is called from are themselves imported by the
 * application and compose services.
 */

export type UptimelyDeployServiceType = "application" | "compose";

export interface UptimelyDeployContext {
	organizationId: string;
	serviceType: UptimelyDeployServiceType;
	serviceId: string;
	projectName: string;
	serviceName: string;
}

export const uptimelyServiceKey = (
	serviceType: UptimelyServiceType,
	serviceId: string,
) => `${serviceType}:${serviceId}`;

const incidentTitle = ({ projectName, serviceName }: UptimelyDeployContext) =>
	`Deploy failed: ${projectName}/${serviceName}`;

const INCIDENT_DESCRIPTION_MAX_LENGTH = 800;

const describeFailure = (errorMessage: string, buildLink: string) => {
	// The end of a build log holds the actual error.
	const trimmed = errorMessage.trim();
	const excerpt =
		trimmed.length > INCIDENT_DESCRIPTION_MAX_LENGTH
			? `...${trimmed.slice(-INCIDENT_DESCRIPTION_MAX_LENGTH)}`
			: trimmed;
	return [
		"Declared by Dokploy because a deployment failed. It resolves automatically when the next deployment of this service succeeds.",
		excerpt && `Error:\n${excerpt}`,
		buildLink && `Deployment: ${buildLink}`,
	]
		.filter(Boolean)
		.join("\n\n");
};

const clientFor = (channel: {
	apiKey: string;
	baseUrl: string;
}): UptimelyClient =>
	createUptimelyClient({ apiKey: channel.apiKey, baseUrl: channel.baseUrl });

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Pings the deploy heartbeat of a service, if one is linked and its secret
 * key is known. Resolves to whether a ping was accepted; never rejects.
 */
export const pingUptimelyDeployHeartbeat = async (
	context: Pick<
		UptimelyDeployContext,
		"organizationId" | "serviceType" | "serviceId" | "serviceName"
	>,
): Promise<boolean> => {
	try {
		const link = await db.query.uptimelyMonitorLink.findFirst({
			where: and(
				eq(uptimelyMonitorLink.serviceType, context.serviceType),
				eq(uptimelyMonitorLink.serviceId, context.serviceId),
				eq(uptimelyMonitorLink.kind, "heartbeat"),
			),
			with: { integration: true },
		});
		if (!link?.heartbeatKey || !link.integration) return false;
		if (link.integration.organizationId !== context.organizationId) {
			return false;
		}
		return await pingUptimelyHeartbeat({
			baseUrl: link.integration.baseUrl,
			secretKey: link.heartbeatKey,
			label: `${context.serviceType} "${context.serviceName}"`,
		});
	} catch (error) {
		console.error(
			`Uptimely deploy heartbeat lookup for ${context.serviceType} "${context.serviceName}" failed:`,
			error instanceof Error ? error.name : "unknown error",
		);
		return false;
	}
};

// ---------------------------------------------------------------------------
// Incident channel
// ---------------------------------------------------------------------------

/**
 * Declaring needs the "App Build Error" switch; resolving does not, so an
 * incident still closes after someone turns that switch off.
 */
const findUptimelyChannels = (
	organizationId: string,
	options: { listeningToBuildErrors: boolean },
) =>
	db.query.notifications.findMany({
		where: and(
			eq(notifications.notificationType, "uptimely"),
			options.listeningToBuildErrors
				? eq(notifications.appBuildError, true)
				: undefined,
			eq(notifications.organizationId, organizationId),
		),
		with: { uptimelyChannel: true },
	});

const RESOLVED_STATE_NAME = /^resolved$/i;
const resolvedStateCache = new Map<string, string>();

/**
 * No Uptimely tool lists incident states, so the id of the Resolved state is
 * read off the project's incidents: any incident currently in a state named
 * "Resolved" carries it. A channel can pin the id instead (`resolvedStateId`).
 */
const discoverResolvedStateId = async (
	client: UptimelyClient,
	channel: { baseUrl: string; projectId: string },
) => {
	const cacheKey = `${channel.baseUrl}|${channel.projectId}`;
	const cached = resolvedStateCache.get(cacheKey);
	if (cached) return cached;
	const result = await client.callTool<{
		incidents?: { state: { id: string; name: string } | null }[];
	}>("uptimely_incident_list", {
		projectId: channel.projectId,
		limit: 100,
		activeOnly: false,
	});
	const resolved = (result.incidents ?? []).find(
		(incident) =>
			incident.state && RESOLVED_STATE_NAME.test(incident.state.name),
	)?.state;
	if (!resolved) {
		throw new UptimelyError(
			"Could not find the Resolved incident state in Uptimely. Resolve any incident in the project once, or set the Resolved state ID on the Uptimely notification.",
			{ code: "RESOLVED_STATE_UNKNOWN" },
		);
	}
	resolvedStateCache.set(cacheKey, resolved.id);
	return resolved.id;
};

/** Test hook: forgets the Resolved state ids learned from Uptimely. */
export const resetUptimelyResolvedStateCache = () => resolvedStateCache.clear();

/** A claim older than this belongs to a declare that never finished. */
export const UPTIMELY_CLAIM_TTL_MS = 5 * 60_000;

/**
 * Uptimely answers an unknown or foreign incident id with a successful
 * `{ error: "Incident not found or access denied." }`, which the client
 * throws. Either way the incident is gone for this channel.
 */
export const isUptimelyIncidentGone = (error: unknown) =>
	error instanceof UptimelyError &&
	/not found|access denied/i.test(error.message);

type UptimelyChannelRow = NonNullable<
	Awaited<ReturnType<typeof findUptimelyChannels>>[number]["uptimelyChannel"]
>;

const forgetIncidentRow = (channelIncidentId: string) =>
	db
		.delete(uptimelyChannelIncident)
		.where(eq(uptimelyChannelIncident.channelIncidentId, channelIncidentId));

const declareFor = async (
	channel: UptimelyChannelRow,
	context: UptimelyDeployContext,
	failure: { errorMessage: string; buildLink: string },
) => {
	const serviceKey = uptimelyServiceKey(context.serviceType, context.serviceId);
	const client = clientFor(channel);

	const open = await db.query.uptimelyChannelIncident.findFirst({
		where: and(
			eq(uptimelyChannelIncident.uptimelyChannelId, channel.uptimelyChannelId),
			eq(uptimelyChannelIncident.serviceKey, serviceKey),
		),
	});
	if (open) {
		if (!open.incidentId) {
			// Another failure is declaring right now. Retake the claim only when it
			// is stale (that declare died); the delete is atomic, so one caller wins.
			const retaken = await db
				.delete(uptimelyChannelIncident)
				.where(
					and(
						eq(
							uptimelyChannelIncident.channelIncidentId,
							open.channelIncidentId,
						),
						isNull(uptimelyChannelIncident.incidentId),
						lt(
							uptimelyChannelIncident.createdAt,
							new Date(Date.now() - UPTIMELY_CLAIM_TTL_MS),
						),
					),
				)
				.returning();
			if (retaken.length === 0) return;
		} else {
			// Still open: a second failure is the same incident. One resolved, or
			// deleted in Uptimely by hand, is forgotten and declared again.
			let resolved = false;
			try {
				const current = await client.callTool<{
					state?: { isResolvedState?: boolean } | null;
				}>("uptimely_incident_get", {
					projectId: channel.projectId,
					incidentId: open.incidentId,
				});
				resolved = !!current.state?.isResolvedState;
			} catch (error) {
				if (!isUptimelyIncidentGone(error)) throw error;
				resolved = true;
			}
			if (!resolved) return;
			await forgetIncidentRow(open.channelIncidentId);
		}
	}

	// Claim the (channel, service) slot before declaring: only the insert that
	// wins declares, so two concurrent failures cannot open two incidents.
	const claim = await db
		.insert(uptimelyChannelIncident)
		.values({
			uptimelyChannelId: channel.uptimelyChannelId,
			serviceKey,
			incidentId: null,
		})
		.onConflictDoNothing()
		.returning()
		.then((rows) => rows[0]);
	if (!claim) return;

	let declared: { incidentId: string };
	try {
		declared = await client.callTool<{ incidentId: string }>(
			"uptimely_incident_declare",
			{
				projectId: channel.projectId,
				title: incidentTitle(context),
				description: describeFailure(failure.errorMessage, failure.buildLink),
			},
		);
	} catch (error) {
		// Release the claim so the next failure can try again.
		await forgetIncidentRow(claim.channelIncidentId).catch(() => {});
		throw error;
	}
	try {
		await db
			.update(uptimelyChannelIncident)
			.set({ incidentId: declared.incidentId })
			.where(
				eq(uptimelyChannelIncident.channelIncidentId, claim.channelIncidentId),
			);
	} catch (error) {
		// The incident exists in Uptimely but could not be remembered, so it will
		// not be resolved automatically: say which one it is.
		console.error(
			`Uptimely incident ${declared.incidentId} was declared for ${context.serviceType} "${context.serviceName}" but could not be stored; resolve it in Uptimely by hand.`,
		);
		await forgetIncidentRow(claim.channelIncidentId).catch(() => {});
		throw error;
	}
};

/**
 * Declares an Uptimely incident on every Uptimely channel of the organization
 * that listens to build errors. A service that already has an open incident on
 * a channel does not get a second one. Never rejects.
 */
export const reportDeployFailureToUptimely = async (
	context: UptimelyDeployContext,
	failure: { errorMessage: string; buildLink: string },
): Promise<void> => {
	try {
		const channels = await findUptimelyChannels(context.organizationId, {
			listeningToBuildErrors: true,
		});
		await Promise.all(
			channels.map(async ({ uptimelyChannel, name }) => {
				if (!uptimelyChannel) return;
				try {
					await declareFor(uptimelyChannel, context, failure);
				} catch (error) {
					console.error(
						`Uptimely notification "${name}" could not declare the incident for ${context.serviceType} "${context.serviceName}":`,
						error instanceof Error ? error.message : "unknown error",
					);
				}
			}),
		);
	} catch (error) {
		console.error(
			"Uptimely incident channels could not be loaded:",
			error instanceof Error ? error.name : "unknown error",
		);
	}
};

const resolveFor = async (
	channel: UptimelyChannelRow,
	context: UptimelyDeployContext,
) => {
	const open = await db.query.uptimelyChannelIncident.findFirst({
		where: and(
			eq(uptimelyChannelIncident.uptimelyChannelId, channel.uptimelyChannelId),
			eq(
				uptimelyChannelIncident.serviceKey,
				uptimelyServiceKey(context.serviceType, context.serviceId),
			),
		),
	});
	// No incident, or one still being declared by a concurrent failure.
	if (!open?.incidentId) return;
	const incidentId = open.incidentId;

	const client = clientFor(channel);
	const change = (incidentStateId: string) =>
		client.callTool<{ changed: boolean; reason?: string }>(
			"uptimely_incident_state_change",
			{
				projectId: channel.projectId,
				incidentId,
				incidentStateId,
				rootCause: "Resolved automatically: the next deployment succeeded.",
			},
		);
	const cacheKey = `${channel.baseUrl}|${channel.projectId}`;
	let stateId = channel.resolvedStateId || null;
	let discoveryError: unknown = null;
	if (!stateId) {
		try {
			stateId = await discoverResolvedStateId(client, channel);
		} catch (error) {
			discoveryError = error;
		}
	}

	let changed: { changed: boolean; reason?: string } | null = null;
	try {
		if (stateId) {
			changed = await change(stateId);
			if (changed.reason === "state_not_found") {
				resolvedStateCache.delete(cacheKey);
				changed = null;
			}
		} else {
			// Last attempt: Uptimely is adding support for the state name. Today the
			// input is a UUID, so a validation error here is expected and not fatal.
			try {
				changed = await change("resolved");
				if (changed.reason === "state_not_found") changed = null;
			} catch (error) {
				if (isUptimelyIncidentGone(error)) throw error;
				changed = null;
			}
		}
	} catch (error) {
		if (isUptimelyIncidentGone(error)) {
			// Deleted in Uptimely, or the key now sees another project: nothing
			// left to resolve, so stop tracking it.
			await forgetIncidentRow(open.channelIncidentId);
			return;
		}
		throw error;
	}
	if (!changed) {
		throw discoveryError instanceof Error
			? discoveryError
			: new UptimelyError(
					"Uptimely does not know the Resolved incident state id. Set the Resolved state ID on the Uptimely notification.",
					{ code: "RESOLVED_STATE_UNKNOWN" },
				);
	}
	// `changed: false` without a reason means the incident is already in the
	// Resolved state (or gone), so there is nothing left to track either way.
	await forgetIncidentRow(open.channelIncidentId);
};

/**
 * Resolves the incident each Uptimely channel declared for this service, if
 * any. A channel whose incident cannot be resolved keeps it so the next
 * success tries again. Never rejects.
 */
export const reportDeploySuccessToUptimelyIncidents = async (
	context: UptimelyDeployContext,
): Promise<void> => {
	try {
		const channels = await findUptimelyChannels(context.organizationId, {
			listeningToBuildErrors: false,
		});
		await Promise.all(
			channels.map(async ({ uptimelyChannel, name }) => {
				if (!uptimelyChannel) return;
				try {
					await resolveFor(uptimelyChannel, context);
				} catch (error) {
					console.error(
						`Uptimely notification "${name}" could not resolve the incident for ${context.serviceType} "${context.serviceName}":`,
						error instanceof Error ? error.message : "unknown error",
					);
				}
			}),
		);
	} catch (error) {
		console.error(
			"Uptimely incident channels could not be loaded:",
			error instanceof Error ? error.name : "unknown error",
		);
	}
};

/** A successful deploy: ping the heartbeat and resolve any open incident. */
export const reportDeploySuccessToUptimely = async (
	context: UptimelyDeployContext,
): Promise<void> => {
	await Promise.all([
		pingUptimelyDeployHeartbeat(context),
		reportDeploySuccessToUptimelyIncidents(context),
	]);
};

/**
 * Forgets everything Dokploy stored about a deleted service: its heartbeat
 * link and the incident it may have open on an Uptimely channel. The
 * Uptimely-side monitors and incidents stay (Uptimely has no delete tool).
 * Best effort: a failure here must not fail the deletion that called it.
 */
export const removeUptimelyServiceRows = async (
	services: { serviceType: UptimelyServiceType; serviceId: string }[],
): Promise<void> => {
	if (services.length === 0) return;
	try {
		for (const serviceType of new Set(services.map((x) => x.serviceType))) {
			const ids = services
				.filter((x) => x.serviceType === serviceType)
				.map((x) => x.serviceId);
			await db
				.delete(uptimelyMonitorLink)
				.where(
					and(
						eq(uptimelyMonitorLink.serviceType, serviceType),
						inArray(uptimelyMonitorLink.serviceId, ids),
					),
				);
		}
		await db.delete(uptimelyChannelIncident).where(
			inArray(
				uptimelyChannelIncident.serviceKey,
				services.map((x) => uptimelyServiceKey(x.serviceType, x.serviceId)),
			),
		);
	} catch (error) {
		console.error(
			"Uptimely rows of a deleted service could not be removed:",
			error instanceof Error ? error.name : "unknown error",
		);
	}
};
