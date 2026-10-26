import {
	getWebServerSettings,
	IS_CLOUD,
	isRootOrganization,
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

export const assertLocalHostAccess = async (
	serverId: string | undefined,
	organizationId: string | null | undefined,
) => {
	if (!(await canAccessLocalHost(serverId, organizationId))) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"Only the organization that owns this Dokploy instance can access its host",
		});
	}
};
