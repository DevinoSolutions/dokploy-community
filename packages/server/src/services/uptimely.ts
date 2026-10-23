import { trimTrailingSlashes } from "@dokploy/server/utils/integrations/base-url";
import { db } from "@dokploy/server/db";
import {
	type apiCreateUptimely,
	type apiUpdateUptimely,
	parseUptimelyHeartbeatKey,
	type UptimelyMonitorKind,
	type UptimelyServiceType,
	uptimelyIntegration,
	uptimelyMonitorLink,
} from "@dokploy/server/db/schema";
import { maskApiKey } from "@dokploy/server/utils/integrations/mask";
import {
	isSameUptimelyBaseUrl,
	UPTIMELY_URL_CHANGE_NEEDS_KEY_MESSAGE,
} from "@dokploy/server/utils/uptimely/base-url";
import {
	createUptimelyClient,
	type UptimelyClient,
	UptimelyError,
} from "@dokploy/server/utils/uptimely/client";
import {
	preflightUrls,
	type UptimelyPreflightResult,
} from "@dokploy/server/utils/uptimely/preflight";
import {
	getUptimelyBackoffUntil,
	invalidateUptimelyCache,
	isUptimelyQuotaError,
	readUptimelyCached,
} from "@dokploy/server/utils/uptimely/read-cache";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, ne } from "drizzle-orm";
import type { z } from "zod";
import { findApplicationById } from "./application";
import { findComposeById } from "./compose";
import { findDomainsByApplicationId, findDomainsByComposeId } from "./domain";
import { findMariadbById } from "./mariadb";
import { findMongoById } from "./mongo";
import { findMySqlById } from "./mysql";
import { findPostgresById } from "./postgres";
import { findRedisById } from "./redis";
import { getWebServerSettings } from "./web-server-settings";

export type UptimelyIntegration = typeof uptimelyIntegration.$inferSelect;
export type UptimelyMonitorLink = typeof uptimelyMonitorLink.$inferSelect;

/** Check cadence for every monitor Dokploy creates (every 5 minutes). */
export const UPTIMELY_MONITOR_INTERVAL = "*/5 * * * *";

const MONITOR_TYPE_BY_KIND: Record<UptimelyMonitorKind, string> = {
	website: "Website",
	port: "Port",
	ssl: "SSL Certificate",
	domain: "Domain",
	heartbeat: "Incoming Request",
};

export const uptimelyClientFor = (
	integration: Pick<UptimelyIntegration, "apiKey" | "baseUrl">,
): UptimelyClient =>
	createUptimelyClient({
		apiKey: integration.apiKey,
		baseUrl: integration.baseUrl,
	});

/**
 * Metered read through the shared TTL cache (see utils/uptimely/read-cache):
 * one upstream call per tool + arguments per minute across every tab and user
 * of the integration, and none while the integration is in quota backoff.
 * Writes must call `uptimelyClientFor(...).callTool` directly.
 */
const readUptimelyTool = <T>(
	integration: UptimelyIntegration,
	tool: string,
	args: Record<string, unknown>,
): Promise<T> =>
	readUptimelyCached(integration, `${tool}|${JSON.stringify(args)}`, () =>
		uptimelyClientFor(integration).callTool<T>(tool, args),
	);

/** Masks a stored API key down to its last four characters. */
export const maskUptimelyApiKey = maskApiKey;

/** Deep link to a monitor in the Uptimely dashboard. */
export const uptimelyMonitorUrl = (
	integration: Pick<UptimelyIntegration, "baseUrl" | "projectId">,
	monitorId: string,
) =>
	`${trimTrailingSlashes(integration.baseUrl)}/dashboard/${integration.projectId}/monitors/${monitorId}`;

/** Public, unauthenticated SVG badge of an Uptimely status page. */
export const uptimelyBadgeUrl = (
	integration: Pick<UptimelyIntegration, "baseUrl" | "statusPageSlug">,
) =>
	integration.statusPageSlug
		? `${trimTrailingSlashes(integration.baseUrl)}/status/${encodeURIComponent(integration.statusPageSlug)}/badge`
		: null;

// ---------------------------------------------------------------------------
// Integration CRUD (one row per organization)
// ---------------------------------------------------------------------------

export const findUptimelyByOrganizationId = async (organizationId: string) => {
	const result = await db.query.uptimelyIntegration.findFirst({
		where: eq(uptimelyIntegration.organizationId, organizationId),
	});
	return result ?? null;
};

export const createUptimely = async (
	input: z.infer<typeof apiCreateUptimely>,
	organizationId: string,
) => {
	const existing = await findUptimelyByOrganizationId(organizationId);
	if (existing) {
		throw new TRPCError({
			code: "CONFLICT",
			message:
				"This organization already has an Uptimely integration. Edit it instead.",
		});
	}
	const created = await db
		.insert(uptimelyIntegration)
		.values({
			name: input.name,
			apiKey: input.apiKey,
			projectId: input.projectId,
			baseUrl: input.baseUrl,
			statusPageSlug: input.statusPageSlug ?? null,
			organizationId,
		})
		.returning()
		.then((rows) => rows[0]);
	if (!created) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the Uptimely integration",
		});
	}
	return created;
};

