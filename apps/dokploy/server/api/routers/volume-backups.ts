import {
	createVolumeBackup,
	findVolumeBackupById,
	IS_CLOUD,
	removeVolumeBackup,
	removeVolumeBackupJob,
	restoreVolume,
	runVolumeBackup,
	scheduleVolumeBackup,
	updateVolumeBackup,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	createVolumeBackupSchema,
	updateVolumeBackupSchema,
	VOLUME_NAME_MESSAGE,
	VOLUME_NAME_REGEX,
	volumeBackups,
} from "@dokploy/server/db/schema";
import {
	findDestinationById,
	findDestinationByIdForOrganization,
} from "@dokploy/server/services/destination";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { findServerById } from "@dokploy/server/services/server";
import { findRestorableVolumeNames } from "@dokploy/server/services/volume-backups";
import {
	execAsyncRemote,
	execAsyncStream,
} from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { assertVolumeBackupLimit } from "@/server/api/utils/plan-limits";
import { assertVolumeNameForService } from "@/server/api/utils/volume-binding";
import { removeJob, schedule, updateJob } from "@/server/utils/backup";
import { createTRPCRouter, protectedProcedure, withPermission } from "../trpc";

const VOLUME_BACKUP_SERVICE_KEYS = [
	"applicationId",
	"postgresId",
	"mysqlId",
	"mariadbId",
	"mongoId",
	"redisId",
	"libsqlId",
	"composeId",
] as const;

const VOLUME_BACKUP_SERVICE_TYPES = {
	applicationId: "application",
	postgresId: "postgres",
	mysqlId: "mysql",
	mariadbId: "mariadb",
	mongoId: "mongo",
	redisId: "redis",
	libsqlId: "libsql",
	composeId: "compose",
} as const;

const getVolumeBackupServiceId = (
	vb: Partial<
		Record<(typeof VOLUME_BACKUP_SERVICE_KEYS)[number], string | null>
	>,
) => VOLUME_BACKUP_SERVICE_KEYS.map((key) => vb[key]).find(Boolean) || null;

// A volume backup always belongs to a service. A row that points at none
// cannot be tied to an organization, so by-id routes report it as missing
// instead of skipping the service permission.
const requireVolumeBackupServiceId = (
	vb: Parameters<typeof getVolumeBackupServiceId>[0],
) => {
	const serviceId = getVolumeBackupServiceId(vb);
	if (!serviceId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Volume backup not found",
		});
	}
	return serviceId;
};

