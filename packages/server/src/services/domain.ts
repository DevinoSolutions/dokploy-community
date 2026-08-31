import dns from "node:dns";
import { promisify } from "node:util";
import { db } from "@dokploy/server/db";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import { generateRandomDomain } from "@dokploy/server/templates";
import { getRemotePublicIp, isPrivateIp } from "@dokploy/server/utils/ip";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { manageDomain } from "@dokploy/server/utils/traefik/domain";
import { validateDomainRestriction } from "@dokploy/server/utils/wildcard-restriction";
import { getPublicIpWithFallback } from "@dokploy/server/wss/utils";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { type apiCreateDomain, domains } from "../db/schema";
import { findApplicationById } from "./application";
import { detectCDNProvider } from "./cdn";
import { findProjectWildcardConfig } from "./project";
import { findServerById } from "./server";

export type Domain = typeof domains.$inferSelect;

export const createDomain = async (input: z.infer<typeof apiCreateDomain>) => {
	const restriction = await validateDomainRestriction(input.host?.trim() || "");
	if (!restriction.valid) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: restriction.error || "Domain not allowed",
		});
	}

	const result = await db.transaction(async (tx) => {
		const domain = await tx
			.insert(domains)
			.values({
				...input,
				// Hostnames are case-insensitive; store them canonically lowercased so
				// Traefik routing and (case-sensitive) Cloudflare zone/DNS/ingress
				// matching all agree on a single form.
				host: input.host?.trim().toLowerCase(),
			} as typeof domains.$inferInsert)
			.returning()
			.then((response) => response[0]);

		if (!domain) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating domain",
			});
		}

		if (domain.applicationId) {
			const application = await findApplicationById(domain.applicationId);
			await manageDomain(application, domain);
		}

		return domain;
	});

	return result;
};

/**
 * Where the base domain of a generated host came from. Surfaced through the
 * permission-gated procedures so the UI can explain the choice.
 */
export type GeneratedDomainBaseSource =
	| "project"
	| "server"
	| "organization"
	| "environment"
	| "none";

export interface GeneratedDomainBase {
	/** Bare base domain (`apps.example.com`), or null for the sslip.io fallback. */
	baseDomain: string | null;
	source: GeneratedDomainBaseSource;
}

/**
 * Resolves the base domain Dokploy appends to a generated host, in precedence
 * order:
 *
 * 1. `project.wildcardDomain` — the most explicit, per-project override.
 * 2. `server.defaultDomain` — beats the organization policy on purpose: an
 *    organization wildcard points at ONE machine's IP, so a server that
 *    declared its own base must win or multi-server generation would emit
 *    hosts resolving to the wrong host.
 * 3. `organization.wildcardDomain` — only when the project has
 *    `useOrganizationWildcard` (default true). Requires a `projectId`, since
 *    the organization is derived from the project row.
 * 4. `process.env.DEFAULT_DOMAIN` — legacy manager-host base. Only consulted
 *    when no `serverId` was given (see note below).
 * 5. `null` → `generateRandomDomain` falls back to `<ip>.sslip.io`.
 *
 * Note on rung 4: `DEFAULT_DOMAIN` describes the Dokploy manager host, so it is
 * *not* applied to remote servers. Doing so would both change existing
 * behaviour for every remote-server generation and point generated hosts at the
 * manager's DNS while the service runs elsewhere.
 */
export const resolveGeneratedDomainBase = async ({
	projectId,
	serverId,
}: {
	projectId?: string | null;
	serverId?: string | null;
}): Promise<GeneratedDomainBase> => {
	const project = projectId
		? await findProjectWildcardConfig(projectId)
		: null;

	if (project?.wildcardDomain) {
		return { baseDomain: project.wildcardDomain, source: "project" };
	}

	if (serverId) {
		const server = await findServerById(serverId);
		if (server.defaultDomain) {
			return { baseDomain: server.defaultDomain, source: "server" };
		}
	}

	if (project?.useOrganizationWildcard && project.organization?.wildcardDomain) {
		return {
			baseDomain: project.organization.wildcardDomain,
			source: "organization",
		};
	}

	if (!serverId && process.env.DEFAULT_DOMAIN) {
		return { baseDomain: process.env.DEFAULT_DOMAIN, source: "environment" };
	}

	return { baseDomain: null, source: "none" };
};

export interface GeneratedDomain extends GeneratedDomainBase {
	domain: string;
}

export const generateTraefikMeDomain = async (
	appName: string,
	_userId: string,
	serverId?: string,
	projectId?: string,
): Promise<GeneratedDomain> => {
	const base = await resolveGeneratedDomainBase({ projectId, serverId });

	if (serverId) {
		const server = await findServerById(serverId);
		let serverIp = server.ipAddress;
		if (process.env.NODE_ENV !== "development" && isPrivateIp(serverIp)) {
			serverIp = (await getRemotePublicIp(serverId)) ?? serverIp;
		}
		return {
			...base,
			domain: generateRandomDomain({
				serverIp,
				projectName: appName,
				baseDomain: base.baseDomain,
			}),
		};
	}

	if (process.env.NODE_ENV === "development") {
		return {
			...base,
			domain: generateRandomDomain({
				serverIp: "",
				projectName: appName,
				baseDomain: base.baseDomain,
			}),
		};
	}
	const settings = await getWebServerSettings();
	let serverIp = settings?.serverIp || "";
	if (isPrivateIp(serverIp)) {
		serverIp = (await getPublicIpWithFallback()) || serverIp;
	}
	return {
		...base,
		domain: generateRandomDomain({
			serverIp,
			projectName: appName,
			baseDomain: base.baseDomain,
		}),
	};
};

