import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db";
import {
	type createVolumeBackupSchema,
	type updateVolumeBackupSchema,
	mounts,
	volumeBackups,
} from "../db/schema";

export const findVolumeBackupById = async (volumeBackupId: string) => {
	const volumeBackup = await db.query.volumeBackups.findFirst({
		where: eq(volumeBackups.volumeBackupId, volumeBackupId),
		with: {
			// `application` has 100 columns (incl. the fork's `networkIds`). Drizzle
			// packs every selected column of a joined resource plus one entry per
			// nested relation into a single json_build_array(...), which Postgres caps
			// at 100 arguments (error 54023). Selecting all of `application` emits
			// json_build_array(100 columns + environment) = 101 args and throws, so we
			// project it down to only the fields consumers read. The other joined
			// resources are far narrower and left intact. See services/mount.ts.
			application: {
				columns: {
					applicationId: true,
					appName: true,
					serverId: true,
				},
				with: {
					environment: {
						columns: {},
						with: {
							project: {
								columns: { name: true, organizationId: true },
							},
						},
					},
				},
			},
			postgres: {
				with: {
					environment: {
						with: {
							project: true,
						},
					},
				},
			},
			mysql: {
				with: {
					environment: {
						with: {
							project: true,
						},
					},
				},
			},
			mariadb: {
				with: {
					environment: {
						with: {
							project: true,
						},
					},
				},
			},
			mongo: {
				with: {
					environment: {
						with: {
							project: true,
						},
					},
				},
			},
			redis: {
				with: {
					environment: {
						with: {
							project: true,
						},
					},
				},
			},
			compose: {
				with: {
					environment: {
						with: {
							project: true,
						},
					},
				},
			},
			libsql: {
				with: {
					environment: {
						with: {
							project: true,
						},
					},
				},
			},
			destination: {
				columns: {
					accessKey: false,
					secretAccessKey: false,
				},
			},
		},
	});

	if (!volumeBackup) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Volume backup not found",
		});
	}

	return volumeBackup;
};

export const createVolumeBackup = async (
	volumeBackup: z.infer<typeof createVolumeBackupSchema>,
) => {
	const newVolumeBackup = await db
		.insert(volumeBackups)
		.values(volumeBackup as typeof volumeBackups.$inferInsert)
		.returning()
		.then((e) => e[0]);

	return newVolumeBackup;
};

export const removeVolumeBackup = async (volumeBackupId: string) => {
	await db
		.delete(volumeBackups)
		.where(eq(volumeBackups.volumeBackupId, volumeBackupId));
};

export const updateVolumeBackup = async (
	volumeBackupId: string,
	volumeBackup: z.infer<typeof updateVolumeBackupSchema>,
) => {
	return await db
		.update(volumeBackups)
		.set(volumeBackup as Partial<typeof volumeBackups.$inferInsert>)
		.where(eq(volumeBackups.volumeBackupId, volumeBackupId))
		.returning()
		.then((e) => e[0]);
};

// The Docker volume names a restore into this application or compose may
// target: the volumes its own volume backups cover and its own named mounts.
// A restore removes and recreates the named volume, so any other name (a
// volume of another service or organization on the same host) is refused.
export const findRestorableVolumeNames = async (
	serviceId: string,
	serviceType: "application" | "compose",
) => {
	const serviceColumn = serviceType === "compose" ? "composeId" : "applicationId";
	const [backupRows, mountRows] = await Promise.all([
		db.query.volumeBackups.findMany({
			where: eq(volumeBackups[serviceColumn], serviceId),
			columns: { volumeName: true },
		}),
		db.query.mounts.findMany({
			where: and(eq(mounts[serviceColumn], serviceId), eq(mounts.type, "volume")),
			columns: { volumeName: true },
		}),
	]);
	return new Set(
		[...backupRows, ...mountRows]
			.map((row) => row.volumeName)
			.filter((name): name is string => !!name),
	);
};