export const updateUptimely = async (
	organizationId: string,
	input: z.infer<typeof apiUpdateUptimely>,
) => {
	// The stored key must not be sent to a URL the caller just chose.
	if (input.baseUrl !== undefined && !input.apiKey) {
		const stored = await findUptimelyByOrganizationId(organizationId);
		if (stored && !isSameUptimelyBaseUrl(input.baseUrl, stored.baseUrl)) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: UPTIMELY_URL_CHANGE_NEEDS_KEY_MESSAGE,
			});
		}
	}
	const values: Partial<UptimelyIntegration> = {};
	if (input.name !== undefined) values.name = input.name;
	if (input.apiKey !== undefined) values.apiKey = input.apiKey;
	if (input.projectId !== undefined) values.projectId = input.projectId;
	if (input.baseUrl !== undefined) values.baseUrl = input.baseUrl;
	if (input.statusPageSlug !== undefined) {
		values.statusPageSlug = input.statusPageSlug || null;
	}
	const updated = await db
		.update(uptimelyIntegration)
		.set(values)
		.where(eq(uptimelyIntegration.organizationId, organizationId))
		.returning()
		.then((rows) => rows[0]);
	if (!updated) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Uptimely integration not found",
		});
	}
	invalidateUptimelyCache(updated);
	return updated;
};

export const removeUptimely = async (organizationId: string) => {
	const removed = await db
		.delete(uptimelyIntegration)
		.where(eq(uptimelyIntegration.organizationId, organizationId))
		.returning()
		.then((rows) => rows[0]);
	if (removed) invalidateUptimelyCache(removed);
	return removed ?? null;
};

// ---------------------------------------------------------------------------
// Connection test + status pages
// ---------------------------------------------------------------------------

export interface UptimelyProject {
	id: string;
	name: string;
	slug: string;
}

export const testUptimelyConnection = async (params: {
	apiKey: string;
	baseUrl: string;
	projectId?: string;
}) => {
	const client = uptimelyClientFor(params);
	const result = await client.callTool<{
		projects: UptimelyProject[];
		defaultProjectId: string | null;
	}>("uptimely_project_list");
	const projects = result.projects ?? [];
	return {
		projects,
		projectFound:
			!!params.projectId && projects.some((p) => p.id === params.projectId),
	};
};

export interface UptimelyStatusPage {
	id: string;
	name: string;
	slug: string;
	isPublic: boolean;
	subscriberCount: number;
}

export const listUptimelyStatusPages = async (
	integration: UptimelyIntegration,
) => {
	const result = await readUptimelyTool<{
		statusPages: UptimelyStatusPage[];
	}>(integration, "uptimely_status_page_list", {
		projectId: integration.projectId,
	});
	return result.statusPages ?? [];
};

// ---------------------------------------------------------------------------
// Service → monitor plan
// ---------------------------------------------------------------------------

export interface UptimelyServiceTarget {
	organizationId: string;
	projectName: string;
	serviceName: string;
	/** Public HTTPS URLs of the service (one Website monitor each). */
	httpsUrls: { host: string; url: string }[];
	/** Externally exposed database endpoint, if any. */
	externalEndpoint: { host: string; port: number } | null;
}

export interface UptimelyMonitorSpec {
	kind: UptimelyMonitorKind;
	monitorType: string;
	name: string;
	target: string;
	args: Record<string, unknown>;
}

type DomainLike = {
	host: string;
	https: boolean;
	path?: string | null;
	domainType?: string | null;
	previewDeploymentId?: string | null;
};

/**
 * `checkPath` (already validated by `uptimelyCheckPathSchema`) is appended to
 * each domain's own path rather than replacing it: a domain with path `/api`
 * only routes `/api*` to this service, so `/api` + `/health` is the URL that
 * actually reaches it. For the usual `/` domain path the result is just the
 * check path.
 */
export const httpsUrlsFromDomains = (
	domains: DomainLike[],
	checkPath?: string,
) => {
	const seen = new Set<string>();
	const urls: { host: string; url: string }[] = [];
	for (const domain of domains) {
		const host = domain.host?.trim().toLowerCase();
		if (!domain.https || !host) continue;
		// Wildcards cannot be probed; preview domains come and go with PRs.
		if (host.includes("*")) continue;
		if (domain.domainType === "preview" || domain.previewDeploymentId) continue;
		const path =
			domain.path && domain.path !== "/"
				? domain.path.startsWith("/")
					? domain.path
					: `/${domain.path}`
				: "";
		const url = checkPath
			? `https://${host}${trimTrailingSlashes(path)}${checkPath}`
			: `https://${host}${path}`;
		// Defense in depth: whatever the path says, the host must stay the
		// service's own.
		if (checkPath && new URL(url).host !== host) continue;
		if (seen.has(url)) continue;
		seen.add(url);
		urls.push({ host, url });
	}
	return urls;
};

const DATABASE_FINDERS = {
	postgres: findPostgresById,
	mysql: findMySqlById,
	mariadb: findMariadbById,
	mongo: findMongoById,
	redis: findRedisById,
} as const;

/**
 * Loads the service identified by (serviceType, serviceId) and extracts what
 * Uptimely can watch: its HTTPS domains (application/compose) or its external
 * endpoint (databases with an exposed port).
 */