export const generateWildcardDomain = (
	appName: string,
	serverDomain: string,
) => {
	return `${appName}-${serverDomain}`;
};

export const findDomainById = async (domainId: string) => {
	const domain = await db.query.domains.findFirst({
		where: eq(domains.domainId, domainId),
		with: {
			application: {
				columns: { applicationId: true, appName: true, name: true },
			},
		},
	});
	if (!domain) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Domain not found",
		});
	}
	return domain;
};

export const findDomainsByApplicationId = async (applicationId: string) => {
	const domainsArray = await db.query.domains.findMany({
		where: eq(domains.applicationId, applicationId),
		with: {
			application: {
				columns: { applicationId: true, appName: true, name: true },
			},
		},
	});

	return domainsArray;
};

export const findDomainsByComposeId = async (composeId: string) => {
	const domainsArray = await db.query.domains.findMany({
		where: eq(domains.composeId, composeId),
		with: {
			compose: {
				columns: { composeId: true, appName: true, name: true },
			},
		},
	});

	return domainsArray;
};

export const updateDomainById = async (
	domainId: string,
	domainData: Partial<Domain>,
) => {
	// `createDomain` has always enforced the domain-restriction allow-list, but
	// the edit path did not: renaming an existing domain to a host outside the
	// allow-list used to succeed, which made the restriction trivially
	// bypassable. Validate here (rather than in the router) so every caller that
	// changes the host — the domain router, imports, future callers — is covered.
	// Internal updates that never touch `host` (toggleEnable, the Cloudflare
	// provisioning bookkeeping) skip the check entirely.
	if (domainData.host !== undefined && domainData.host !== null) {
		const restriction = await validateDomainRestriction(domainData.host.trim());
		if (!restriction.valid) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: restriction.error || "Domain not allowed",
			});
		}
	}

	const domain = await db
		.update(domains)
		.set({
			...domainData,
			// Keep the stored host canonically lowercased (see createDomain).
			...(domainData.host && { host: domainData.host.trim().toLowerCase() }),
		})
		.where(eq(domains.domainId, domainId))
		.returning();

	return domain[0];
};

export const removeDomainById = async (domainId: string) => {
	await findDomainById(domainId);
	const result = await db
		.delete(domains)
		.where(eq(domains.domainId, domainId))
		.returning();

	return result[0];
};

export const getDomainHost = (domain: Domain) => {
	return `${domain.https ? "https" : "http"}://${domain.host}`;
};

const resolveDns = promisify(dns.resolve4);

export const validateDomain = async (
	domain: string,
	expectedIps?: string[],
): Promise<{
	isValid: boolean;
	resolvedIp?: string;
	error?: string;
	isCloudflare?: boolean;
	cdnProvider?: string;
}> => {
	try {
		// Remove protocol and path if present
		const cleanDomain = domain.replace(/^https?:\/\//, "").split("/")[0];

		// Resolve the domain to get its IP
		const ips = await resolveDns(cleanDomain || "");

		const resolvedIps = ips.map((ip) => ip.toString());

		// Check if any IP belongs to a CDN provider
		const cdnProvider = ips
			.map((ip) => detectCDNProvider(ip))
			.find((provider) => provider !== null);

		// If behind a CDN, we consider it valid but inform the user
		if (cdnProvider) {
			return {
				isValid: true,
				resolvedIp: resolvedIps.join(", "),
				cdnProvider: cdnProvider.displayName,
				error: cdnProvider.warningMessage,
			};
		}

		if (expectedIps && expectedIps.length > 0) {
			const isValid = resolvedIps.some((ip) => expectedIps.includes(ip));
			return {
				isValid,
				resolvedIp: resolvedIps.join(", "),
				error: !isValid
					? `Domain resolves to ${resolvedIps.join(", ")} but should point to ${expectedIps.join(" or ")}`
					: undefined,
			};
		}

		// If no expected IP, just return the resolved IP
		return {
			isValid: true,
			resolvedIp: resolvedIps.join(", "),
		};
	} catch (error) {
		return {
			isValid: false,
			error:
				error instanceof Error ? error.message : "Failed to resolve domain",
		};
	}
};

export const getServerIpCandidates = async (
	serverId?: string | null,
): Promise<string[]> => {
	const candidates = new Set<string>();

	if (serverId) {
		const server = await findServerById(serverId);
		if (server.ipAddress) {
			candidates.add(server.ipAddress);
		}

		const publicIp = await withTimeout(
			execAsyncRemote(
				serverId,
				"curl -s -m 5 https://ifconfig.me || curl -s -m 5 https://icanhazip.com",
			),
			7000,
		);
		const detectedIp = publicIp?.stdout?.trim();
		if (detectedIp) {
			candidates.add(detectedIp);
		}
	} else {
		const settings = await getWebServerSettings();
		if (settings?.serverIp) {
			candidates.add(settings.serverIp);
		}

		const publicIp = await withTimeout(getPublicIpWithFallback(), 7000);
		if (publicIp) {
			candidates.add(publicIp);
		}
	}

	return Array.from(candidates);
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> => {
	return Promise.race([
		promise,
		new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
	]).catch(() => null);
};
