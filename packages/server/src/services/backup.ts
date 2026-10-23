import { db } from "@dokploy/server/db";
import {
	type apiCreateBackup,
	backups,
	member,
} from "@dokploy/server/db/schema";
import { findDestinationById } from "@dokploy/server/services/destination";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";

export type Backup = typeof backups.$inferSelect;

export type BackupSchedule = Awaited<ReturnType<typeof findBackupById>>;
export type BackupScheduleList = Awaited<ReturnType<typeof findBackupsByDbId>>;
export const createBackup = async (input: z.infer<typeof apiCreateBackup>) => {
	const newBackup = await db
		.insert(backups)
		.values({ ...input } as typeof backups.$inferInsert)
		.returning()
		.then((value) => value[0]);

	if (!newBackup) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the Backup",
		});
	}

	return newBackup;
};

export const findBackupById = async (backupId: string) => {
	const backup = await db.query.backups.findFirst({
		where: eq(backups.backupId, backupId),
		with: {
			postgres: true,
			mysql: true,
			mariadb: true,
			mongo: true,
			libsql: true,
			destination: {
				columns: {
					accessKey: false,
					secretAccessKey: false,
				},
			},
			compose: true,
		},
	});
	if (!backup) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Backup not found",
		});
	}
	return backup;
};

export const updateBackupById = async (
	backupId: string,
	backupData: Partial<Backup>,
) => {
	const result = await db
		.update(backups)
		.set({
			...backupData,
		})
		.where(eq(backups.backupId, backupId))
		.returning();

	return result[0];
};

export const removeBackupById = async (backupId: string) => {
	const result = await db
		.delete(backups)
		.where(eq(backups.backupId, backupId))
		.returning();

	return result[0];
};

export const findBackupsByDbId = async (
	id: string,
	type: "postgres" | "mysql" | "mariadb" | "mongo" | "libsql",
) => {
	const result = await db.query.backups.findMany({
		where: eq(backups[`${type}Id`], id),
		with: {
			postgres: true,
			mysql: true,
			mariadb: true,
			mongo: true,
			libsql: true,
			destination: {
				columns: {
					accessKey: false,
					secretAccessKey: false,
				},
			},
		},
	});
	return result || [];
};

type BackupServiceIds = {
	postgresId?: string | null;
	mysqlId?: string | null;
	mariadbId?: string | null;
	mongoId?: string | null;
	libsqlId?: string | null;
	composeId?: string | null;
};

const BACKUP_SERVICE_ID_KEYS = [
	"postgresId",
	"mysqlId",
	"mariadbId",
	"mongoId",
	"libsqlId",
	"composeId",
] as const;

// Every service id set on a backup row. A well-formed service backup has
// exactly one; callers that gate on the service must check all of them.
export const getBackupServiceIds = (backup: BackupServiceIds) =>
	BACKUP_SERVICE_ID_KEYS.map((key) => backup[key]).filter(
		(id): id is string => !!id,
	);

export const getBackupServiceId = (backup: BackupServiceIds) =>
	getBackupServiceIds(backup)[0] ?? null;

const DATABASE_SERVICE_KEY = {
	postgres: "postgresId",
	mysql: "mysqlId",
	mariadb: "mariadbId",
	mongo: "mongoId",
	libsql: "libsqlId",
} as const;

// A backup row either targets nothing but the instance ("web-server") or
// exactly one service whose kind matches the row: a database backup carries
// the id of its own database type, a compose backup carries a composeId and
// the kind of database inside it. Rows with a second id, or an id that does
// not match their type, would run one service's dump on behalf of another
// service's permission, so they are rejected on write and refused at run time.
export const validateBackupServiceBinding = (
	backup: BackupServiceIds & { databaseType: string; backupType: string },
): { serviceId: string | null; error: string | null } => {
	const ids = getBackupServiceIds(backup);
	if (backup.databaseType === "web-server") {
		if (ids.length > 0) {
			return {
				serviceId: null,
				error: "An instance backup cannot be attached to a service.",
			};
		}
		if (backup.backupType !== "database") {
			return {
				serviceId: null,
				error: "An instance backup must be a database backup.",
			};
		}
		return { serviceId: null, error: null };
	}
	if (ids.length === 0) {
		return { serviceId: null, error: "A backup needs a service to back up." };
	}
	if (ids.length > 1) {
		return {
			serviceId: null,
			error: "A backup can only target one service.",
		};
	}
	const expectedKey =
		backup.backupType === "compose"
			? "composeId"
			: DATABASE_SERVICE_KEY[
					backup.databaseType as keyof typeof DATABASE_SERVICE_KEY
				];
	if (!expectedKey || !backup[expectedKey]) {
		return {
			serviceId: null,
			error: "The backup type does not match the service it targets.",
		};
	}
	return { serviceId: ids[0] ?? null, error: null };
};

// Instance backups (the Dokploy web server itself) belong to no service and
// no project. The backup row records only its creator (`userId`) and its
// destination.
export const isInstanceBackup = (
	backup: BackupServiceIds & { databaseType: string },
) => backup.databaseType === "web-server" || !getBackupServiceId(backup);

type InstanceBackupRef = { userId?: string | null; destinationId: string };

// Router side: an instance backup is part of the organization that owns its
// destination, whoever created it, so an owner or admin there can still find,
// re-attribute, disable or delete a row whose creator no longer qualifies. A
// row of another organization is reported exactly like a missing one, so ids
// cannot be probed across organizations.
export const assertInstanceBackupInOrganization = async (
	backup: InstanceBackupRef,
	organizationId: string,
) => {
	const destination = await findDestinationById(backup.destinationId);
	if (!organizationId || destination.organizationId !== organizationId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Backup not found",
		});
	}
};

// Run side (cron and manual): the zip holds the whole Dokploy base path, so
// the destination is only resolved after proving it belongs to an
// organization the backup's creator still owns or administers. It fails
// closed when the creator is unknown. Called before anything is zipped or
// uploaded.
export const findInstanceBackupDestination = async (
	backup: InstanceBackupRef,
) => {
	const destination = await findDestinationById(backup.destinationId);
	const creator = backup.userId
		? await db.query.member.findFirst({
				where: and(
					eq(member.userId, backup.userId),
					eq(member.organizationId, destination.organizationId),
					inArray(member.role, ["owner", "admin"]),
				),
			})
		: undefined;
	if (!creator) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this destination.",
		});
	}
	return destination;
};
