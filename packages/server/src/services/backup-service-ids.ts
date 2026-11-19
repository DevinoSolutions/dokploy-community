// Which service does a backup row belong to. A dump backup row and a volume
// backup row each carry one nullable id column per service kind; this is the
// single place that lists those columns, so adding a service kind means
// editing one list instead of every permission and routing ladder.

export const BACKUP_SERVICE_ID_KEYS = [
	"postgresId",
	"mysqlId",
	"mariadbId",
	"mongoId",
	"libsqlId",
	"composeId",
] as const;

export type BackupServiceIds = Partial<
	Record<(typeof BACKUP_SERVICE_ID_KEYS)[number], string | null>
>;

// Every service id set on a backup row. A well-formed service backup has
// exactly one; callers that gate on the service must check all of them.
export const getBackupServiceIds = (backup: BackupServiceIds) =>
	BACKUP_SERVICE_ID_KEYS.map((key) => backup[key]).filter(
		(id): id is string => !!id,
	);

export const getBackupServiceId = (backup: BackupServiceIds) =>
	getBackupServiceIds(backup)[0] ?? null;

export const VOLUME_BACKUP_SERVICE_KEYS = [
	"applicationId",
	"postgresId",
	"mysqlId",
	"mariadbId",
	"mongoId",
	"redisId",
	"libsqlId",
	"composeId",
] as const;

export type VolumeBackupServiceIds = Partial<
	Record<(typeof VOLUME_BACKUP_SERVICE_KEYS)[number], string | null>
>;

// Same as `getBackupServiceIds`, for a volume backup row (which can also
// belong to an application or a redis database).
export const getVolumeBackupServiceIds = (
	volumeBackup: VolumeBackupServiceIds,
) =>
	VOLUME_BACKUP_SERVICE_KEYS.map((key) => volumeBackup[key]).filter(
		(id): id is string => !!id,
	);

export const getVolumeBackupServiceId = (
	volumeBackup: VolumeBackupServiceIds,
) => getVolumeBackupServiceIds(volumeBackup)[0] ?? null;
