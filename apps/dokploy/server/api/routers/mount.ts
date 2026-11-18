import {
	createMount,
	deleteMount,
	findApplicationById,
	findComposeById,
	findLibsqlById,
	findMariadbById,
	findMongoById,
	findMountById,
	findMountsByApplicationId,
	findMySqlById,
	findPostgresById,
	findRedisById,
	getServiceContainer,
	readFileMountContent,
	updateMount,
} from "@dokploy/server";
import type { ServiceType } from "@dokploy/server/db/schema/mount";
import {
	checkServiceAccess,
	checkServicePermissionAndAccess,
} from "@dokploy/server/services/permission";
import {
	evaluateBindMountHostPath,
	evaluateBindMountPermissions,
} from "@dokploy/server/utils/docker/bind-mount-policy";
import { isPrivilegedVolumeRole } from "@dokploy/server/utils/volume-backups/binding";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { canAccessLocalHost } from "@/server/api/utils/local-host-access";
import { assertVolumeNameForService } from "@/server/api/utils/volume-binding";
import {
	apiCreateMount,
	apiFindMountByApplicationId,
	apiFindOneMount,
	apiRemoveMount,
	apiUpdateMount,
} from "@/server/db/schema";
import { createTRPCRouter, protectedProcedure } from "../trpc";

async function getServiceHost(
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

async function getServiceOrganizationId(
	serviceId: string,
	serviceType: ServiceType,
): Promise<string | null> {
	return (await getServiceHost(serviceId, serviceType))?.organizationId ?? null;
}

type PermissionSettings = {
	uid?: number | null;
	gid?: number | null;
	mode?: string | null;
};

const hasPermissionSettings = (m: PermissionSettings) =>
	(m.uid !== undefined && m.uid !== null) ||
	(m.gid !== undefined && m.gid !== null) ||
	!!m.mode;

const samePermissionSettings = (a: PermissionSettings, b: PermissionSettings) =>
	(a.uid ?? null) === (b.uid ?? null) &&
	(a.gid ?? null) === (b.gid ?? null) &&
	(a.mode || null) === (b.mode || null);

// A bind mount hands a host path to the container, and its uid/gid/mode make
// Dokploy run chown/chmod -R on that path. Members only get the service's own
// directories; the rest of the host is for owners and admins (of the
// organization that owns the host, when the service runs on it).
async function assertBindMountAllowed(
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
		appName: service.appName,
		serverId: service.serverId,
		privilegedRole,
		hostReach:
			privilegedRole &&
			(await canAccessLocalHost(
				service.serverId ?? undefined,
				ctx.session.activeOrganizationId,
			)),
	});
	if (!decision.ok) {
		throw new TRPCError({ code: "FORBIDDEN", message: decision.message });
	}
}

const MOUNT_SERVICE_KEYS = [
	"applicationId",
	"postgresId",
	"mysqlId",
	"mariadbId",
	"mongoId",
	"redisId",
	"libsqlId",
	"composeId",
] as const;

