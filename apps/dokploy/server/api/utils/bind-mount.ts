import {
	findApplicationById,
	findComposeById,
	findLibsqlById,
	findMariadbById,
	findMongoById,
	findMySqlById,
	findPostgresById,
	findRedisById,
} from "@dokploy/server";
import type { ServiceType } from "@dokploy/server/db/schema/mount";
import {
	evaluateBindMountHostPath,
	evaluateBindMountPermissions,
} from "@dokploy/server/utils/docker/bind-mount-policy";
import { isPrivilegedVolumeRole } from "@dokploy/server/utils/volume-backups/binding";
import { TRPCError } from "@trpc/server";
import { canAccessLocalHost } from "@/server/api/utils/local-host-access";

export async function getServiceHost(
	serviceId: string,
	serviceType: ServiceType,
): Promise<{
	appName: string;
	serverId: string | null;
	organizationId: string | null;
} | null> {
	const service = await (async () => {
		switch (serviceType) {
			case "application":
				return findApplicationById(serviceId);
			case "postgres":
				return findPostgresById(serviceId);
			case "mariadb":
				return findMariadbById(serviceId);
			case "mongo":
				return findMongoById(serviceId);
			case "mysql":
				return findMySqlById(serviceId);
			case "redis":
				return findRedisById(serviceId);
			case "compose":
				return findComposeById(serviceId);
			case "libsql":
				return findLibsqlById(serviceId);
			default:
				return null;
		}
	})();
	if (!service) {
		return null;
	}
	return {
		appName: service.appName,
		serverId: service.serverId ?? null,
		organizationId: service.environment?.project?.organizationId ?? null,
	};
}

type PermissionSettings = {
	uid?: number | null;
	gid?: number | null;
	mode?: string | null;
};

export const hasPermissionSettings = (m: PermissionSettings) =>
	(m.uid !== undefined && m.uid !== null) ||
	(m.gid !== undefined && m.gid !== null) ||
	!!m.mode;

// A bind mount hands a host path to the container, and its uid/gid/mode make
// Dokploy run chown/chmod -R on that path. Members get no bind mounts, not
// even inside the service's own directories (a container can plant a symlink
// there); the host is for owners and admins (of the organization that owns the
// host, when the service runs on it).
export async function assertBindMountAllowed(
	ctx: {
		user: { role?: string | null };
		session: { activeOrganizationId?: string | null };
	},
	{
		serviceId,
		serviceType,
		hostPath,
		withPermissions,
	}: {
		serviceId: string;
		serviceType: ServiceType;
		hostPath: string;
		withPermissions: boolean;
	},
) {
	const service = await getServiceHost(serviceId, serviceType);
	if (!service) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });
	}
	const privilegedRole = isPrivilegedVolumeRole(ctx.user.role);
	const decision = (
		withPermissions ? evaluateBindMountPermissions : evaluateBindMountHostPath
	)({
		hostPath,
		privilegedRole,
		hostReach:
			privilegedRole &&
			(await canAccessLocalHost(
				service.serverId ?? undefined,
				ctx.session.activeOrganizationId,
			)),
	});
	if (!decision.ok) {
		throw new TRPCError({ code: decision.code, message: decision.message });
	}
}
