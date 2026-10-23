import {
	createBackup,
	findBackupById,
	findBackupsByDbId,
	findComposeByBackupId,
	findComposeById,
	findLibsqlByBackupId,
	findLibsqlById,
	findMariadbByBackupId,
	findMariadbById,
	findMongoByBackupId,
	findMongoById,
	findMySqlByBackupId,
	findMySqlById,
	findPostgresByBackupId,
	findPostgresById,
	findServerById,
	IS_CLOUD,
	keepLatestNBackups,
	removeBackupById,
	removeScheduleBackup,
	runLibsqlBackup,
	runMariadbBackup,
	runMongoBackup,
	runMySqlBackup,
	runPostgresBackup,
	runWebServerBackup,
	scheduleBackup,
	updateBackupById,
} from "@dokploy/server";
import {
	assertInstanceBackupInOrganization,
	getBackupServiceId,
	getBackupServiceIds,
	isInstanceBackup,
	validateBackupServiceBinding,
} from "@dokploy/server/services/backup";
import {
	findDestinationById,
	findDestinationByIdForOrganization,
} from "@dokploy/server/services/destination";
import {
	checkServicePermissionAndAccess,
	findServiceOrganizationId,
} from "@dokploy/server/services/permission";
import { runComposeBackup } from "@dokploy/server/utils/backups/compose";
import {
	buildRcloneCommand,
	getRclonePathAndFlags,
	normalizeS3Path,
} from "@dokploy/server/utils/backups/utils";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import {
	restoreComposeBackup,
	restoreLibsqlBackup,
	restoreMariadbBackup,
	restoreMongoBackup,
	restoreMySqlBackup,
	restorePostgresBackup,
	restoreWebServerBackup,
} from "@dokploy/server/utils/restore";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import { z } from "zod";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import { assertDatabaseBackupLimit } from "@/server/api/utils/plan-limits";
import {
	apiCreateBackup,
	apiFindOneBackup,
	apiRemoveBackup,
	apiRestoreBackup,
	apiUpdateBackup,
} from "@/server/db/schema";
import { removeJob, schedule, updateJob } from "@/server/utils/backup";

interface RcloneFile {
	Path: string;
	Name: string;
	Size: number;
	IsDir: boolean;
	Tier?: string;
	Hashes?: {
		MD5?: string;
		SHA1?: string;
	};
}

type BackupAction = "create" | "read" | "update" | "delete" | "restore";
type BackupCtx = {
	user: { id: string; role: string };
	session: { activeOrganizationId: string };
};

// The Dokploy instance backup (databaseType "web-server") zips the base path
// and the database, so it is managed like the instance-level settings
// (adminProcedure): organization owners and admins only. Service-level backup
// permissions and `accessedServices` never apply to it.
const assertInstanceBackupRole = (ctx: BackupCtx) => {
	if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have permission to manage instance backups.",
		});
	}
};

// Service backups: every service id on the row must belong to the active
// organization (a foreign id and a missing one answer alike, with the same
// not-found as an unknown backup id) and be permitted for the caller.
const authorizeServiceBackup = async (
	ctx: BackupCtx,
	backup: Awaited<ReturnType<typeof findBackupById>>,
	action: BackupAction,
) => {
	for (const serviceId of getBackupServiceIds(backup)) {
		if (
			(await findServiceOrganizationId(serviceId)) !==
			ctx.session.activeOrganizationId
		) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Backup not found" });
		}
		await checkServicePermissionAndAccess(ctx, serviceId, {
			backup: [action],
		});
	}
};

// Authorizes a backup row that was loaded by id. Service backups go through
// the service permission; instance backups belong to the organization that
// owns their destination (so an owner or admin there can still manage a row
// whose creator no longer qualifies), then are gated on the owner/admin role.
const authorizeBackupAccess = async (
	ctx: BackupCtx,
	backup: Awaited<ReturnType<typeof findBackupById>>,
	action: BackupAction,
) => {
	if (!isInstanceBackup(backup)) {
		await authorizeServiceBackup(ctx, backup, action);
		return;
	}
	await assertInstanceBackupInOrganization(
		backup,
		ctx.session.activeOrganizationId,
	);
	assertInstanceBackupRole(ctx);
};