export const mountRouter = createTRPCRouter({
	create: protectedProcedure
		.input(apiCreateMount)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				volume: ["create"],
			});
			// A named volume is global to the host. Mounting a name that is not
			// the service's own would attach another tenant's volume to this one.
			if (input.type === "volume" && input.volumeName) {
				await assertVolumeNameForService(ctx, {
					serviceType: input.serviceType ?? "application",
					serviceId: input.serviceId,
					volumeName: input.volumeName,
				});
			}
			if (input.type === "bind" && input.hostPath) {
				await assertBindMountAllowed(ctx, {
					serviceType: input.serviceType ?? "application",
					serviceId: input.serviceId,
					hostPath: input.hostPath,
					withPermissions: hasPermissionSettings(input),
				});
			}
			const mount = await createMount(input);
			await audit(ctx, {
				action: "create",
				resourceType: "mount",
				resourceId: mount.mountId,
				resourceName: input.mountPath,
			});
			return mount;
		}),
	remove: protectedProcedure
		.input(apiRemoveMount)
		.mutation(async ({ input, ctx }) => {
			const mount = await findMountById(input.mountId);
			const serviceId =
				mount.applicationId ||
				mount.postgresId ||
				mount.mariadbId ||
				mount.mongoId ||
				mount.mysqlId ||
				mount.redisId ||
				mount.libsqlId ||
				mount.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					volume: ["delete"],
				});
			}
			await audit(ctx, {
				action: "delete",
				resourceType: "mount",
				resourceId: input.mountId,
			});
			return await deleteMount(input.mountId);
		}),

	one: protectedProcedure
		.input(apiFindOneMount)
		.query(async ({ input, ctx }) => {
			const mount = await findMountById(input.mountId);
			const serviceId =
				mount.applicationId ||
				mount.postgresId ||
				mount.mariadbId ||
				mount.mongoId ||
				mount.mysqlId ||
				mount.redisId ||
				mount.libsqlId ||
				mount.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					volume: ["read"],
				});
			}
			return mount;
		}),
	readFileContent: protectedProcedure
		.input(apiFindOneMount)
		.query(async ({ input, ctx }) => {
			const mount = await findMountById(input.mountId);
			const serviceId =
				mount.applicationId ||
				mount.postgresId ||
				mount.mariadbId ||
				mount.mongoId ||
				mount.mysqlId ||
				mount.redisId ||
				mount.libsqlId ||
				mount.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					volume: ["read"],
				});
			}
			return await readFileMountContent(input.mountId);
		}),
	update: protectedProcedure
		.input(apiUpdateMount)
		.mutation(async ({ input, ctx }) => {
			const mount = await findMountById(input.mountId);
			const serviceId =
				mount.applicationId ||
				mount.postgresId ||
				mount.mariadbId ||
				mount.mongoId ||
				mount.mysqlId ||
				mount.redisId ||
				mount.libsqlId ||
				mount.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					volume: ["create"],
				});
			}
			// The update input carries the service ids too. Re-pointing the mount
			// at another service would skip the checks below and the permission
			// check on that service.
			if (
				(input.serviceType !== undefined &&
					input.serviceType !== mount.serviceType) ||
				MOUNT_SERVICE_KEYS.some(
					(key) => input[key] !== undefined && input[key] !== mount[key],
				)
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "The service of a mount cannot be changed.",
				});
			}
			const volumeType = input.type ?? mount.type;
			const volumeName =
				input.volumeName === undefined ? mount.volumeName : input.volumeName;
			if (serviceId && volumeType === "volume" && volumeName) {
				await assertVolumeNameForService(ctx, {
					serviceType: mount.serviceType,
					serviceId,
					volumeName,
					existingRow:
						mount.type === "volume" && volumeName === mount.volumeName,
				});
			}
			// What the mount will be once saved. Only a new or changed host path, or
			// changed permission settings, need the caller's reach: a mount that was
			// saved earlier keeps working as it is.
			const bindHostPath =
				input.hostPath === undefined ? mount.hostPath : input.hostPath;
			const bindPermissions = {
				uid: input.uid === undefined ? mount.uid : input.uid,
				gid: input.gid === undefined ? mount.gid : input.gid,
				mode: input.mode === undefined ? mount.mode : input.mode,
			};
			if (
				serviceId &&
				volumeType === "bind" &&
				bindHostPath &&
				(mount.type !== "bind" ||
					bindHostPath !== mount.hostPath ||
					!samePermissionSettings(bindPermissions, mount))
			) {
				await assertBindMountAllowed(ctx, {
					serviceType: mount.serviceType,
					serviceId,
					hostPath: bindHostPath,
					withPermissions: hasPermissionSettings(bindPermissions),
				});
			}
			const { expectedContent, ...mountData } = input;
			if (mount.type === "file" && expectedContent !== undefined) {
				const currentContent = await readFileMountContent(input.mountId);
				if (currentContent !== expectedContent) {
					throw new TRPCError({
						code: "CONFLICT",
						message:
							"The file changed on disk after you opened it. Reopen the editor to load the latest version.",
					});
				}
			}
			await audit(ctx, {
				action: "update",
				resourceType: "mount",
				resourceId: input.mountId,
				resourceName: input.mountPath,
			});
			return await updateMount(input.mountId, mountData);
		}),
	allNamedByApplicationId: protectedProcedure
		.input(z.object({ applicationId: z.string().min(1) }))
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				volume: ["read"],
			});
			const app = await findApplicationById(input.applicationId);
			const container = await getServiceContainer(app.appName, app.serverId);
			const mounts = container?.Mounts.filter(
				(mount) => mount.Type === "volume" && mount.Source !== "",
			);
			return mounts;
		}),
	listByServiceId: protectedProcedure
		.input(apiFindMountByApplicationId)
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.serviceId, "read");
			const organizationId = await getServiceOrganizationId(
				input.serviceId,
				input.serviceType,
			);
			if (
				organizationId === null ||
				organizationId !== ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access this service or it does not exist",
				});
			}
			return await findMountsByApplicationId(
				input.serviceId,
				input.serviceType,
			);
		}),
});
