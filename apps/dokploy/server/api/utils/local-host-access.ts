import { IS_CLOUD, isRootOrganization } from "@dokploy/server";
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
