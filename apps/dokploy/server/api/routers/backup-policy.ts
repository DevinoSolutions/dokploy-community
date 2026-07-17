import {
	createBackupPolicy,
	findBackupById,
	findBackupPolicyById,
	findLibsqlByBackupId,
	findMariadbByBackupId,
	findMongoByBackupId,
	findMySqlByBackupId,
	findPostgresByBackupId,
	keepLatestNBackups,
	removeBackupPolicy,
	runLibsqlBackup,
	runMariadbBackup,
	runMongoBackup,
	runMySqlBackup,
	runPostgresBackup,
	runVolumeBackup,
	syncBackupPolicy,
	toggleBackupPolicy,
	updateBackupPolicy,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { findDestinationById } from "@dokploy/server/services/destination";
import {
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateBackupPolicy,
	apiFindOneBackupPolicy,
	apiRemoveBackupPolicy,
	apiToggleBackupPolicy,
	apiUpdateBackupPolicy,
	applications,
	backupPolicies,
	backups,
	compose,
	deployments,
	environments,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	projects,
	redis,
	volumeBackups,
} from "@/server/db/schema";

// Service types surfaced in the coverage table. `dumpCapable` marks the types
// that support a database dump (postgres/mysql/mariadb/mongo/libsql). Redis,
// applications and compose are backed up via volumes only in v1.
const COVERAGE_SERVICE_TYPES = [
	"application",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"libsql",
	"redis",
	"compose",
] as const;
type CoverageServiceType = (typeof COVERAGE_SERVICE_TYPES)[number];

const DUMP_CAPABLE_TYPES: ReadonlySet<CoverageServiceType> = new Set([
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"libsql",
]);

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

// Mirrors the (unexported) `buildServiceFilter` in the project router: restrict
// a service relation to the ids a non-privileged member may access.
const buildServiceFilter = (
	fieldName: AnyPgColumn,
	accessedServices: string[],
): SQL =>
	accessedServices.length === 0
		? sql`false`
		: sql`${fieldName} IN (${sql.join(
				accessedServices.map((serviceId) => sql`${serviceId}`),
				sql`, `,
			)})`;

interface CoverageBackupEntry {
	backupId: string;
	source: "policy" | "manual";
	policyName?: string;
	destinationName: string;
	schedule: string;
	enabled: boolean;
	lastRunStatus?: string;
}

interface CoverageService {
	serviceId: string;
	type: CoverageServiceType;
	name: string;
	appName: string | null;
	serverId: string | null;
	project: { id: string; name: string };
	environment: { id: string; name: string };
	dumpCapable: boolean;
	dumpBackups: CoverageBackupEntry[];
	volumeBackups: CoverageBackupEntry[];
}

// The relational-query key each service type is loaded under on an environment.
const RELATION_KEY_BY_TYPE: Record<CoverageServiceType, string> = {
	application: "applications",
	postgres: "postgres",
	mysql: "mysql",
	mariadb: "mariadb",
	mongo: "mongo",
	libsql: "libsql",
	redis: "redis",
	compose: "compose",
};

const ID_COLUMN_BY_TYPE: Record<CoverageServiceType, string> = {
	application: "applicationId",
	postgres: "postgresId",
	mysql: "mysqlId",
	mariadb: "mariadbId",
	mongo: "mongoId",
	libsql: "libsqlId",
	redis: "redisId",
	compose: "composeId",
};

export const backupPolicyRouter = createTRPCRouter({
	// Org policies + per-policy coverage counts (materialized rows by kind) and
	// destination name. Org-scoped like `destination.all`.
	all: withPermission("backup", "read").query(async ({ ctx }) => {
		const policies = await db.query.backupPolicies.findMany({
			where: eq(
				backupPolicies.organizationId,
				ctx.session.activeOrganizationId,
			),
			orderBy: [desc(backupPolicies.createdAt)],
			with: {
				destination: { columns: { destinationId: true, name: true } },
				backups: { columns: { backupId: true, databaseType: true } },
				volumeBackups: {
					columns: { volumeBackupId: true, serviceType: true },
				},
			},
		});

		return policies.map((policy) => ({
			...policy,
			coverage: {
				dumpCount: policy.backups.length,
				volumeCount: policy.volumeBackups.length,
				total: policy.backups.length + policy.volumeBackups.length,
			},
		}));
	}),

	// A single policy with its destination and a summary of materialized rows.
	// Enforces org ownership like `destination.one`.
	one: withPermission("backup", "read")
		.input(apiFindOneBackupPolicy)
		.query(async ({ input, ctx }) => {
			const policy = await db.query.backupPolicies.findFirst({
				where: eq(backupPolicies.backupPolicyId, input.backupPolicyId),
				with: {
					destination: {
						columns: { accessKey: false, secretAccessKey: false },
					},
					backups: {
						columns: {
							backupId: true,
							databaseType: true,
							backupType: true,
							schedule: true,
							enabled: true,
							serviceName: true,
						},
					},
					volumeBackups: {
						columns: {
							volumeBackupId: true,
							serviceType: true,
							cronExpression: true,
							enabled: true,
							serviceName: true,
							volumeName: true,
						},
					},
				},
			});

			if (!policy) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Backup policy not found",
				});
			}
			if (policy.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You are not allowed to access this backup policy",
				});
			}
			return policy;
		}),

	create: withPermission("backup", "create")
		.input(apiCreateBackupPolicy)
		.mutation(async ({ input, ctx }) => {
			try {
				const destination = await findDestinationById(input.destinationId);
				if (destination.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "The destination does not belong to this organization",
					});
				}
				const policy = await createBackupPolicy(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "backup",
					resourceId: policy.backupPolicyId,
					resourceName: policy.name,
				});
				return policy;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the backup policy",
					cause: error,
				});
			}
		}),

	update: withPermission("backup", "update")
		.input(apiUpdateBackupPolicy)
		.mutation(async ({ input, ctx }) => {
			try {
				const existing = await findBackupPolicyById(input.backupPolicyId);
				if (!existing) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Backup policy not found",
					});
				}
				if (existing.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not allowed to update this backup policy",
					});
				}
				if (input.destinationId) {
					const destination = await findDestinationById(input.destinationId);
					if (destination.organizationId !== ctx.session.activeOrganizationId) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "The destination does not belong to this organization",
						});
					}
				}
				const policy = await updateBackupPolicy(input);
				await audit(ctx, {
					action: "update",
					resourceType: "backup",
					resourceId: input.backupPolicyId,
					resourceName: policy?.name,
				});
				return policy;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating the backup policy",
					cause: error,
				});
			}
		}),

	toggle: withPermission("backup", "update")
		.input(apiToggleBackupPolicy)
		.mutation(async ({ input, ctx }) => {
			try {
				const existing = await findBackupPolicyById(input.backupPolicyId);
				if (!existing) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Backup policy not found",
					});
				}
				if (existing.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not allowed to update this backup policy",
					});
				}
				const policy = await toggleBackupPolicy(
					input.backupPolicyId,
					input.enabled,
				);
				await audit(ctx, {
					action: "update",
					resourceType: "backup",
					resourceId: input.backupPolicyId,
					resourceName: policy?.name,
				});
				return policy;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error toggling the backup policy",
					cause: error,
				});
			}
		}),

	remove: withPermission("backup", "delete")
		.input(apiRemoveBackupPolicy)
		.mutation(async ({ input, ctx }) => {
			try {
				const existing = await findBackupPolicyById(input.backupPolicyId);
				if (!existing) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Backup policy not found",
					});
				}
				if (existing.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not allowed to delete this backup policy",
					});
				}
				const policy = await removeBackupPolicy(input.backupPolicyId, {
					deleteBackups: input.deleteBackups,
				});
				await audit(ctx, {
					action: "delete",
					resourceType: "backup",
					resourceId: input.backupPolicyId,
					resourceName: existing.name,
				});
				return policy;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error deleting the backup policy",
					cause: error,
				});
			}
		}),

	// Manual resync of a policy's materialized rows and cron registrations.
	sync: withPermission("backup", "update")
		.input(apiFindOneBackupPolicy)
		.mutation(async ({ input, ctx }) => {
			const existing = await findBackupPolicyById(input.backupPolicyId);
			if (!existing) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Backup policy not found",
				});
			}
			if (existing.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You are not allowed to sync this backup policy",
				});
			}
			await syncBackupPolicy(input.backupPolicyId);
			return findBackupPolicyById(input.backupPolicyId);
		}),

	// Streamed manual run over the policy's materialized rows. Mirrors the
	// observable pattern of `backup.restoreBackupWithLogs`: sequentially runs
	// each backup via the existing manual runners, CONTINUES past per-service
	// failures, and emits a per-service line plus a final summary. Never throws
	// mid-stream for a per-service failure.
	runNow: withPermission("backup", "create")
		.input(apiFindOneBackupPolicy)
		.subscription(async function* ({ input, ctx, signal }) {
			const policy = await findBackupPolicyById(input.backupPolicyId);
			if (!policy) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Backup policy not found",
				});
			}
			if (policy.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You are not allowed to run this backup policy",
				});
			}

			const dumpRows = await db.query.backups.findMany({
				where: eq(backups.backupPolicyId, input.backupPolicyId),
				columns: { backupId: true },
			});
			const volumeRows = await db.query.volumeBackups.findMany({
				where: eq(volumeBackups.backupPolicyId, input.backupPolicyId),
				columns: {
					volumeBackupId: true,
					serviceName: true,
					name: true,
					serviceType: true,
					applicationId: true,
					postgresId: true,
					mysqlId: true,
					mariadbId: true,
					mongoId: true,
					redisId: true,
					libsqlId: true,
					composeId: true,
				},
			});

			yield `Running backup policy "${policy.name}"`;
			yield `${dumpRows.length} database dump(s), ${volumeRows.length} volume backup(s)`;

			let succeeded = 0;
			let failed = 0;
			let skipped = 0;

			// A policy only materializes dump rows for the five dump-capable
			// database types; dispatch each through the same manual runner +
			// retention path the per-service tab uses.
			const runDump = async (
				backup: Awaited<ReturnType<typeof findBackupById>>,
			) => {
				switch (backup.databaseType) {
					case "postgres": {
						const service = await findPostgresByBackupId(backup.backupId);
						await runPostgresBackup(service, backup);
						await keepLatestNBackups(backup, service?.serverId);
						break;
					}
					case "mysql": {
						const service = await findMySqlByBackupId(backup.backupId);
						await runMySqlBackup(service, backup);
						await keepLatestNBackups(backup, service?.serverId);
						break;
					}
					case "mariadb": {
						const service = await findMariadbByBackupId(backup.backupId);
						await runMariadbBackup(service, backup);
						await keepLatestNBackups(backup, service?.serverId);
						break;
					}
					case "mongo": {
						const service = await findMongoByBackupId(backup.backupId);
						await runMongoBackup(service, backup);
						await keepLatestNBackups(backup, service?.serverId);
						break;
					}
					case "libsql": {
						const service = await findLibsqlByBackupId(backup.backupId);
						await runLibsqlBackup(service, backup);
						await keepLatestNBackups(backup, service?.serverId);
						break;
					}
					default:
						throw new Error(
							`Unsupported database type "${backup.databaseType}"`,
						);
				}
			};

			for (const { backupId } of dumpRows) {
				if (signal?.aborted) return;
				let label = backupId;
				try {
					const backup = await findBackupById(backupId);
					label = backup.serviceName ?? backup.database ?? backupId;
					// Parity with backup.manualBackup* endpoints: a member with
					// backup:create but restricted service access must not run
					// (or read the DB name/error output of) services they cannot
					// reach. Privileged members short-circuit inside the helper.
					const serviceId =
						backup.postgresId ||
						backup.mysqlId ||
						backup.mariadbId ||
						backup.mongoId ||
						backup.libsqlId ||
						backup.composeId;
					if (serviceId) {
						try {
							await checkServicePermissionAndAccess(ctx, serviceId, {
								backup: ["create"],
							});
						} catch {
							skipped++;
							yield `⊘ ${label} (${backup.databaseType} dump): skipped — no access to this service`;
							continue;
						}
					}
					await runDump(backup);
					succeeded++;
					yield `✓ ${label} (${backup.databaseType} dump)`;
				} catch (error) {
					failed++;
					yield `✗ ${label} (dump): ${errorMessage(error)}`;
				}
			}

			for (const volume of volumeRows) {
				if (signal?.aborted) return;
				const label = volume.serviceName ?? volume.name;
				// Same per-service gate as the dump rows above.
				const serviceId =
					volume.applicationId ||
					volume.postgresId ||
					volume.mysqlId ||
					volume.mariadbId ||
					volume.mongoId ||
					volume.redisId ||
					volume.libsqlId ||
					volume.composeId;
				if (serviceId) {
					try {
						await checkServicePermissionAndAccess(ctx, serviceId, {
							backup: ["create"],
						});
					} catch {
						skipped++;
						yield `⊘ ${label} (${volume.serviceType} volume): skipped — no access to this service`;
						continue;
					}
				}
				try {
					await runVolumeBackup(volume.volumeBackupId);
					succeeded++;
					yield `✓ ${label} (${volume.serviceType} volume)`;
				} catch (error) {
					failed++;
					yield `✗ ${label} (${volume.serviceType} volume): ${errorMessage(error)}`;
				}
			}

			// Keep the "N succeeded, M failed" prefix so the UI completion regex
			// still matches; append the skipped count only when non-zero.
			yield skipped > 0
				? `${succeeded} succeeded, ${failed} failed, ${skipped} skipped`
				: `${succeeded} succeeded, ${failed} failed`;
		}),

	// Org-wide coverage table for the Backup Center. Permission-filtered for
	// non-owner/admin members exactly like `project.all`.
	coverage: withPermission("backup", "read").query(async ({ ctx }) => {
		const organizationId = ctx.session.activeOrganizationId;
		const isPrivileged = ctx.user.role === "owner" || ctx.user.role === "admin";

		let accessedProjects: string[] = [];
		let accessedEnvironments: string[] = [];
		let accessedServices: string[] = [];

		if (!isPrivileged) {
			const member = await findMemberByUserId(ctx.user.id, organizationId);
			accessedProjects = member.accessedProjects;
			accessedEnvironments = member.accessedEnvironments;
			accessedServices = member.accessedServices;
			if (accessedProjects.length === 0) {
				return { services: [] as CoverageService[] };
			}
		}

		const projectWhere = isPrivileged
			? eq(projects.organizationId, organizationId)
			: and(
					sql`${projects.projectId} IN (${sql.join(
						accessedProjects.map((projectId) => sql`${projectId}`),
						sql`, `,
					)})`,
					eq(projects.organizationId, organizationId),
				);

		const environmentWhere = isPrivileged
			? undefined
			: accessedEnvironments.length === 0
				? sql`false`
				: sql`${environments.environmentId} IN (${sql.join(
						accessedEnvironments.map((envId) => sql`${envId}`),
						sql`, `,
					)})`;

		const serviceFilter = (fieldName: AnyPgColumn) =>
			isPrivileged
				? undefined
				: buildServiceFilter(fieldName, accessedServices);

		const serviceColumns = {
			name: true,
			appName: true,
			serverId: true,
		} as const;

		const projectRows = await db.query.projects.findMany({
			where: projectWhere,
			columns: { projectId: true, name: true },
			with: {
				environments: {
					where: environmentWhere,
					columns: { environmentId: true, name: true },
					with: {
						applications: {
							where: serviceFilter(applications.applicationId),
							columns: { applicationId: true, ...serviceColumns },
						},
						postgres: {
							where: serviceFilter(postgres.postgresId),
							columns: { postgresId: true, ...serviceColumns },
						},
						mysql: {
							where: serviceFilter(mysql.mysqlId),
							columns: { mysqlId: true, ...serviceColumns },
						},
						mariadb: {
							where: serviceFilter(mariadb.mariadbId),
							columns: { mariadbId: true, ...serviceColumns },
						},
						mongo: {
							where: serviceFilter(mongo.mongoId),
							columns: { mongoId: true, ...serviceColumns },
						},
						libsql: {
							where: serviceFilter(libsql.libsqlId),
							columns: { libsqlId: true, ...serviceColumns },
						},
						redis: {
							where: serviceFilter(redis.redisId),
							columns: { redisId: true, ...serviceColumns },
						},
						compose: {
							where: serviceFilter(compose.composeId),
							columns: { composeId: true, ...serviceColumns },
						},
					},
				},
			},
		});

		// Flatten the nested project → environment → service tree into a flat
		// list, tracking the owning project/environment for each service.
		const services: CoverageService[] = [];

		for (const project of projectRows) {
			for (const environment of project.environments) {
				const environmentRecord = environment as Record<string, unknown>;
				for (const type of COVERAGE_SERVICE_TYPES) {
					const rows = environmentRecord[RELATION_KEY_BY_TYPE[type]] as
						| Array<Record<string, unknown>>
						| undefined;
					if (!rows) continue;
					for (const row of rows) {
						services.push({
							serviceId: row[ID_COLUMN_BY_TYPE[type]] as string,
							type,
							name: row.name as string,
							appName: (row.appName as string) ?? null,
							serverId: (row.serverId as string) ?? null,
							project: { id: project.projectId, name: project.name },
							environment: {
								id: environment.environmentId,
								name: environment.name,
							},
							dumpCapable: DUMP_CAPABLE_TYPES.has(type),
							dumpBackups: [],
							volumeBackups: [],
						});
					}
				}
			}
		}

		if (services.length === 0) {
			return { services };
		}

		const serviceById = new Map<string, CoverageService>();
		for (const service of services) {
			serviceById.set(service.serviceId, service);
		}

		// Collect service ids per type so backup/volume-backup rows can be
		// fetched with a single OR-of-INARRAY filter per table.
		const idsByType: Record<CoverageServiceType, string[]> = {
			application: [],
			postgres: [],
			mysql: [],
			mariadb: [],
			mongo: [],
			libsql: [],
			redis: [],
			compose: [],
		};
		for (const service of services) {
			idsByType[service.type].push(service.serviceId);
		}

		const toEntry = (row: {
			id: string;
			schedule: string;
			enabled: boolean | null;
			backupPolicyId: string | null;
			destination?: { name: string } | null;
			backupPolicy?: { name: string } | null;
			deployments?: Array<{ status: string | null }>;
		}): CoverageBackupEntry => ({
			backupId: row.id,
			source: row.backupPolicyId ? "policy" : "manual",
			policyName: row.backupPolicy?.name,
			destinationName: row.destination?.name ?? "",
			schedule: row.schedule,
			enabled: row.enabled ?? false,
			lastRunStatus: row.deployments?.[0]?.status ?? undefined,
		});

		// --- Database dump backups ---
		const dumpConditions: SQL[] = [];
		if (idsByType.postgres.length)
			dumpConditions.push(inArray(backups.postgresId, idsByType.postgres));
		if (idsByType.mysql.length)
			dumpConditions.push(inArray(backups.mysqlId, idsByType.mysql));
		if (idsByType.mariadb.length)
			dumpConditions.push(inArray(backups.mariadbId, idsByType.mariadb));
		if (idsByType.mongo.length)
			dumpConditions.push(inArray(backups.mongoId, idsByType.mongo));
		if (idsByType.libsql.length)
			dumpConditions.push(inArray(backups.libsqlId, idsByType.libsql));
		if (idsByType.compose.length)
			dumpConditions.push(inArray(backups.composeId, idsByType.compose));

		if (dumpConditions.length) {
			const dumpRows = await db.query.backups.findMany({
				where: or(...dumpConditions),
				columns: {
					backupId: true,
					schedule: true,
					enabled: true,
					backupPolicyId: true,
					postgresId: true,
					mysqlId: true,
					mariadbId: true,
					mongoId: true,
					libsqlId: true,
					composeId: true,
				},
				with: {
					destination: { columns: { name: true } },
					backupPolicy: { columns: { name: true } },
					deployments: {
						columns: { status: true },
						orderBy: [desc(deployments.createdAt)],
						limit: 1,
					},
				},
			});
			for (const row of dumpRows) {
				const serviceId =
					row.postgresId ||
					row.mysqlId ||
					row.mariadbId ||
					row.mongoId ||
					row.libsqlId ||
					row.composeId;
				if (!serviceId) continue;
				const service = serviceById.get(serviceId);
				if (!service) continue;
				service.dumpBackups.push(
					toEntry({ ...row, id: row.backupId, schedule: row.schedule }),
				);
			}
		}

		// --- Volume backups ---
		const volumeConditions: SQL[] = [];
		if (idsByType.application.length)
			volumeConditions.push(
				inArray(volumeBackups.applicationId, idsByType.application),
			);
		if (idsByType.postgres.length)
			volumeConditions.push(
				inArray(volumeBackups.postgresId, idsByType.postgres),
			);
		if (idsByType.mysql.length)
			volumeConditions.push(inArray(volumeBackups.mysqlId, idsByType.mysql));
		if (idsByType.mariadb.length)
			volumeConditions.push(
				inArray(volumeBackups.mariadbId, idsByType.mariadb),
			);
		if (idsByType.mongo.length)
			volumeConditions.push(inArray(volumeBackups.mongoId, idsByType.mongo));
		if (idsByType.libsql.length)
			volumeConditions.push(inArray(volumeBackups.libsqlId, idsByType.libsql));
		if (idsByType.redis.length)
			volumeConditions.push(inArray(volumeBackups.redisId, idsByType.redis));
		if (idsByType.compose.length)
			volumeConditions.push(
				inArray(volumeBackups.composeId, idsByType.compose),
			);

		if (volumeConditions.length) {
			const volumeRows = await db.query.volumeBackups.findMany({
				where: or(...volumeConditions),
				columns: {
					volumeBackupId: true,
					cronExpression: true,
					enabled: true,
					backupPolicyId: true,
					applicationId: true,
					postgresId: true,
					mysqlId: true,
					mariadbId: true,
					mongoId: true,
					libsqlId: true,
					redisId: true,
					composeId: true,
				},
				with: {
					destination: { columns: { name: true } },
					backupPolicy: { columns: { name: true } },
					deployments: {
						columns: { status: true },
						orderBy: [desc(deployments.createdAt)],
						limit: 1,
					},
				},
			});
			for (const row of volumeRows) {
				const serviceId =
					row.applicationId ||
					row.postgresId ||
					row.mysqlId ||
					row.mariadbId ||
					row.mongoId ||
					row.libsqlId ||
					row.redisId ||
					row.composeId;
				if (!serviceId) continue;
				const service = serviceById.get(serviceId);
				if (!service) continue;
				service.volumeBackups.push(
					toEntry({
						...row,
						id: row.volumeBackupId,
						schedule: row.cronExpression,
					}),
				);
			}
		}

		return { services };
	}),
});