export const resolveUptimelyServiceTarget = async (
	serviceType: UptimelyServiceType,
	serviceId: string,
	options: { checkPath?: string } = {},
): Promise<UptimelyServiceTarget> => {
	if (serviceType === "application") {
		const application = await findApplicationById(serviceId);
		const domains = await findDomainsByApplicationId(serviceId);
		return {
			organizationId: application.environment.project.organizationId,
			projectName: application.environment.project.name,
			serviceName: application.name,
			httpsUrls: httpsUrlsFromDomains(domains, options.checkPath),
			externalEndpoint: null,
		};
	}
	if (serviceType === "compose") {
		const compose = await findComposeById(serviceId);
		const domains = await findDomainsByComposeId(serviceId);
		return {
			organizationId: compose.environment.project.organizationId,
			projectName: compose.environment.project.name,
			serviceName: compose.name,
			httpsUrls: httpsUrlsFromDomains(domains, options.checkPath),
			externalEndpoint: null,
		};
	}
	const database = await DATABASE_FINDERS[serviceType](serviceId);
	let externalEndpoint: UptimelyServiceTarget["externalEndpoint"] = null;
	if (database.externalPort) {
		const host =
			database.server?.ipAddress ||
			(await getWebServerSettings())?.serverIp ||
			null;
		if (host) {
			externalEndpoint = { host, port: database.externalPort };
		}
	}
	return {
		organizationId: database.environment.project.organizationId,
		projectName: database.environment.project.name,
		serviceName: database.name,
		httpsUrls: [],
		externalEndpoint,
	};
};

/**
 * Pure: true when the service has something Uptimely can watch (an HTTPS
 * domain, or a database external endpoint). The panel uses it to explain, up
 * front, why "Monitor with Uptimely" would be refused.
 */
export const hasUptimelyMonitorableTarget = (
	target: Pick<UptimelyServiceTarget, "httpsUrls" | "externalEndpoint">,
) => target.httpsUrls.length > 0 || target.externalEndpoint !== null;

/**
 * Pure: the monitors Uptimely should get for a service. One Website monitor per
 * HTTPS URL, one Port monitor for an exposed database, plus optional SSL
 * Certificate + Domain monitors per distinct HTTPS host.
 */