// Loads the backup behind a manual run of one service type. A row that has no
// such service (an instance backup, or a row of another type) or that does not
// target exactly one service of its own kind is not found here, so these
// routes cannot be pointed at it.
const findServiceBackupForRun = async (
	ctx: BackupCtx,
	backupId: string,
	serviceKey:
		| "postgresId"
		| "mysqlId"
		| "mariadbId"
		| "mongoId"
		| "libsqlId"
		| "composeId",
) => {
	const backup = await findBackupById(backupId);
	if (
		!backup[serviceKey] ||
		isInstanceBackup(backup) ||
		validateBackupServiceBinding(backup).error
	) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Backup not found" });
	}
	await authorizeServiceBackup(ctx, backup, "create");
	return backup;
};

export const backupRouter = createTRPCRouter({
	create: protectedProcedure
		.input(apiCreateBackup)
		.mutation(async ({ input: rawInput, ctx }) => {
			// The creator is what ties an instance backup to an organization, so
			// it is always the session user, never a client-supplied id.
			const input = {
				...rawInput,
				backupType: rawInput.backupType ?? ("database" as const),
				userId: ctx.user.id,
			};
			// Exactly one service, of the kind the row says it is (or none for the
			// instance), so the permission checked below is the only service the
			// schedule will ever run against.
			const binding = validateBackupServiceBinding(input);
			if (binding.error) {
				throw new TRPCError({ code: "BAD_REQUEST", message: binding.error });
			}
			if (binding.serviceId) {
				await checkServicePermissionAndAccess(ctx, binding.serviceId, {
					backup: ["create"],
				});
			} else {
				assertInstanceBackupRole(ctx);
			}
			await findDestinationByIdForOrganization(
				input.destinationId,
				ctx.session.activeOrganizationId,
			);

			try {
				if (IS_CLOUD) {
					const dbType = (
						["postgres", "mysql", "mariadb", "mongo", "libsql"] as const
					).find((type) => input[`${type}Id`]);
					if (dbType) {
						const existingBackups = await findBackupsByDbId(
							input[`${dbType}Id`]!,
							dbType,
						);
						await assertDatabaseBackupLimit(
							ctx.session.activeOrganizationId,
							existingBackups.length,
						);
					}
				}

				const newBackup = await createBackup(input);
				const backup = await findBackupById(newBackup.backupId);

				if (IS_CLOUD && backup.enabled) {
					const databaseType = backup.databaseType;
					let serverId = "";
					if (databaseType === "postgres" && backup.postgres?.serverId) {
						serverId = backup.postgres.serverId;
					} else if (databaseType === "mysql" && backup.mysql?.serverId) {
						serverId = backup.mysql.serverId;
					} else if (databaseType === "mongo" && backup.mongo?.serverId) {
						serverId = backup.mongo.serverId;
					} else if (databaseType === "mariadb" && backup.mariadb?.serverId) {
						serverId = backup.mariadb.serverId;
					} else if (databaseType === "libsql" && backup.libsql?.serverId) {
						serverId = backup.libsql.serverId;
					} else if (
						backup.backupType === "compose" &&
						backup.compose?.serverId
					) {
						serverId = backup.compose.serverId;
					}
					const server = await findServerById(serverId);

					if (server.serverStatus === "inactive") {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Server is inactive",
						});
					}
					await schedule({
						cronSchedule: backup.schedule,
						backupId: backup.backupId,
						type: "backup",
					});
				} else {
					if (backup.enabled) {
						scheduleBackup(backup);
					}
				}
				await audit(ctx, {
					action: "create",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
			} catch (error) {
				console.error(error);
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Error creating the Backup",
					cause: error,
				});
			}
		}),
	one: protectedProcedure
		.input(apiFindOneBackup)
		.query(async ({ input, ctx }) => {
			const backup = await findBackupById(input.backupId);
			await authorizeBackupAccess(ctx, backup, "read");

			return backup;
		}),
	update: protectedProcedure
		.input(apiUpdateBackup)
		.mutation(async ({ input, ctx }) => {
			const existing = await findBackupById(input.backupId);
			await authorizeBackupAccess(ctx, existing, "update");
			// Flipping a service backup to "web-server" (or back) would make the
			// cron run the instance backup from a row the service permission
			// governed. Changing the database kind inside a compose backup stays
			// possible as long as the row still matches its single service.
			if (
				(existing.databaseType === "web-server" ||
					input.databaseType === "web-server") &&
				input.databaseType !== existing.databaseType
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "An instance backup cannot be converted to or from a service backup.",
				});
			}
			const binding = validateBackupServiceBinding({
				...existing,
				databaseType: input.databaseType,
			});
			if (binding.error) {
				throw new TRPCError({ code: "BAD_REQUEST", message: binding.error });
			}
			await findDestinationByIdForOrganization(
				input.destinationId,
				ctx.session.activeOrganizationId,
			);

			try {
				// Saving an instance backup attributes it to the caller, which is
				// how a row whose creator no longer qualifies is repaired.
				await updateBackupById(
					input.backupId,
					isInstanceBackup(existing) ? { ...input, userId: ctx.user.id } : input,
				);
				const backup = await findBackupById(input.backupId);

				if (IS_CLOUD) {
					if (backup.enabled) {
						await updateJob({
							cronSchedule: backup.schedule,
							backupId: backup.backupId,
							type: "backup",
						});
					} else {
						await removeJob({
							cronSchedule: backup.schedule,
							backupId: backup.backupId,
							type: "backup",
						});
					}
				} else {
					if (backup.enabled) {
						removeScheduleBackup(input.backupId);
						scheduleBackup(backup);
					} else {
						removeScheduleBackup(input.backupId);
					}
				}
				await audit(ctx, {
					action: "update",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Error updating this Backup";
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),
	remove: protectedProcedure
		.input(apiRemoveBackup)
		.mutation(async ({ input, ctx }) => {
			const backup = await findBackupById(input.backupId);
			await authorizeBackupAccess(ctx, backup, "delete");

			try {
				const value = await removeBackupById(input.backupId);
				if (IS_CLOUD && value) {
					await removeJob({
						backupId: input.backupId,
						cronSchedule: value.schedule,
						type: "backup",
					});
				} else if (!IS_CLOUD) {
					removeScheduleBackup(input.backupId);
				}
				await audit(ctx, {
					action: "delete",
					resourceType: "backup",
					resourceId: input.backupId,
				});
				return value;
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Error deleting this Backup";
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),
	manualBackupPostgres: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			const backup = await findServiceBackupForRun(
				ctx,
				input.backupId,
				"postgresId",
			);
			try {
				const postgres = await findPostgresByBackupId(backup.backupId);
				await runPostgresBackup(postgres, backup);
				await keepLatestNBackups(backup, postgres?.serverId);
				await audit(ctx, {
					action: "run",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
				return true;
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Error running manual Postgres backup ";
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),

	manualBackupMySql: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			const backup = await findServiceBackupForRun(
				ctx,
				input.backupId,
				"mysqlId",
			);
			try {
				const mysql = await findMySqlByBackupId(backup.backupId);
				await runMySqlBackup(mysql, backup);
				await keepLatestNBackups(backup, mysql?.serverId);
				await audit(ctx, {
					action: "run",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual MySQL backup ",
					cause: error,
				});
			}
		}),
	manualBackupMariadb: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			const backup = await findServiceBackupForRun(
				ctx,
				input.backupId,
				"mariadbId",
			);
			try {
				const mariadb = await findMariadbByBackupId(backup.backupId);
				await runMariadbBackup(mariadb, backup);
				await keepLatestNBackups(backup, mariadb?.serverId);
				await audit(ctx, {
					action: "run",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual Mariadb backup ",
					cause: error,
				});
			}
		}),
	manualBackupCompose: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			const backup = await findServiceBackupForRun(
				ctx,
				input.backupId,
				"composeId",
			);
			try {
				const compose = await findComposeByBackupId(backup.backupId);
				await runComposeBackup(compose, backup);
				await keepLatestNBackups(backup, compose?.serverId);
				await audit(ctx, {
					action: "run",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual Compose backup ",
					cause: error,
				});
			}
		}),
	manualBackupMongo: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			const backup = await findServiceBackupForRun(
				ctx,
				input.backupId,
				"mongoId",
			);
			try {
				const mongo = await findMongoByBackupId(backup.backupId);
				await runMongoBackup(mongo, backup);
				await keepLatestNBackups(backup, mongo?.serverId);
				await audit(ctx, {
					action: "run",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual Mongo backup ",
					cause: error,
				});
			}
		}),
	manualBackupLibsql: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			const backup = await findServiceBackupForRun(
				ctx,
				input.backupId,
				"libsqlId",
			);
			try {
				const libsql = await findLibsqlByBackupId(backup.backupId);
				await runLibsqlBackup(libsql, backup);
				await keepLatestNBackups(backup, libsql?.serverId);
				await audit(ctx, {
					action: "run",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual Libsql backup ",
					cause: error,
				});
			}
		}),
	manualBackupWebServer: withPermission("backup", "create")
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			const backup = await findBackupById(input.backupId);
			if (backup.databaseType !== "web-server") {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Backup not found",
				});
			}
			await authorizeBackupAccess(ctx, backup, "create");
			await runWebServerBackup(backup);
			await keepLatestNBackups(backup);
			await audit(ctx, {
				action: "run",
				resourceType: "backup",
				resourceId: backup.backupId,
			});
			return true;
		}),
	listBackupFiles: withPermission("backup", "read")
		.input(
			z.object({
				destinationId: z.string(),
				search: z.string(),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			try {
				const destination = await findDestinationById(input.destinationId);
				if (destination.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this destination.",
					});
				}
				if (input.serverId) {
					const targetServer = await findServerById(input.serverId);
					if (
						targetServer.organizationId !== ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You don't have access to this server.",
						});
					}
				}
				const lastSlashIndex = input.search.lastIndexOf("/");
				const baseDir =
					lastSlashIndex !== -1
						? normalizeS3Path(input.search.slice(0, lastSlashIndex + 1))
						: "";
				const searchTerm =
					lastSlashIndex !== -1
						? input.search.slice(lastSlashIndex + 1)
						: input.search;

				// Encryption-aware: when the destination has rclone crypt enabled the
				// listing runs through the crypt remote so filenames come back decrypted.
				const {
					flags: rcloneFlags,
					path: searchPath,
					envVars,
				} = await getRclonePathAndFlags(destination, baseDir);
				const listCommand = buildRcloneCommand(
					`rclone lsjson ${rcloneFlags.join(" ")} ${quote([searchPath])} --no-mimetype --no-modtime 2>/dev/null`,
					envVars,
				);

				let stdout = "";

				if (input.serverId) {
					const result = await execAsyncRemote(input.serverId, listCommand);
					stdout = result.stdout;
				} else {
					const result = await execAsync(listCommand);
					stdout = result.stdout;
				}

				let files: RcloneFile[] = [];
				try {
					files = JSON.parse(stdout) as RcloneFile[];
				} catch (error) {
					console.error("Error parsing JSON response:", error);
					console.error("Raw stdout:", stdout);
					throw new Error("Failed to parse backup files list");
				}

				// Limit to first 100 files

				const results = baseDir
					? files.map((file) => ({
							...file,
							Path: `${baseDir}${file.Path}`,
						}))
					: files;

				if (searchTerm) {
					return results
						.filter((file) =>
							file.Path.toLowerCase().includes(searchTerm.toLowerCase()),
						)
						.slice(0, 100);
				}

				return results.slice(0, 100);
			} catch (error) {
				console.error("Error in listBackupFiles:", error);
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Error listing backup files",
					cause: error,
				});
			}
		}),

	// Lazy per-backup context for the Backup Center browser: everything the
	// client needs to (a) list the files under this backup's prefix via
	// `listBackupFiles` and (b) restore one of them via `restoreBackupWithLogs`,
	// without exposing the destination credentials. Read-gated on the owning
	// service; `canRestore` reflects the stricter restore permission so the UI
	// can hide the restore affordance for members who lack it (the restore
	// subscription re-checks it server-side regardless).
	backupContext: withPermission("backup", "read")
		.input(apiFindOneBackup)
		.query(async ({ input, ctx }) => {
			const backup = await findBackupById(input.backupId);
			await authorizeBackupAccess(ctx, backup, "read");
			const instanceBackup = isInstanceBackup(backup);
			const serviceId = instanceBackup ? "" : getBackupServiceId(backup) || "";

			if (
				backup.destination &&
				backup.destination.organizationId !== ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to this destination.",
				});
			}

			const serverId =
				backup.postgres?.serverId ??
				backup.mysql?.serverId ??
				backup.mariadb?.serverId ??
				backup.mongo?.serverId ??
				backup.libsql?.serverId ??
				backup.compose?.serverId ??
				null;

			// Instance backups were gated on the owner/admin role above.
			let canRestore = instanceBackup;
			if (serviceId) {
				try {
					await checkServicePermissionAndAccess(ctx, serviceId, {
						backup: ["restore"],
					});
					canRestore = true;
				} catch {
					canRestore = false;
				}
			}

			return {
				backupId: backup.backupId,
				databaseId: serviceId,
				backupType: backup.backupType,
				databaseType: backup.databaseType,
				databaseName: backup.database,
				serviceName: backup.serviceName ?? null,
				destinationId: backup.destinationId,
				destinationName: backup.destination?.name ?? "",
				prefix: backup.prefix,
				serverId,
				metadata: backup.metadata ?? null,
				canRestore,
			};
		}),

	restoreBackupWithLogs: protectedProcedure
		.meta({
			openapi: {
				enabled: false,
				path: "/restore-backup-with-logs",
				method: "POST",
				override: true,
			},
		})
		.input(apiRestoreBackup)
		.subscription(async function* ({ input, ctx, signal }) {
			const isInstanceRestore = input.databaseType === "web-server";
			if (isInstanceRestore) {
				// Restoring the instance overwrites the Dokploy base path and
				// database: an explicit owner/admin branch that never looks at
				// `databaseId`.
				if (input.backupType !== "database") {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "An instance restore must be a database backup.",
					});
				}
				assertInstanceBackupRole(ctx);
			} else {
				if (!input.databaseId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "A service id is required to restore a backup.",
					});
				}
				await checkServicePermissionAndAccess(ctx, input.databaseId, {
					backup: ["restore"],
				});
			}
			const destination = await findDestinationByIdForOrganization(
				input.destinationId,
				ctx.session.activeOrganizationId,
			);
			const queue: string[] = [];
			let done = false;
			const onLog = (log: string) => queue.push(log);
			const runRestore = async () => {
				if (isInstanceRestore) {
					await restoreWebServerBackup(destination, input.backupFile, onLog);
				} else if (input.backupType === "database") {
					if (input.databaseType === "postgres") {
						const postgres = await findPostgresById(input.databaseId);
						await restorePostgresBackup(postgres, destination, input, onLog);
					} else if (input.databaseType === "mysql") {
						const mysql = await findMySqlById(input.databaseId);
						await restoreMySqlBackup(mysql, destination, input, onLog);
					} else if (input.databaseType === "mariadb") {
						const mariadb = await findMariadbById(input.databaseId);
						await restoreMariadbBackup(mariadb, destination, input, onLog);
					} else if (input.databaseType === "mongo") {
						const mongo = await findMongoById(input.databaseId);
						await restoreMongoBackup(mongo, destination, input, onLog);
					} else if (input.databaseType === "libsql") {
						const libsql = await findLibsqlById(input.databaseId);
						await restoreLibsqlBackup(libsql, destination, input, onLog);
					}
				} else if (input.backupType === "compose") {
					const compose = await findComposeById(input.databaseId);
					await restoreComposeBackup(compose, destination, input, onLog);
				}
			};
			runRestore()
				.catch((error) => {
					onLog(
						`Error: ${error instanceof Error ? error.message : String(error)}`,
					);
				})
				.finally(() => {
					done = true;
				});
			while (!done || queue.length > 0) {
				if (queue.length > 0) {
					yield queue.shift()!;
				} else {
					await new Promise((r) => setTimeout(r, 50));
				}

				if (signal?.aborted) {
					return;
				}
			}
		}),
});
