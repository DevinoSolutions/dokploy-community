import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { IS_CLOUD } from "../constants";
import { db } from "../db";
import {
	type apiCreateBackupPolicy,
	type apiUpdateBackupPolicy,
	type BackupPolicyServiceType,
	backupPolicies,
	backups,
	environments,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	volumeBackups,
} from "../db/schema";
import { applications } from "../db/schema/application";
import { compose } from "../db/schema/compose";
import { redis } from "../db/schema/redis";
import { removeScheduleBackup, scheduleBackup } from "../utils/backups/utils";
import {
	removeVolumeBackupJob,
	scheduleVolumeBackup,
} from "../utils/volume-backups/utils";
import { findBackupById } from "./backup";
import { findMountsByApplicationId } from "./mount";

export type BackupPolicy = typeof backupPolicies.$inferSelect;

// Service types that can be backed up via a database dump. Compose is
// intentionally excluded in v1 — per-DB dump credentials/metadata cannot be
// inferred from a policy, so compose is covered via volumes only.
export const DUMP_SERVICE_TYPES = [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"libsql",
] as const;
export type DumpServiceType = (typeof DUMP_SERVICE_TYPES)[number];

// ---------------------------------------------------------------------------
// Pure helpers (no DB access) — kept side-effect free so the diff/prefix logic
// can be unit-tested without a database.
// ---------------------------------------------------------------------------

const sanitizePrefixSegment = (value: string) =>
	value
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");

/**
 * Deterministic S3 prefix for a policy-managed row:
 * `<basePrefix>/<projectName>/<serviceName>`. Names are sanitized to safe path
 * segments. Uniqueness across same-named services is guaranteed downstream by
 * the runner, which prepends each service's unique `appName` to the S3 path.
 * Always returns a non-empty string (falls back to the service name).
 */
export const computeServicePrefix = (
	basePrefix: string | null | undefined,
	projectName: string,
	serviceName: string,
): string => {
	const base = (basePrefix ?? "").trim().replace(/^\/+|\/+$/g, "");
	const segments = [
		...base.split("/").map((s) => sanitizePrefixSegment(s)),
		sanitizePrefixSegment(projectName),
		sanitizePrefixSegment(serviceName),
	].filter(Boolean);
	return segments.length > 0
		? segments.join("/")
		: sanitizePrefixSegment(serviceName) || "backup";
};

export interface MaterializedRowPlan<TInsert> {
	/** Stable identity of the desired row within one policy. */
	key: string;
	/** Values to insert when the row is missing. */
	insert: TInsert;
	/** Subset of fields compared to detect drift on existing rows. */
	compare: Record<string, unknown>;
}

export interface ExistingMaterializedRow {
	id: string;
	key: string;
	compare: Record<string, unknown>;
}

export interface MaterializationDiff<TInsert> {
	toCreate: MaterializedRowPlan<TInsert>[];
	toUpdate: { id: string; insert: TInsert }[];
	toDelete: string[];
}

const shallowEqual = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
): boolean => {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		if ((a[key] ?? null) !== (b[key] ?? null)) return false;
	}
	return true;
};

/**
 * Pure diff between the desired materialized rows and the rows currently tagged
 * with a policy. Returns create/update/delete sets keyed by
 * {@link MaterializedRowPlan.key}. No DB access — safe to unit-test directly.
 */
export const diffMaterializedRows = <TInsert>(
	desired: MaterializedRowPlan<TInsert>[],
	existing: ExistingMaterializedRow[],
): MaterializationDiff<TInsert> => {
	const existingByKey = new Map(existing.map((row) => [row.key, row]));
	const desiredKeys = new Set(desired.map((row) => row.key));

	const toCreate: MaterializedRowPlan<TInsert>[] = [];
	const toUpdate: { id: string; insert: TInsert }[] = [];

	for (const plan of desired) {
		const current = existingByKey.get(plan.key);
		if (!current) {
			toCreate.push(plan);
			continue;
		}
		if (!shallowEqual(plan.compare, current.compare)) {
			toUpdate.push({ id: current.id, insert: plan.insert });
		}
	}

	const toDelete = existing
		.filter((row) => !desiredKeys.has(row.key))
		.map((row) => row.id);

	return { toCreate, toUpdate, toDelete };
};

