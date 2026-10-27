import {
	findServerById,
	getWebServerSettings,
	IS_CLOUD,
	isRootOrganization,
	PINNED_ROOT_ORGANIZATION_MISSING_HOST_MESSAGE,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";

// The Dokploy host's own parts (its Traefik, its containers, its settings and
// updates) serve every organization of a self-hosted instance, so only the
// organization that owns the instance may act on them. A remote server is
// covered by assertServerInOrganization; Dokploy Cloud has no such host.
export const canAccessLocalHost = async (
	serverId: string | undefined,
	organizationId: string | null | undefined,
) => {
	if (serverId || IS_CLOUD) {
		return true;
	}
	return !!organizationId && (await isRootOrganization(organizationId));
};

// Whether an organization may run its services on the Dokploy host, which is
// what makes the host's address its to know. This is the rule the create routes
// of applications, composes and databases apply when a service has no server:
// refused when the instance is set to remote servers only. The organization
// that owns the instance keeps its own host in any case, and Dokploy Cloud has
// no such host.
export const canUseLocalHostForServices = async (
	organizationId: string | null | undefined,
) => {
	if (IS_CLOUD || !organizationId) {
		return false;
	}
	if (await isRootOrganization(organizationId)) {
		return true;
	}
	const settings = await getWebServerSettings();
	return !settings?.remoteServersOnly;
};

// The address a service on the given server is reached at: a remote server's
// own (the caller has checked it belongs to the organization), or the Dokploy
// host's, which only an organization that may run services on it gets. Empty
// when there is none to give.
export const resolveHostIpForOrg = async (
	organizationId: string | null | undefined,
	serverId?: string | null,
) => {
	if (serverId) {
		return (await findServerById(serverId)).ipAddress;
	}
	if (!(await canUseLocalHostForServices(organizationId))) {
		return "";
	}
	const settings = await getWebServerSettings();
	return settings?.serverIp || "";
};

// A pinned id that matches no organization leaves the instance without an
// owner, which refuses everyone: say that, since nothing the caller does would
// help. Only a refusal pays for the lookup, and only when an id is pinned.
// The same rule as describeHostAccessRefusal in @dokploy/server, kept here
// because many tests replace that module with a handful of exports.
export const hostAccessRefusalMessage = async (message: string) => {
	const pinned = process.env.DOKPLOY_ROOT_ORGANIZATION_ID?.trim();
	if (pinned && !(await isRootOrganization(pinned))) {
		return PINNED_ROOT_ORGANIZATION_MISSING_HOST_MESSAGE;
	}
	return message;
};

export const assertLocalHostAccess = async (
	serverId: string | undefined,
	organizationId: string | null | undefined,
) => {
	if (!(await canAccessLocalHost(serverId, organizationId))) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: await hostAccessRefusalMessage(
				"Only the organization that owns this Dokploy instance can access its host",
			),
		});
	}
};
