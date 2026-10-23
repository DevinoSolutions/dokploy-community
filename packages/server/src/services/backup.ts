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

export const getBackupServiceId = (backup: BackupServiceIds) =>
	backup.postgresId ||
	backup.mysqlId ||
	backup.mariadbId ||
	backup.mongoId ||
	backup.libsqlId ||
	backup.composeId ||
	null;

// Instance backups (the Dokploy web server itself) belong to no service and
// no project. The backup row records only its creator (`userId`) and its
// destination, so an instance backup counts as part of an organization when
// the destination belongs to it and the creator is still an owner or admin
// there. A row without a creator cannot be attributed and never matches.
export const isInstanceBackup = (
	backup: BackupServiceIds & { databaseType: string },
) => backup.databaseType === "web-server" || !getBackupServiceId(backup);

type InstanceBackupRef = { userId?: string | null; destinationId: string };

const instanceBackupBelongsToOrganization = async (
	backup: InstanceBackupRef,
	destinationOrganizationId: string,
	organizationId: string,
) => {
	if (
		!backup.userId ||
		!organizationId ||
		destinationOrganizationId !== organizationId
	) {
		return false;
	}
	const creator = await db.query.member.findFirst({
		where: and(
			eq(member.userId, backup.userId),
			eq(member.organizationId, organizationId),
			inArray(member.role, ["owner", "admin"]),
		),
	});
	return !!creator;
};

// Router side: a backup row of another organization is reported exactly like
// a missing one, so ids cannot be probed across organizations.
export const assertInstanceBackupInOrganization = async (
	backup: InstanceBackupRef,
	organizationId: string,
) => {
	const destination = await findDestinationById(backup.destinationId);
	if (
		!(await instanceBackupBelongsToOrganization(
			backup,
			destination.organizationId,
			organizationId,
		))
	) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Backup not found",
		});
	}
};

// Run side (cron and manual): resolves the destination only after proving it
// belongs to an organization the backup's creator administers, and fails
// closed when the creator is unknown. Called before anything is zipped or
// uploaded.
export const findInstanceBackupDestination = async (
	backup: InstanceBackupRef,
) => {
	const destination = await findDestinationById(backup.destinationId);
	if (
		!(await instanceBackupBelongsToOrganization(
			backup,
			destination.organizationId,
			destination.organizationId,
		))
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this destination.",
		});
	}
	return destination;
};