const resolveDumpDatabaseName = (
	type: DumpServiceType,
	service: { name: string; databaseName?: string | null },
): string => {
	if (type === "mongo") {
		// mongodump backs up the whole instance; no single database name applies.
		return "";
	}
	if (type === "libsql") {
		// libsql has no first-class database name; fall back to the service name.
		return service.name;
	}
	return service.databaseName ?? "";
};

// ---------------------------------------------------------------------------
// Cloud cron dispatch. In cloud mode cron jobs live in a separate jobs service
// reached over HTTP; self-hosted registers jobs in-process. Mirrors
// apps/dokploy/server/utils/backup.ts (which cannot be imported from this
// layer).
// ---------------------------------------------------------------------------

type CloudJob =
	| { type: "backup"; cronSchedule: string; backupId: string }
	| { type: "volume-backup"; cronSchedule: string; volumeBackupId: string };

const postCloudJob = async (
	endpoint: "create-backup" | "remove-job" | "update-backup",
	job: CloudJob,
) => {
	await fetch(`${process.env.JOBS_URL}/${endpoint}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-API-Key": process.env.API_KEY || "NO-DEFINED",
		},
		body: JSON.stringify(job),
	});
};

const registerBackupCron = async (backupId: string) => {
	const backup = await findBackupById(backupId);
	if (!backup.enabled) return;
	if (IS_CLOUD) {
		await postCloudJob("create-backup", {
			type: "backup",
			cronSchedule: backup.schedule,
			backupId,
		});
	} else {
		scheduleBackup(backup);
	}
};

const unregisterBackupCron = async (backupId: string, schedule: string) => {
	if (IS_CLOUD) {
		await postCloudJob("remove-job", {
			type: "backup",
			cronSchedule: schedule,
			backupId,
		});
	} else {
		removeScheduleBackup(backupId);
	}
};

const registerVolumeCron = async (
	volumeBackupId: string,
	cronExpression: string,
	enabled: boolean | null,
) => {
	if (!enabled) return;
	if (IS_CLOUD) {
		await postCloudJob("create-backup", {
			type: "volume-backup",
			cronSchedule: cronExpression,
			volumeBackupId,
		});
	} else {
		await scheduleVolumeBackup(volumeBackupId);
	}
};

const unregisterVolumeCron = async (
	volumeBackupId: string,
	cronExpression: string,
) => {
	if (IS_CLOUD) {
		await postCloudJob("remove-job", {
			type: "volume-backup",
			cronSchedule: cronExpression,
			volumeBackupId,
		});
	} else {
		await removeVolumeBackupJob(volumeBackupId);
	}
};

// ---------------------------------------------------------------------------
// Scope + service enumeration.
// ---------------------------------------------------------------------------

interface ScopedService {
	id: string;
	name: string;
	appName: string;
	environmentId: string;
	serverId: string | null;
	databaseName?: string | null;
	projectName: string;
}

/**
 * Resolve the set of environments a policy covers, mapped to their project
 * name (used for prefixes). Every environment is re-checked against the
 * policy's organization, so a stale/foreign scope id can never leak services
 * from another org.
 */
const resolveScopeEnvironments = async (
	policy: BackupPolicy,
): Promise<Map<string, { projectName: string }>> => {
	const projectWith = {
		project: { columns: { name: true, organizationId: true } },
	} as const;

	type ScopeEnvironmentRow = {
		environmentId: string;
		project: { name: string; organizationId: string } | null;
	};

	let rows: ScopeEnvironmentRow[];

	if (policy.scopeType === "organization") {
		rows = (await db.query.environments.findMany({
			columns: { environmentId: true },
			with: projectWith,
		})) as ScopeEnvironmentRow[];
	} else if (policy.scopeType === "projects") {
		if (policy.scopeIds.length === 0) return new Map();
		rows = (await db.query.environments.findMany({
			columns: { environmentId: true },
			with: projectWith,
			where: inArray(environments.projectId, policy.scopeIds),
		})) as ScopeEnvironmentRow[];
	} else {
		if (policy.scopeIds.length === 0) return new Map();
		rows = (await db.query.environments.findMany({
			columns: { environmentId: true },
			with: projectWith,
			where: inArray(environments.environmentId, policy.scopeIds),
		})) as ScopeEnvironmentRow[];
	}

	const map = new Map<string, { projectName: string }>();
	for (const row of rows) {
		if (row.project?.organizationId !== policy.organizationId) continue;
		map.set(row.environmentId, { projectName: row.project.name });
	}
	return map;
};

const wantsServiceType = (
	policy: BackupPolicy,
	type: BackupPolicyServiceType,
) =>
	policy.serviceTypeFilter.length === 0 ||
	policy.serviceTypeFilter.includes(type);

interface EnumeratedServices {
	// keyed by dump service type
	dump: Partial<Record<DumpServiceType, ScopedService[]>>;
	// keyed by any service type
	volume: Partial<Record<BackupPolicyServiceType, ScopedService[]>>;
}

const SERVICE_TABLES: Record<
	BackupPolicyServiceType,
	{ table: unknown; pk: string }
> = {
	application: { table: applications, pk: "applicationId" },
	postgres: { table: postgres, pk: "postgresId" },
	mysql: { table: mysql, pk: "mysqlId" },
	mariadb: { table: mariadb, pk: "mariadbId" },
	mongo: { table: mongo, pk: "mongoId" },
	redis: { table: redis, pk: "redisId" },
	libsql: { table: libsql, pk: "libsqlId" },
	compose: { table: compose, pk: "composeId" },
};

const loadScopedServices = async (
	type: BackupPolicyServiceType,
	envIds: string[],
	envMap: Map<string, { projectName: string }>,
): Promise<ScopedService[]> => {
	const { table, pk } = SERVICE_TABLES[type];
	const includeDatabaseName =
		type === "postgres" || type === "mysql" || type === "mariadb";
	// Heterogeneous service tables are looked up dynamically by service type;
	// the concrete row shape is narrowed via the Record cast below.
	const anyTable = table as any;
	const rows = (await db
		.select({
			id: anyTable[pk],
			name: anyTable.name,
			appName: anyTable.appName,
			environmentId: anyTable.environmentId,
			serverId: anyTable.serverId,
			...(includeDatabaseName ? { databaseName: anyTable.databaseName } : {}),
		})
		.from(anyTable)
		.where(inArray(anyTable.environmentId, envIds))) as Array<
		Record<string, unknown>
	>;
	return rows.map((row) => ({
		id: row.id as string,
		name: row.name as string,
		appName: row.appName as string,
		environmentId: row.environmentId as string,
		serverId: (row.serverId as string | null) ?? null,
		databaseName: (row.databaseName as string | null) ?? null,
		projectName: envMap.get(row.environmentId as string)?.projectName ?? "",
	}));
};

const enumerateServices = async (
	policy: BackupPolicy,
	envIds: string[],
	envMap: Map<string, { projectName: string }>,
): Promise<EnumeratedServices> => {
	const result: EnumeratedServices = { dump: {}, volume: {} };
	if (envIds.length === 0) return result;

	const allTypes: BackupPolicyServiceType[] = [
		"application",
		"postgres",
		"mysql",
		"mariadb",
		"mongo",
		"redis",
		"libsql",
		"compose",
	];

	for (const type of allTypes) {
		if (!wantsServiceType(policy, type)) continue;
		const services = await loadScopedServices(type, envIds, envMap);
		if (policy.includeVolumes) {
			result.volume[type] = services;
		}
		if (
			policy.includeDatabases &&
			(DUMP_SERVICE_TYPES as readonly string[]).includes(type)
		) {
			result.dump[type as DumpServiceType] = services;
		}
	}

	return result;
};

// ---------------------------------------------------------------------------
// Desired-row construction.
// ---------------------------------------------------------------------------

type BackupInsert = typeof backups.$inferInsert;
type VolumeInsert = typeof volumeBackups.$inferInsert;

const buildDesiredBackupRows = (
	policy: BackupPolicy,
	enumerated: EnumeratedServices,
): MaterializedRowPlan<BackupInsert>[] => {
	const plans: MaterializedRowPlan<BackupInsert>[] = [];
	for (const type of DUMP_SERVICE_TYPES) {
		const services = enumerated.dump[type];
		if (!services) continue;
		for (const service of services) {
			const prefix = computeServicePrefix(
				policy.prefix,
				service.projectName,
				service.name,
			);
			const database = resolveDumpDatabaseName(type, service);
			const insert: BackupInsert = {
				schedule: policy.schedule,
				enabled: policy.enabled,
				database,
				prefix,
				serviceName: service.name,
				destinationId: policy.destinationId,
				keepLatestCount: policy.keepLatestCount ?? null,
				backupType: "database",
				databaseType: type,
				backupPolicyId: policy.backupPolicyId,
			};
			(insert as Record<string, unknown>)[`${type}Id`] = service.id;
			plans.push({
				key: `db:${type}:${service.id}`,
				insert,
				compare: {
					schedule: policy.schedule,
					destinationId: policy.destinationId,
					prefix,
					keepLatestCount: policy.keepLatestCount ?? null,
					enabled: policy.enabled,
					database,
				},
			});
		}
	}
	return plans;
};

const buildDesiredVolumeRows = async (
	policy: BackupPolicy,
	enumerated: EnumeratedServices,
): Promise<MaterializedRowPlan<VolumeInsert>[]> => {
	const plans: MaterializedRowPlan<VolumeInsert>[] = [];
	for (const type of Object.keys(
		enumerated.volume,
	) as BackupPolicyServiceType[]) {
		const services = enumerated.volume[type];
		if (!services) continue;
		for (const service of services) {
			const mounts = await findMountsByApplicationId(service.id, type);
			const namedVolumes = mounts
				.filter((mount) => mount.type === "volume" && mount.volumeName)
				.map((mount) => mount.volumeName as string);
			// De-duplicate volume names (defensive; a service should not declare the
			// same named volume twice).
			for (const volumeName of [...new Set(namedVolumes)]) {
				const prefix = computeServicePrefix(
					policy.prefix,
					service.projectName,
					service.name,
				);
				const insert: VolumeInsert = {
					name: `${service.name} - ${volumeName}`,
					volumeName,
					prefix,
					serviceType: type,
					serviceName: service.name,
					turnOff: false,
					cronExpression: policy.schedule,
					keepLatestCount: policy.keepLatestCount ?? null,
					enabled: policy.enabled,
					destinationId: policy.destinationId,
					backupPolicyId: policy.backupPolicyId,
				};
				(insert as Record<string, unknown>)[`${type}Id`] = service.id;
				plans.push({
					key: `vol:${type}:${service.id}:${volumeName}`,
					insert,
					compare: {
						cronExpression: policy.schedule,
						destinationId: policy.destinationId,
						prefix,
						keepLatestCount: policy.keepLatestCount ?? null,
						enabled: policy.enabled,
					},
				});
			}
		}
	}
	return plans;
};

// ---------------------------------------------------------------------------
// Sync engine.
// ---------------------------------------------------------------------------

export interface SyncSummary {
	backupsCreated: number;
	backupsUpdated: number;
	backupsDeleted: number;
	volumesCreated: number;
	volumesUpdated: number;
	volumesDeleted: number;
	errors: string[];
}

/**
 * Reconcile a policy's materialized `backup` / `volume_backup` rows and their
 * cron registrations with the policy's current scope and settings. Idempotent,
 * re-runnable, and safe on an empty scope. Never throws — per-row failures are
 * collected and recorded on the policy's `lastSyncError`, so a partial failure
 * never blocks the caller (service create/update, hooks).
 */
export const syncBackupPolicy = async (
	policyId: string,
): Promise<SyncSummary> => {
	const summary: SyncSummary = {
		backupsCreated: 0,
		backupsUpdated: 0,
		backupsDeleted: 0,
		volumesCreated: 0,
		volumesUpdated: 0,
		volumesDeleted: 0,
		errors: [],
	};

	const policy = await db.query.backupPolicies.findFirst({
		where: eq(backupPolicies.backupPolicyId, policyId),
	});
	if (!policy) return summary;

	try {
		const envMap = await resolveScopeEnvironments(policy);
		const envIds = [...envMap.keys()];
		const enumerated = await enumerateServices(policy, envIds, envMap);

		const desiredBackups = buildDesiredBackupRows(policy, enumerated);
		const desiredVolumes = await buildDesiredVolumeRows(policy, enumerated);

		// ----- database dump backups -----
		const existingBackupRows = await db.query.backups.findMany({
			where: eq(backups.backupPolicyId, policyId),
		});
		const existingBackups: ExistingMaterializedRow[] = existingBackupRows.map(
			(row) => ({
				id: row.backupId,
				key: dumpRowKey(row),
				compare: {
					schedule: row.schedule,
					destinationId: row.destinationId,
					prefix: row.prefix,
					keepLatestCount: row.keepLatestCount ?? null,
					enabled: row.enabled ?? null,
					database: row.database,
				},
			}),
		);
		const backupDiff = diffMaterializedRows(desiredBackups, existingBackups);
		const backupScheduleById = new Map(
			existingBackupRows.map((row) => [row.backupId, row.schedule]),
		);

		for (const id of backupDiff.toDelete) {
			await runStep(summary, async () => {
				await unregisterBackupCron(id, backupScheduleById.get(id) ?? "");
				await db.delete(backups).where(eq(backups.backupId, id));
				summary.backupsDeleted += 1;
			});
		}
		for (const plan of backupDiff.toCreate) {
			await runStep(summary, async () => {
				const inserted = await db
					.insert(backups)
					.values(plan.insert)
					.returning();
				const backupId = inserted[0]?.backupId;
				if (backupId) await registerBackupCron(backupId);
				summary.backupsCreated += 1;
			});
		}
		for (const update of backupDiff.toUpdate) {
			await runStep(summary, async () => {
				await db
					.update(backups)
					.set({
						schedule: update.insert.schedule,
						destinationId: update.insert.destinationId,
						prefix: update.insert.prefix,
						keepLatestCount: update.insert.keepLatestCount ?? null,
						enabled: update.insert.enabled,
						database: update.insert.database,
					})
					.where(eq(backups.backupId, update.id));
				await unregisterBackupCron(
					update.id,
					backupScheduleById.get(update.id) ?? "",
				);
				await registerBackupCron(update.id);
				summary.backupsUpdated += 1;
			});
		}

		// ----- volume backups -----
		const existingVolumeRows = await db.query.volumeBackups.findMany({
			where: eq(volumeBackups.backupPolicyId, policyId),
		});
		const existingVolumes: ExistingMaterializedRow[] = existingVolumeRows.map(
			(row) => ({
				id: row.volumeBackupId,
				key: volumeRowKey(row),
				compare: {
					cronExpression: row.cronExpression,
					destinationId: row.destinationId,
					prefix: row.prefix,
					keepLatestCount: row.keepLatestCount ?? null,
					enabled: row.enabled ?? null,
				},
			}),
		);
		const volumeDiff = diffMaterializedRows(desiredVolumes, existingVolumes);
		const volumeCronById = new Map(
			existingVolumeRows.map((row) => [row.volumeBackupId, row.cronExpression]),
		);

		for (const id of volumeDiff.toDelete) {
			await runStep(summary, async () => {
				await unregisterVolumeCron(id, volumeCronById.get(id) ?? "");
				await db
					.delete(volumeBackups)
					.where(eq(volumeBackups.volumeBackupId, id));
				summary.volumesDeleted += 1;
			});
		}
		for (const plan of volumeDiff.toCreate) {
			await runStep(summary, async () => {
				const inserted = await db
					.insert(volumeBackups)
					.values(plan.insert)
					.returning();
				const created = inserted[0];
				if (created) {
					await registerVolumeCron(
						created.volumeBackupId,
						created.cronExpression,
						created.enabled,
					);
				}
				summary.volumesCreated += 1;
			});
		}
		for (const update of volumeDiff.toUpdate) {
			await runStep(summary, async () => {
				await db
					.update(volumeBackups)
					.set({
						cronExpression: update.insert.cronExpression,
						destinationId: update.insert.destinationId,
						prefix: update.insert.prefix,
						keepLatestCount: update.insert.keepLatestCount ?? null,
						enabled: update.insert.enabled,
					})
					.where(eq(volumeBackups.volumeBackupId, update.id));
				await unregisterVolumeCron(
					update.id,
					volumeCronById.get(update.id) ?? "",
				);
				await registerVolumeCron(
					update.id,
					update.insert.cronExpression,
					update.insert.enabled ?? null,
				);
				summary.volumesUpdated += 1;
			});
		}
	} catch (error) {
		summary.errors.push(error instanceof Error ? error.message : String(error));
	}

	const lastSyncError =
		summary.errors.length > 0 ? summary.errors.join("; ") : null;
	if (lastSyncError) {
		console.error(`[BackupPolicy] Sync errors for ${policyId}:`, lastSyncError);
	}
	await db
		.update(backupPolicies)
		.set({ lastSyncError })
		.where(eq(backupPolicies.backupPolicyId, policyId));

	return summary;
};

const runStep = async (summary: SyncSummary, step: () => Promise<void>) => {
	try {
		await step();
	} catch (error) {
		summary.errors.push(error instanceof Error ? error.message : String(error));
	}
};

const dumpRowKey = (row: {
	databaseType: string;
	postgresId: string | null;
	mysqlId: string | null;
	mariadbId: string | null;
	mongoId: string | null;
	libsqlId: string | null;
}): string => {
	const type = row.databaseType as DumpServiceType;
	const serviceId =
		row.postgresId ??
		row.mysqlId ??
		row.mariadbId ??
		row.mongoId ??
		row.libsqlId ??
		"";
	return `db:${type}:${serviceId}`;
};

const volumeRowKey = (row: {
	serviceType: string;
	volumeName: string;
	applicationId: string | null;
	postgresId: string | null;
	mysqlId: string | null;
	mariadbId: string | null;
	mongoId: string | null;
	redisId: string | null;
	libsqlId: string | null;
	composeId: string | null;
}): string => {
	const serviceId =
		row.applicationId ??
		row.postgresId ??
		row.mysqlId ??
		row.mariadbId ??
		row.mongoId ??
		row.redisId ??
		row.libsqlId ??
		row.composeId ??
		"";
	return `vol:${row.serviceType}:${serviceId}:${row.volumeName}`;
};

// ---------------------------------------------------------------------------
// CRUD.
// ---------------------------------------------------------------------------

export const findBackupPolicyById = async (
	backupPolicyId: string,
): Promise<BackupPolicy | undefined> =>
	db.query.backupPolicies.findFirst({
		where: eq(backupPolicies.backupPolicyId, backupPolicyId),
	});

export const findBackupPoliciesByOrganizationId = async (
	organizationId: string,
): Promise<BackupPolicy[]> =>
	db.query.backupPolicies.findMany({
		where: eq(backupPolicies.organizationId, organizationId),
	});

export const createBackupPolicy = async (
	input: z.infer<typeof apiCreateBackupPolicy>,
	organizationId: string,
): Promise<BackupPolicy> => {
	const inserted = await db
		.insert(backupPolicies)
		.values({ ...input, organizationId } as typeof backupPolicies.$inferInsert)
		.returning();
	const policy = inserted[0];
	if (!policy) {
		throw new Error("Error creating the backup policy");
	}
	await syncBackupPolicy(policy.backupPolicyId);
	return policy;
};

export const updateBackupPolicy = async (
	input: z.infer<typeof apiUpdateBackupPolicy>,
): Promise<BackupPolicy | undefined> => {
	const { backupPolicyId, ...rest } = input;
	const updated = await db
		.update(backupPolicies)
		.set(rest)
		.where(eq(backupPolicies.backupPolicyId, backupPolicyId))
		.returning();
	await syncBackupPolicy(backupPolicyId);
	return updated[0];
};

export const toggleBackupPolicy = async (
	backupPolicyId: string,
	enabled: boolean,
): Promise<BackupPolicy | undefined> => {
	const updated = await db
		.update(backupPolicies)
		.set({ enabled })
		.where(eq(backupPolicies.backupPolicyId, backupPolicyId))
		.returning();
	await syncBackupPolicy(backupPolicyId);
	return updated[0];
};

/**
 * Delete a policy. By default the materialized rows are demoted to manual
 * backups (the FK is set null and their crons keep running). When
 * `deleteBackups` is set, the tagged rows are unscheduled and deleted first.
 */
export const removeBackupPolicy = async (
	backupPolicyId: string,
	options?: { deleteBackups?: boolean },
): Promise<BackupPolicy | undefined> => {
	if (options?.deleteBackups) {
		const backupRows = await db.query.backups.findMany({
			where: eq(backups.backupPolicyId, backupPolicyId),
		});
		for (const row of backupRows) {
			await unregisterBackupCron(row.backupId, row.schedule);
			await db.delete(backups).where(eq(backups.backupId, row.backupId));
		}
		const volumeRows = await db.query.volumeBackups.findMany({
			where: eq(volumeBackups.backupPolicyId, backupPolicyId),
		});
		for (const row of volumeRows) {
			await unregisterVolumeCron(row.volumeBackupId, row.cronExpression);
			await db
				.delete(volumeBackups)
				.where(eq(volumeBackups.volumeBackupId, row.volumeBackupId));
		}
	}
	const deleted = await db
		.delete(backupPolicies)
		.where(eq(backupPolicies.backupPolicyId, backupPolicyId))
		.returning();
	return deleted[0];
};

// ---------------------------------------------------------------------------
// Service-lifecycle hooks. Fire-and-forget: a new/removed service triggers a
// resync of the org's enabled policies so coverage stays current. Never blocks
// or fails the originating service operation.
// ---------------------------------------------------------------------------

export const syncOrganizationBackupPolicies = async (
	organizationId: string,
): Promise<void> => {
	const policies = await db.query.backupPolicies.findMany({
		where: and(
			eq(backupPolicies.organizationId, organizationId),
			eq(backupPolicies.enabled, true),
		),
	});
	for (const policy of policies) {
		await syncBackupPolicy(policy.backupPolicyId);
	}
};

/**
 * Fire-and-forget resync of the org's enabled policies after a covered service
 * is created or deleted. Resolves the org from the environment. Errors are
 * logged and swallowed — service create/delete must never block on policy
 * sync.
 */
export const resyncBackupPoliciesForEnvironment = (
	environmentId: string,
): void => {
	void (async () => {
		try {
			const environment = await db.query.environments.findFirst({
				where: eq(environments.environmentId, environmentId),
				with: { project: { columns: { organizationId: true } } },
			});
			const organizationId = environment?.project?.organizationId;
			if (!organizationId) return;
			await syncOrganizationBackupPolicies(organizationId);
		} catch (error) {
			console.error(
				"[BackupPolicy] Failed to resync policies after service change",
				error,
			);
		}
	})();
};