export const volumeBackupsRouter = createTRPCRouter({
	list: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				volumeBackupType: z.enum([
					"application",
					"postgres",
					"mysql",
					"mariadb",
					"mongo",
					"redis",
					"compose",
					"libsql",
				]),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				volumeBackup: ["read"],
			});
			return await db.query.volumeBackups.findMany({
				where: eq(volumeBackups[`${input.volumeBackupType}Id`], input.id),
				with: {
					application: {
						columns: { applicationId: true, appName: true, serverId: true },
					},
					postgres: {
						columns: { postgresId: true, appName: true, serverId: true },
					},
					mysql: { columns: { mysqlId: true, appName: true, serverId: true } },
					mariadb: {
						columns: { mariadbId: true, appName: true, serverId: true },
					},
					mongo: { columns: { mongoId: true, appName: true, serverId: true } },
					redis: { columns: { redisId: true, appName: true, serverId: true } },
					compose: {
						columns: { composeId: true, appName: true, serverId: true },
					},
					libsql: {
						columns: { libsqlId: true, appName: true, serverId: true },
					},
				},
				orderBy: [desc(volumeBackups.createdAt)],
			});
		}),
	create: protectedProcedure
		.input(createVolumeBackupSchema)
		.mutation(async ({ input, ctx }) => {
			const serviceType = (
				[
					"application",
					"postgres",
					"mysql",
					"mariadb",
					"mongo",
					"redis",
					"libsql",
					"compose",
				] as const
			).find((type) => input[`${type}Id`]);
			const serviceId = serviceType ? input[`${serviceType}Id`] : undefined;
			if (!serviceType || !serviceId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "A volume backup needs a service to back up.",
				});
			}
			// Every service id on the row must be one the caller can reach, not
			// just the first, or a second id would smuggle in a foreign service.
			for (const key of VOLUME_BACKUP_SERVICE_KEYS) {
				const id = input[key];
				if (id) {
					await checkServicePermissionAndAccess(ctx, id, {
						volumeBackup: ["create"],
					});
				}
			}
			// The volume must be one of the service's own: the backup runs
			// `docker run -v <name>` and uploads the result to the caller's
			// destination, so any other name would exfiltrate another tenant's data.
			await assertVolumeNameForService(ctx, {
				serviceType,
				serviceId,
				volumeName: input.volumeName,
			});
			await findDestinationByIdForOrganization(
				input.destinationId,
				ctx.session.activeOrganizationId,
			);
			if (IS_CLOUD && serviceType) {
				const existingVolumeBackups = await db.query.volumeBackups.findMany({
					where: eq(volumeBackups[`${serviceType}Id`], serviceId),
				});
				await assertVolumeBackupLimit(
					ctx.session.activeOrganizationId,
					existingVolumeBackups.length,
				);
			}
			const newVolumeBackup = await createVolumeBackup(input);

			if (newVolumeBackup?.enabled) {
				if (IS_CLOUD) {
					await schedule({
						cronSchedule: newVolumeBackup.cronExpression,
						volumeBackupId: newVolumeBackup.volumeBackupId,
						type: "volume-backup",
					});
				} else {
					await scheduleVolumeBackup(newVolumeBackup.volumeBackupId);
				}
			}
			await audit(ctx, {
				action: "create",
				resourceType: "volumeBackup",
				resourceId: newVolumeBackup?.volumeBackupId,
			});
			return newVolumeBackup;
		}),
	one: protectedProcedure
		.input(
			z.object({
				volumeBackupId: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			const vb = await findVolumeBackupById(input.volumeBackupId);
			await checkServicePermissionAndAccess(
				ctx,
				requireVolumeBackupServiceId(vb),
				{ volumeBackup: ["read"] },
			);
			return vb;
		}),
	delete: protectedProcedure
		.input(
			z.object({
				volumeBackupId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const vb = await findVolumeBackupById(input.volumeBackupId);
			await checkServicePermissionAndAccess(
				ctx,
				requireVolumeBackupServiceId(vb),
				{ volumeBackup: ["delete"] },
			);
			const result = await removeVolumeBackup(input.volumeBackupId);
			await audit(ctx, {
				action: "delete",
				resourceType: "volumeBackup",
				resourceId: input.volumeBackupId,
			});
			return result;
		}),
	update: protectedProcedure
		.input(updateVolumeBackupSchema)
		.mutation(async ({ input, ctx }) => {
			const existingVb = await findVolumeBackupById(input.volumeBackupId);
			await checkServicePermissionAndAccess(
				ctx,
				requireVolumeBackupServiceId(existingVb),
				{ volumeBackup: ["update"] },
			);
			// The update input carries the service ids too. Re-pointing the row
			// at another service would back that service's volume up to the
			// caller's destination without any permission check on it.
			for (const key of VOLUME_BACKUP_SERVICE_KEYS) {
				if (input[key] !== undefined && input[key] !== existingVb[key]) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "The service of a volume backup cannot be changed.",
					});
				}
			}
			const serviceKey = VOLUME_BACKUP_SERVICE_KEYS.find(
				(key) => existingVb[key],
			);
			if (serviceKey) {
				await assertVolumeNameForService(ctx, {
					serviceType: VOLUME_BACKUP_SERVICE_TYPES[serviceKey],
					serviceId: existingVb[serviceKey] as string,
					volumeName: input.volumeName,
					existingRow: input.volumeName === existingVb.volumeName,
				});
			}
			await findDestinationByIdForOrganization(
				input.destinationId,
				ctx.session.activeOrganizationId,
			);
			const updatedVolumeBackup = await updateVolumeBackup(
				input.volumeBackupId,
				input,
			);

			if (!updatedVolumeBackup) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Volume backup not found",
				});
			}

			if (IS_CLOUD) {
				if (updatedVolumeBackup.enabled) {
					await updateJob({
						cronSchedule: updatedVolumeBackup.cronExpression,
						volumeBackupId: updatedVolumeBackup.volumeBackupId,
						type: "volume-backup",
					});
				} else {
					await removeJob({
						cronSchedule: updatedVolumeBackup.cronExpression,
						volumeBackupId: updatedVolumeBackup.volumeBackupId,
						type: "volume-backup",
					});
				}
			} else {
				if (updatedVolumeBackup?.enabled) {
					await removeVolumeBackupJob(updatedVolumeBackup.volumeBackupId);
					await scheduleVolumeBackup(updatedVolumeBackup.volumeBackupId);
				} else {
					await removeVolumeBackupJob(updatedVolumeBackup.volumeBackupId);
				}
			}
			await audit(ctx, {
				action: "update",
				resourceType: "volumeBackup",
				resourceId: updatedVolumeBackup.volumeBackupId,
			});
			return updatedVolumeBackup;
		}),

	runManually: protectedProcedure
		.input(z.object({ volumeBackupId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const vb = await findVolumeBackupById(input.volumeBackupId);
			await checkServicePermissionAndAccess(
				ctx,
				requireVolumeBackupServiceId(vb),
				{ volumeBackup: ["create"] },
			);
			try {
				const result = await runVolumeBackup(input.volumeBackupId);
				await audit(ctx, {
					action: "run",
					resourceType: "volumeBackup",
					resourceId: input.volumeBackupId,
				});
				return result;
			} catch (error) {
				console.error(error);
				return false;
			}
		}),
	restoreVolumeBackupWithLogs: withPermission("volumeBackup", "restore")
		.meta({
			openapi: {
				enabled: false,
				path: "/restore-volume-backup-with-logs",
				method: "POST",
				override: true,
			},
		})
		.input(
			z.object({
				backupFileName: z.string().min(1),
				destinationId: z.string().min(1),
				volumeName: z
					.string()
					.min(1)
					.regex(VOLUME_NAME_REGEX, VOLUME_NAME_MESSAGE),
				id: z.string().min(1),
				serviceType: z.enum(["application", "compose"]),
				serverId: z.string().optional(),
			}),
		)
		.subscription(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				volumeBackup: ["restore"],
			});
			// The restore removes and recreates the named Docker volume, so it
			// must be one of this service's own volumes, not any volume on the host.
			const restorableVolumes = await findRestorableVolumeNames(
				input.id,
				input.serviceType,
			);
			if (!restorableVolumes.has(input.volumeName)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This volume does not belong to the service.",
				});
			}
			const serviceHost = await assertVolumeNameForService(ctx, {
				serviceType: input.serviceType,
				serviceId: input.id,
				volumeName: input.volumeName,
				existingRow: true,
			});
			// The claims on a volume name were checked for the service's own host,
			// so the restore may only run there, never on a host the caller picks.
			if ((input.serverId || null) !== serviceHost) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "The restore must run on the server of the service.",
				});
			}
			const destination = await findDestinationById(input.destinationId);
			if (destination.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to this destination.",
				});
			}
			const serverId = serviceHost;
			if (serverId) {
				const targetServer = await findServerById(serverId);
				if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this server.",
					});
				}
			}
			return observable<string>((emit) => {
				const runRestore = async () => {
					try {
						emit.next("🚀 Starting volume restore process...");
						emit.next(`📂 Backup File: ${input.backupFileName}`);
						emit.next(`🔧 Volume Name: ${input.volumeName}`);
						emit.next(`🏷️ Service Type: ${input.serviceType}`);
						emit.next(""); // Empty line for better readability

						// Generate the restore command
						const restoreCommand = await restoreVolume(
							input.id,
							input.destinationId,
							input.volumeName,
							input.backupFileName,
							serverId || "",
							input.serviceType,
						);

						emit.next("📋 Generated restore command:");
						emit.next("▶️ Executing restore...");
						emit.next(""); // Empty line

						// Execute the restore command with real-time output
						if (serverId) {
							emit.next(`🌐 Executing on remote server: ${serverId}`);
							await execAsyncRemote(serverId, restoreCommand, (data) => {
								emit.next(data);
							});
						} else {
							emit.next("🖥️ Executing on local server");
							await execAsyncStream(restoreCommand, (data) => {
								emit.next(data);
							});
						}

						emit.next("");
						emit.next("✅ Volume restore completed successfully!");
						emit.next(
							"🎉 All containers/services have been restarted with the restored volume.",
						);
					} catch {
						emit.next("");
						emit.next("❌ Volume restore failed!");
					} finally {
						emit.complete();
					}
				};

				// Start the restore process
				runRestore();
			});
		}),
});
