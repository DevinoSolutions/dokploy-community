import { TRPCError } from "@trpc/server";
import { findBackupById } from "./backup";
import type { findDeploymentById } from "./deployment";
import {
	checkPermission,
	checkServicePermissionAndAccess,
	findMemberByUserId,
	type PermissionCtx,
} from "./permission";
import { findPreviewDeploymentById } from "./preview-deployment";
import { assertHostScheduleAccess, assertScheduleOrganization } from "./schedule";
import { findServerById } from "./server";
import { findVolumeBackupById } from "./volume-backups";

type DeploymentRow = Awaited<ReturnType<typeof findDeploymentById>>;

export type DeploymentAccessAction = "read" | "cancel";

const deny = () =>
	new TRPCError({
		code: "UNAUTHORIZED",
		message: "You don't have access to this deployment.",
	});

const assertOwnerOrAdmin = async (ctx: PermissionCtx) => {
	const member = await findMemberByUserId(
		ctx.user.id,
		ctx.session.activeOrganizationId,
	);
	if (member.role !== "owner" && member.role !== "admin") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only owners and admins can access this deployment.",
		});
	}
};

/**
 * One gate for every route that takes a deployment id. A deployment row points
 * at what it belongs to through different columns depending on its kind, and
 * several kinds carry no service id of their own, so each kind is resolved to
 * the thing that can actually be authorized:
 *
 * - application / compose: the service (deployment permission + access list).
 * - preview deployment: the service its preview belongs to.
 * - schedule: the schedule's service; a `server` schedule needs an owner or
 *   admin and the server in the caller's organization; a `dokploy-server`
 *   schedule needs an owner or admin of the schedule's organization.
 * - backup: the backup's service; a backup with no service (web server) needs
 *   an owner or admin and a destination in the caller's organization.
 * - volume backup: the volume backup's service.
 * - server setup: the server in the caller's organization.
 *
 * A deployment that resolves to none of these is refused.
 */
export const assertDeploymentAccess = async (
	ctx: PermissionCtx,
	deployment: DeploymentRow,
	action: DeploymentAccessAction,
) => {
	const permissions = { deployment: [action] };
	const checkService = (serviceId: string) =>
		checkServicePermissionAndAccess(ctx, serviceId, permissions);
	let matched = false;

	if (deployment.applicationId) {
		matched = true;
		await checkService(deployment.applicationId);
	}
	if (deployment.composeId) {
		matched = true;
		await checkService(deployment.composeId);
	}

	if (deployment.previewDeploymentId) {
		matched = true;
		const preview = await findPreviewDeploymentById(
			deployment.previewDeploymentId,
		);
		const serviceId = preview.applicationId || preview.composeId;
		if (!serviceId) throw deny();
		await checkService(serviceId);
	}

	if (deployment.scheduleId) {
		matched = true;
		const schedule = deployment.schedule;
		if (!schedule) throw deny();
		const serviceId = schedule.applicationId || schedule.composeId;
		if (serviceId) {
			await checkService(serviceId);
		} else if (schedule.scheduleType === "server") {
			await checkPermission(ctx, permissions);
			await assertHostScheduleAccess(ctx, "server", schedule.serverId);
		} else if (schedule.scheduleType === "dokploy-server") {
			await checkPermission(ctx, permissions);
			await assertHostScheduleAccess(ctx, "dokploy-server", null);
			assertScheduleOrganization(ctx, schedule);
		} else {
			throw deny();
		}
	}

	if (deployment.backupId) {
		matched = true;
		const backup = await findBackupById(deployment.backupId);
		const serviceId =
			backup.postgresId ||
			backup.mysqlId ||
			backup.mariadbId ||
			backup.mongoId ||
			backup.libsqlId ||
			backup.composeId;
		if (serviceId) {
			await checkService(serviceId);
		} else {
			await checkPermission(ctx, permissions);
			await assertOwnerOrAdmin(ctx);
			if (
				!backup.destination ||
				backup.destination.organizationId !== ctx.session.activeOrganizationId
			) {
				throw deny();
			}
		}
	}

	if (deployment.volumeBackupId) {
		matched = true;
		const volumeBackup = await findVolumeBackupById(deployment.volumeBackupId);
		const serviceId =
			volumeBackup.applicationId ||
			volumeBackup.postgresId ||
			volumeBackup.mysqlId ||
			volumeBackup.mariadbId ||
			volumeBackup.mongoId ||
			volumeBackup.redisId ||
			volumeBackup.libsqlId ||
			volumeBackup.composeId;
		if (!serviceId) throw deny();
		await checkService(serviceId);
	}

	if (!matched && deployment.serverId) {
		matched = true;
		await checkPermission(ctx, permissions);
		const targetServer = await findServerById(deployment.serverId);
		if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
			throw deny();
		}
	}

	if (!matched) throw deny();
};