export const planUptimelyMonitors = (
	target: UptimelyServiceTarget,
	options: { includeSslAndDomain: boolean },
): UptimelyMonitorSpec[] => {
	const base = `${target.projectName}/${target.serviceName}`;
	const specs: UptimelyMonitorSpec[] = [];
	const common = { monitoringInterval: UPTIMELY_MONITOR_INTERVAL };

	for (const { url } of target.httpsUrls) {
		const display = url.replace(/^https:\/\//, "");
		specs.push({
			kind: "website",
			monitorType: MONITOR_TYPE_BY_KIND.website,
			name: `${base} (${display})`,
			target: url,
			args: { ...common, url },
		});
	}

	if (target.externalEndpoint) {
		const { host, port } = target.externalEndpoint;
		specs.push({
			kind: "port",
			monitorType: MONITOR_TYPE_BY_KIND.port,
			name: `${base} (${host}:${port})`,
			target: `${host}:${port}`,
			args: { ...common, host, port },
		});
	}

	if (options.includeSslAndDomain) {
		const hosts = [...new Set(target.httpsUrls.map((u) => u.host))];
		for (const host of hosts) {
			specs.push({
				kind: "ssl",
				monitorType: MONITOR_TYPE_BY_KIND.ssl,
				name: `${base} SSL (${host})`,
				target: host,
				args: { ...common, host },
			});
		}
		for (const host of hosts) {
			specs.push({
				kind: "domain",
				monitorType: MONITOR_TYPE_BY_KIND.domain,
				name: `${base} domain (${host})`,
				target: host,
				args: { ...common, host },
			});
		}
	}

	return specs;
};

// ---------------------------------------------------------------------------
// Link / unlink
// ---------------------------------------------------------------------------

export const findUptimelyLinks = async (
	uptimelyId: string,
	serviceType: UptimelyServiceType,
	serviceId: string,
) =>
	db.query.uptimelyMonitorLink.findMany({
		where: and(
			eq(uptimelyMonitorLink.uptimelyId, uptimelyId),
			eq(uptimelyMonitorLink.serviceType, serviceType),
			eq(uptimelyMonitorLink.serviceId, serviceId),
		),
		orderBy: [asc(uptimelyMonitorLink.createdAt)],
	});

/** A monitor as `uptimely_monitor_list` reports it (no URL, host or port). */
type UptimelyListedMonitor = {
	id?: unknown;
	name?: unknown;
	monitorType?: unknown;
};

const LIST_PAGE_SIZE = 100;
/** Hard cap on list pages per link call (1000 monitors). */
const LIST_MAX_PAGES = 10;

const monitorNameKey = (name: string) =>
	name.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Lists the project's monitors: one pass of `uptimely_monitor_list` pages
 * (offset based, at most LIST_MAX_PAGES). `count` may be the project total or
 * just this page's size, so it is only trusted as a total when it exceeds the
 * page length. Stops on an empty page, a short page, or all monitors seen.
 * Any failing page fails the whole pass.
 */
const listUptimelyMonitors = async (
	integration: UptimelyIntegration,
): Promise<UptimelyListedMonitor[]> => {
	const all: UptimelyListedMonitor[] = [];
	for (let page = 0; page < LIST_MAX_PAGES; page++) {
		const result = await readUptimelyTool<{
			count?: number;
			monitors?: UptimelyListedMonitor[];
		}>(integration, "uptimely_monitor_list", {
			projectId: integration.projectId,
			limit: LIST_PAGE_SIZE,
			offset: all.length,
		});
		const monitors = Array.isArray(result?.monitors) ? result.monitors : [];
		all.push(...monitors);
		const total = typeof result?.count === "number" ? result.count : null;
		if (monitors.length === 0 || monitors.length < LIST_PAGE_SIZE) break;
		if (total !== null && total > monitors.length && all.length >= total) {
			break;
		}
		if (page === LIST_MAX_PAGES - 1) {
			console.warn(
				`Uptimely monitor list hit the ${LIST_MAX_PAGES}-page cap (${all.length} monitors); matches beyond it are not seen.`,
			);
		}
	}
	return all;
};

/**
 * Finds the already-existing monitor a planned one would duplicate. Uptimely's
 * list returns only id, name and type, so the key is the monitor type plus
 * the exact name Dokploy gives its monitors (`project/service (host)`): that
 * name is derived from the URL or host, so it stands in for the URL. Compared
 * case-insensitively with whitespace collapsed. A monitor already taken by
 * another spec of this run is never matched twice.
 */
const findAdoptableMonitor = (
	spec: UptimelyMonitorSpec,
	monitors: UptimelyListedMonitor[],
	taken: Set<string>,
): string | null => {
	const wanted = monitorNameKey(spec.name);
	for (const monitor of monitors) {
		const id = typeof monitor.id === "string" ? monitor.id : null;
		if (!id || taken.has(id)) continue;
		if (monitor.monitorType !== spec.monitorType) continue;
		if (
			typeof monitor.name === "string" &&
			monitorNameKey(monitor.name) === wanted
		) {
			return id;
		}
	}
	return null;
};

/**
 * Links the planned Uptimely monitors for a service and records a link row
 * per monitor. Monitors already linked for the same (kind, target) are
 * skipped, so re-running after adding a domain only handles the new ones.
 *
 * Before creating anything, the integration's project is listed once (one
 * paginated pass of `uptimely_monitor_list`, never per domain) and a planned
 * monitor that already exists there, same type and same Dokploy-derived name,
 * is adopted: only a link row is written. A monitor is created only when none
 * matches; if Uptimely answers a create with `created: false` (it returned an
 * existing monitor), that counts as adopted too.
 *
 * `monitorId` adopts that specific monitor: it is verified with one
 * `uptimely_monitor_get` (must exist, and match exactly one pending planned
 * monitor's type) and no create is made for it.
 *
 * If a list call fails, linking fails closed instead of creating blindly:
 * creating without knowing what exists is what duplicates monitors and burns
 * Uptimely quota, and a retry costs one list pass rather than a create per
 * domain.
 *
 * Each link is stored as soon as its monitor is known, so a failure part-way
 * never orphans an already-created monitor. Unlinking only deletes link rows
 * (Dokploy never deletes Uptimely monitors), so an adopted monitor is never
 * removed from Uptimely by Dokploy.
 */
export const linkUptimelyService = async (params: {
	integration: UptimelyIntegration;
	serviceType: UptimelyServiceType;
	serviceId: string;
	includeSslAndDomain: boolean;
	/** Path every Website monitor checks; ignored when `target` is passed. */
	checkPath?: string;
	target?: UptimelyServiceTarget;
	/** Adopt this existing monitor of the integration's project instead of creating one. */
	monitorId?: string;
}) => {
	const { integration, serviceType, serviceId } = params;
	const target =
		params.target ??
		(await resolveUptimelyServiceTarget(serviceType, serviceId, {
			checkPath: params.checkPath,
		}));
	const plan = planUptimelyMonitors(target, {
		includeSslAndDomain: params.includeSslAndDomain,
	});
	if (plan.length === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				serviceType === "application" || serviceType === "compose"
					? "Nothing to monitor yet: add a domain with HTTPS enabled to this service first."
					: "Nothing to monitor yet: expose the database on an external port first.",
		});
	}

	const existing = await findUptimelyLinks(
		integration.uptimelyId,
		serviceType,
		serviceId,
	);
	const existingKeys = new Set(existing.map((l) => `${l.kind}|${l.target}`));
	const pending = plan.filter(
		(s) => !existingKeys.has(`${s.kind}|${s.target}`),
	);

	const client = uptimelyClientFor(integration);
	const created: UptimelyMonitorLink[] = [];
	const adopted: UptimelyMonitorLink[] = [];

	const saveLink = (monitorId: string, spec: UptimelyMonitorSpec) =>
		db
			.insert(uptimelyMonitorLink)
			.values({
				uptimelyId: integration.uptimelyId,
				serviceType,
				serviceId,
				monitorId,
				kind: spec.kind,
				target: spec.target,
			})
			.returning()
			.then((rows) => rows[0]);

	const taken = new Set<string>();
	const explicit = new Map<UptimelyMonitorSpec, string>();
	if (params.monitorId && pending.length > 0) {
		if (existing.some((l) => l.monitorId === params.monitorId)) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "That monitor is already linked to this service.",
			});
		}
		let monitor: { id?: unknown; monitorType?: unknown };
		try {
			monitor = await client.callTool<{ id?: unknown; monitorType?: unknown }>(
				"uptimely_monitor_get",
				{ projectId: integration.projectId, monitorId: params.monitorId },
			);
		} catch (error) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `That monitor does not exist in this integration's Uptimely project (${
					error instanceof Error ? error.message : "lookup failed"
				}).`,
				cause: error,
			});
		}
		if (!monitor || (monitor.id != null && monitor.id !== params.monitorId)) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message:
					"That monitor does not exist in this integration's Uptimely project.",
			});
		}
		const candidates = pending.filter(
			(s) => s.monitorType === monitor.monitorType,
		);
		const only = candidates[0];
		if (candidates.length !== 1 || !only) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					candidates.length === 0
						? `That monitor is a ${String(monitor.monitorType)} monitor, which this service has nothing pending for.`
						: "More than one monitor of that type is pending for this service; link the others first so the monitor to adopt is unambiguous.",
			});
		}
		explicit.set(only, params.monitorId);
		taken.add(params.monitorId);
	}

	let listed: UptimelyListedMonitor[] = [];
	if (pending.some((s) => !explicit.has(s))) {
		try {
			listed = await listUptimelyMonitors(integration);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown Uptimely error";
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Could not list the existing Uptimely monitors, so nothing was created (it could duplicate a monitor): ${message}`,
				cause: error,
			});
		}
	}

	for (const spec of pending) {
		const adoptId =
			explicit.get(spec) ?? findAdoptableMonitor(spec, listed, taken);
		if (adoptId) {
			taken.add(adoptId);
			const row = await saveLink(adoptId, spec);
			if (row) adopted.push(row);
			continue;
		}
		let monitorId: string;
		let alreadyExisted = false;
		try {
			const result = await client.callTool<{
				monitorId: string;
				created?: boolean;
			}>("uptimely_monitor_create", {
				projectId: integration.projectId,
				name: spec.name,
				monitorType: spec.monitorType,
				description: `Created by Dokploy for ${serviceType} "${target.serviceName}" (${target.projectName}).`,
				...spec.args,
			});
			monitorId = result.monitorId;
			alreadyExisted = result.created === false;
			// The cached monitor list no longer matches Uptimely.
			invalidateUptimelyCache(integration);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown Uptimely error";
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					created.length > 0
						? `Created ${created.length} of ${pending.length} monitors, then Uptimely refused "${spec.name}": ${message}`
						: message,
				cause: error,
			});
		}
		const row = await saveLink(monitorId, spec);
		if (row) (alreadyExisted ? adopted : created).push(row);
	}

	return { created, adopted, skipped: plan.length - pending.length };
};

/**
 * Preflight of the Website monitors a service would get: one real GET per
 * HTTPS URL of `target`. The URLs come only from the service's own resolved
 * domains (+ the validated check path); `preflightUrls` additionally refuses
 * non-HTTPS and non-public hops, so no caller-supplied URL can reach it.
 */
export const preflightUptimelyTarget = async (
	target: Pick<UptimelyServiceTarget, "httpsUrls">,
	options?: Parameters<typeof preflightUrls>[1],
): Promise<UptimelyPreflightResult[]> =>
	preflightUrls(
		target.httpsUrls.map((u) => u.url),
		options,
	);

/**
 * Removes the link rows only. Uptimely's MCP surface has no monitor delete
 * tool, so the monitors themselves stay in Uptimely until deleted there. The
 * deploy heartbeat is a separate opt-in and is left alone (see
 * `unlinkUptimelyHeartbeat`).
 */
export const unlinkUptimelyService = async (params: {
	integration: UptimelyIntegration;
	serviceType: UptimelyServiceType;
	serviceId: string;
}) =>
	db
		.delete(uptimelyMonitorLink)
		.where(
			and(
				eq(uptimelyMonitorLink.uptimelyId, params.integration.uptimelyId),
				eq(uptimelyMonitorLink.serviceType, params.serviceType),
				eq(uptimelyMonitorLink.serviceId, params.serviceId),
				ne(uptimelyMonitorLink.kind, "heartbeat"),
			),
		)
		.returning();

// ---------------------------------------------------------------------------
// Deploy heartbeat
// ---------------------------------------------------------------------------

export const UPTIMELY_HEARTBEAT_TARGET = "Deploy heartbeat";

type HeartbeatServiceType = Extract<
	UptimelyServiceType,
	"application" | "compose"
>;

/**
 * Pure: reads the heartbeat secret out of a `uptimely_monitor_create` result.
 * Uptimely does not return it today (the key is only shown on the monitor's
 * Settings page), so this looks at the field names a future version is most
 * likely to use and returns null otherwise.
 */
export const extractUptimelyHeartbeatKey = (
	result: Record<string, unknown>,
): string | null => {
	for (const field of [
		"incomingRequestSecretKey",
		"heartbeatKey",
		"secretKey",
		"heartbeatUrl",
		"incomingRequestUrl",
	]) {
		const value = result[field];
		if (typeof value === "string") {
			const key = parseUptimelyHeartbeatKey(value);
			if (key) return key;
		}
	}
	return null;
};

export const findUptimelyHeartbeatLink = async (
	uptimelyId: string,
	serviceType: UptimelyServiceType,
	serviceId: string,
) => {
	const link = await db.query.uptimelyMonitorLink.findFirst({
		where: and(
			eq(uptimelyMonitorLink.uptimelyId, uptimelyId),
			eq(uptimelyMonitorLink.serviceType, serviceType),
			eq(uptimelyMonitorLink.serviceId, serviceId),
			eq(uptimelyMonitorLink.kind, "heartbeat"),
		),
	});
	return link ?? null;
};

/**
 * Creates the service's `Incoming Request` (heartbeat) monitor in Uptimely and
 * stores it as a `heartbeat` link. When Uptimely does not hand back the secret
 * key the link is saved without one and no ping is sent until it is set with
 * `setUptimelyHeartbeatKey`. An existing heartbeat link is returned as is.
 */
export const linkUptimelyHeartbeat = async (params: {
	integration: UptimelyIntegration;
	serviceType: HeartbeatServiceType;
	serviceId: string;
}) => {
	const { integration, serviceType, serviceId } = params;
	const existing = await findUptimelyHeartbeatLink(
		integration.uptimelyId,
		serviceType,
		serviceId,
	);
	if (existing) return { link: existing, created: false };

	const target = await resolveUptimelyServiceTarget(serviceType, serviceId);
	if (target.organizationId !== integration.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this service",
		});
	}

	let created: Record<string, unknown> & { monitorId: string };
	try {
		created = await uptimelyClientFor(integration).callTool<
			Record<string, unknown> & { monitorId: string }
		>("uptimely_monitor_create", {
			projectId: integration.projectId,
			name: `${target.projectName}/${target.serviceName} deploy heartbeat`,
			monitorType: MONITOR_TYPE_BY_KIND.heartbeat,
			description: `Pinged by Dokploy after every successful deploy of ${serviceType} "${target.serviceName}" (${target.projectName}).`,
		});
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				error instanceof Error ? error.message : "Unknown Uptimely error",
			cause: error,
		});
	}
	invalidateUptimelyCache(integration);
	if (typeof created.monitorId !== "string" || !created.monitorId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Uptimely did not return the new monitor",
		});
	}

	const link = await db
		.insert(uptimelyMonitorLink)
		.values({
			uptimelyId: integration.uptimelyId,
			serviceType,
			serviceId,
			monitorId: created.monitorId,
			kind: "heartbeat",
			target: UPTIMELY_HEARTBEAT_TARGET,
			heartbeatKey: extractUptimelyHeartbeatKey(created),
		})
		.returning()
		.then((rows) => rows[0]);
	if (!link) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error saving the Uptimely heartbeat link",
		});
	}
	return { link, created: true };
};

/** Stores the secret key (or heartbeat URL) of the service's heartbeat monitor. */
export const setUptimelyHeartbeatKey = async (params: {
	integration: UptimelyIntegration;
	serviceType: HeartbeatServiceType;
	serviceId: string;
	key: string;
}) => {
	const key = parseUptimelyHeartbeatKey(params.key);
	if (!key) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Paste the heartbeat URL or secret key from the monitor's Settings page in Uptimely",
		});
	}
	const link = await findUptimelyHeartbeatLink(
		params.integration.uptimelyId,
		params.serviceType,
		params.serviceId,
	);
	if (!link) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "This service has no deploy heartbeat yet",
		});
	}
	await db
		.update(uptimelyMonitorLink)
		.set({ heartbeatKey: key })
		.where(eq(uptimelyMonitorLink.linkId, link.linkId));
	return { linkId: link.linkId };
};

/**
 * Deletes the heartbeat link row. Uptimely's MCP surface has no monitor delete
 * tool, so the monitor stays in Uptimely until it is deleted there.
 */
export const unlinkUptimelyHeartbeat = async (params: {
	integration: UptimelyIntegration;
	serviceType: HeartbeatServiceType;
	serviceId: string;
}) =>
	db
		.delete(uptimelyMonitorLink)
		.where(
			and(
				eq(uptimelyMonitorLink.uptimelyId, params.integration.uptimelyId),
				eq(uptimelyMonitorLink.serviceType, params.serviceType),
				eq(uptimelyMonitorLink.serviceId, params.serviceId),
				eq(uptimelyMonitorLink.kind, "heartbeat"),
			),
		)
		.returning();

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface UptimelyStatusRef {
	id?: string;
	name: string;
	color: string;
}

interface UptimelyTimelineSegment {
	status: UptimelyStatusRef | null;
	startsAt: string | null;
	endsAt: string | null;
	createdAt: string;
	rootCause?: string | null;
}

interface UptimelyMonitorDetail {
	id: string;
	name: string;
	monitorType: string;
	currentStatus: UptimelyStatusRef | null;
	statusTimeline: UptimelyTimelineSegment[];
	probes?: { lastPingAt: string | null }[];
}

/**
 * Severity rank of an Uptimely monitor status, higher = worse. Uptimely
 * statuses are user-definable, so the rank is derived from the name; an
 * unknown (null) status ranks just above Operational so a monitor that could
 * not be read never makes the service look healthy.
 */
export const uptimelyStatusSeverity = (
	status: Pick<UptimelyStatusRef, "name"> | null | undefined,
) => {
	if (!status) return 1;
	const name = status.name.toLowerCase();
	if (/offline|down|outage|fail|critical|error/.test(name)) return 4;
	if (/degraded|partial|slow|warn/.test(name)) return 3;
	if (/maintenance|paused/.test(name)) return 2;
	if (/operational|online|healthy|\bup\b/.test(name)) return 0;
	return 2;
};

export const worstUptimelyStatus = (
	statuses: (UptimelyStatusRef | null)[],
): UptimelyStatusRef | null => {
	if (statuses.length === 0) return null;
	let worst: UptimelyStatusRef | null = statuses[0] ?? null;
	for (const status of statuses.slice(1)) {
		if (uptimelyStatusSeverity(status) > uptimelyStatusSeverity(worst)) {
			worst = status;
		}
	}
	return worst;
};

export type UptimelyDayState =
	| "operational"
	| "degraded"
	| "offline"
	| "maintenance"
	| "unknown"
	| "no-data";

export interface UptimelyTimelineDay {
	/** UTC day start, ISO date (YYYY-MM-DD). */
	day: string;
	status: UptimelyStatusRef | null;
	/**
	 * What the bar should say. `no-data` means no segment covers the day (the
	 * monitor did not exist yet); `unknown` means a segment covers it but its
	 * status could not be read. Both differ from "operational".
	 */
	state: UptimelyDayState;
}

/** Pure: the bar state of a day from its worst status (`hasData` = a segment covers it). */
export const uptimelyDayState = (
	status: Pick<UptimelyStatusRef, "name"> | null | undefined,
	hasData: boolean,
): UptimelyDayState => {
	if (!hasData) return "no-data";
	if (!status) return "unknown";
	switch (uptimelyStatusSeverity(status)) {
		case 0:
			return "operational";
		case 3:
			return "degraded";
		case 4:
			return "offline";
		case 2:
			return "maintenance";
		default:
			return "unknown";
	}
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure: uptime over the last `days` days from the status segments the panel
 * already has. Time-weighted over the time segments cover (a monitor created
 * yesterday is judged on yesterday only): Operational and Degraded count as
 * up, Offline as down; maintenance and unreadable statuses are left out.
 * Returns null when there is nothing to judge.
 */
export const computeUptimelyUptimePercent = (
	segments: UptimelyTimelineSegment[],
	days = 30,
	now: Date = new Date(),
): number | null => {
	const windowStart = now.getTime() - days * DAY_MS;
	let up = 0;
	let down = 0;
	for (const segment of segments) {
		const start = Math.max(
			Date.parse(segment.startsAt ?? segment.createdAt),
			windowStart,
		);
		const end = Math.min(
			segment.endsAt ? Date.parse(segment.endsAt) : now.getTime(),
			now.getTime(),
		);
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
			continue;
		}
		const severity = uptimelyStatusSeverity(segment.status);
		if (severity === 0 || severity === 3) up += end - start;
		else if (severity === 4) down += end - start;
	}
	const total = up + down;
	return total > 0 ? (up / total) * 100 : null;
};

/**
 * Pure: the segment the monitor is in right now (the open one, else the most
 * recently started), used for "since" and the reason Uptimely recorded.
 */
export const currentUptimelySegment = (
	segments: UptimelyTimelineSegment[],
): UptimelyTimelineSegment | null => {
	const open = segments.find((s) => !s.endsAt);
	if (open) return open;
	let latest: UptimelyTimelineSegment | null = null;
	for (const s of segments) {
		if (
			!latest ||
			Date.parse(s.startsAt ?? s.createdAt) >
				Date.parse(latest.startsAt ?? latest.createdAt)
		) {
			latest = s;
		}
	}
	return latest;
};

/**
 * Pure: folds status timeline segments into one bucket per UTC day (oldest
 * first), each carrying the worst status seen that day. Days no segment
 * covers are `null` with state `no-data`.
 */
export const buildUptimelyDailyTimeline = (
	segments: UptimelyTimelineSegment[],
	days = 30,
	now: Date = new Date(),
): UptimelyTimelineDay[] => {
	const DAY = DAY_MS;
	const todayStart = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate(),
	);
	const spans = segments
		.map((s) => {
			const start = Date.parse(s.startsAt ?? s.createdAt);
			const end = s.endsAt ? Date.parse(s.endsAt) : now.getTime();
			return { status: s.status, start, end };
		})
		.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end));

	const buckets: UptimelyTimelineDay[] = [];
	for (let i = days - 1; i >= 0; i--) {
		const dayStart = todayStart - i * DAY;
		const dayEnd = dayStart + DAY;
		const overlapping = spans.filter(
			(s) => s.start < dayEnd && s.end >= dayStart,
		);
		const status =
			overlapping.length > 0
				? worstUptimelyStatus(overlapping.map((s) => s.status))
				: null;
		buckets.push({
			day: new Date(dayStart).toISOString().slice(0, 10),
			status,
			state: uptimelyDayState(status, overlapping.length > 0),
		});
	}
	return buckets;
};

export const getUptimelyServiceStatus = async (params: {
	integration: UptimelyIntegration;
	serviceType: UptimelyServiceType;
	serviceId: string;
}) => {
	const { integration } = params;
	const allLinks = await findUptimelyLinks(
		integration.uptimelyId,
		params.serviceType,
		params.serviceId,
	);
	// The deploy heartbeat is reported on its own, not as an uptime monitor.
	const links = allLinks.filter((l) => l.kind !== "heartbeat");
	const heartbeatLink = allLinks.find((l) => l.kind === "heartbeat");
	const heartbeatDetail = heartbeatLink
		? await readUptimelyTool<UptimelyMonitorDetail>(
				integration,
				"uptimely_monitor_get",
				{
					projectId: integration.projectId,
					monitorId: heartbeatLink.monitorId,
				},
			).then(
					(detail) => ({ detail, error: null }),
					(error: unknown) => ({
						detail: null,
						error:
							error instanceof Error
								? error.message
								: "Could not read the monitor from Uptimely",
					}),
				)
		: null;
	const results = await Promise.allSettled(
		links.map((link) =>
			readUptimelyTool<UptimelyMonitorDetail>(
				integration,
				"uptimely_monitor_get",
				{
					projectId: integration.projectId,
					monitorId: link.monitorId,
				},
			),
		),
	);

	const monitors = links.map((link, index) => {
		const result = results[index];
		const detail = result?.status === "fulfilled" ? result.value : null;
		const error =
			result?.status === "rejected"
				? result.reason instanceof Error
					? result.reason.message
					: "Could not read the monitor from Uptimely"
				: null;
		const segments = detail?.statusTimeline ?? [];
		const current = currentUptimelySegment(segments);
		const lastPingAt =
			(detail?.probes ?? [])
				.map((p) => p.lastPingAt)
				.filter((t): t is string => !!t)
				.sort()
				.at(-1) ?? null;
		return {
			linkId: link.linkId,
			monitorId: link.monitorId,
			kind: link.kind,
			target: link.target,
			name: detail?.name ?? null,
			status: detail?.currentStatus ?? null,
			timeline: buildUptimelyDailyTimeline(segments),
			/** 30-day uptime in percent, null until the monitor has history. */
			uptimePercent: computeUptimelyUptimePercent(segments),
			/** When the monitor entered its current status. */
			statusSince: current?.startsAt ?? current?.createdAt ?? null,
			/** Reason Uptimely recorded for the current status, if any. */
			reason: current?.rootCause ?? null,
			/** Last probe time, when Uptimely reports one (not for every monitor). */
			lastCheckAt: lastPingAt,
			url: uptimelyMonitorUrl(integration, link.monitorId),
			error,
		};
	});

	const heartbeat =
		heartbeatLink && heartbeatDetail
			? {
					linkId: heartbeatLink.linkId,
					monitorId: heartbeatLink.monitorId,
					/** Whether the secret key is known; the key itself never leaves the server. */
					hasKey: !!heartbeatLink.heartbeatKey,
					status: heartbeatDetail.detail?.currentStatus ?? null,
					/** Last time Uptimely received a ping, when it reports one. */
					lastPingAt:
						(heartbeatDetail.detail?.probes ?? [])
							.map((p) => p.lastPingAt)
							.filter((t): t is string => !!t)
							.sort()
							.at(-1) ?? null,
					url: uptimelyMonitorUrl(integration, heartbeatLink.monitorId),
					settingsUrl: `${uptimelyMonitorUrl(integration, heartbeatLink.monitorId)}/settings`,
					error: heartbeatDetail.error,
				}
			: null;

	// Calm quota state for the panel: set while Uptimely is being left alone.
	const backoffUntil = getUptimelyBackoffUntil(integration);
	const quotaHit =
		backoffUntil !== null ||
		results.some(
			(r) => r.status === "rejected" && isUptimelyQuotaError(r.reason),
		);
	const quota = quotaHit
		? {
				exhausted: true as const,
				retryAfter: new Date(
					backoffUntil ?? Date.now() + 60_000,
				).toISOString(),
			}
		: null;

	return {
		overall: worstUptimelyStatus(monitors.map((m) => m.status)),
		monitors,
		heartbeat,
		quota,
	};
};

export const runUptimelyProbe = async (params: {
	integration: UptimelyIntegration;
	serviceType: UptimelyServiceType;
	serviceId: string;
	linkId?: string;
}) => {
	const { integration } = params;
	const links = (
		await findUptimelyLinks(
			integration.uptimelyId,
			params.serviceType,
			params.serviceId,
		)
	).filter(
		// A heartbeat monitor is never probed: it only waits for deploy pings.
		(l) =>
			l.kind !== "heartbeat" && (!params.linkId || l.linkId === params.linkId),
	);
	if (links.length === 0) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "No Uptimely monitor is linked to this service",
		});
	}
	const client = uptimelyClientFor(integration);
	const results = await Promise.allSettled(
		links.map((link) =>
			client.callTool<{
				result: {
					status: string;
					ok: boolean | null;
					responseTimeMs: number | null;
					stateChanged: boolean;
					reason: string;
				};
			}>("uptimely_run_monitor_probe", {
				projectId: integration.projectId,
				monitorId: link.monitorId,
				expectedMonitorType: MONITOR_TYPE_BY_KIND[link.kind],
			}),
		),
	);
	const probes = links.map((link, index) => {
		const result = results[index];
		return {
			linkId: link.linkId,
			target: link.target,
			result: result?.status === "fulfilled" ? result.value.result : null,
			error:
				result?.status === "rejected"
					? result.reason instanceof Error
						? result.reason.message
						: "Probe failed"
					: null,
		};
	});
	// When every probe was refused for the same reason (typically the AI write
	// gate), surface that as the error instead of a list of identical failures.
	if (probes.every((p) => p.error)) {
		const first = results.find((r) => r.status === "rejected") as
			| PromiseRejectedResult
			| undefined;
		const reason = first?.reason;
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				reason instanceof UptimelyError || reason instanceof Error
					? reason.message
					: "Uptimely refused the probe",
			cause: reason,
		});
	}
	return probes;
};
