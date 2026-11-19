// Which service does a backup row belong to. A dump backup row and a volume
// backup row each carry one nullable id column per service kind; this is the
// single place that lists those columns, so adding a service kind means
// editing one list instead of every permission and routing ladder.
//
// A well-formed row carries exactly one id, and then every order gives the
// same answer. Legacy or hand-edited rows can carry several (the volume backup
// API even allows it), and for those the order decides which service the row
// is attributed to. The default order is the one `assertDeploymentAccess` and
// the backup policy run loop always used; the two named orders below keep the
// older, different orders of the call sites that must not change what they
// resolve.

export const BACKUP_SERVICE_ID_KEYS = [
	"postgresId",
	"mysqlId",
	"mariadbId",
	"mongoId",
	"libsqlId",
	"composeId",
] as const;

export type BackupServiceIdKey = (typeof BACKUP_SERVICE_ID_KEYS)[number];

export type BackupServiceIds = Partial<
	Record<BackupServiceIdKey, string | null>
>;

// `deployment.allByType` has always tried the compose id of a dump backup
// first.
export const COMPOSE_FIRST_BACKUP_SERVICE_ID_KEYS = [
	"composeId",
	"postgresId",
	"mysqlId",
	"mariadbId",
	"mongoId",
	"libsqlId",
] as const satisfies readonly BackupServiceIdKey[];

// Every service id set on a backup row. A well-formed service backup has
// exactly one; callers that gate on the service must check all of them.
export const getBackupServiceIds = (
	backup: BackupServiceIds,
	order: readonly BackupServiceIdKey[] = BACKUP_SERVICE_ID_KEYS,
) => order.map((key) => backup[key]).filter((id): id is string => !!id);

export const getBackupServiceId = (
	backup: BackupServiceIds,
	order: readonly BackupServiceIdKey[] = BACKUP_SERVICE_ID_KEYS,
) => getBackupServiceIds(backup, order)[0] ?? null;

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

export type VolumeBackupServiceIdKey =
	(typeof VOLUME_BACKUP_SERVICE_KEYS)[number];

export type VolumeBackupServiceIds = Partial<
	Record<VolumeBackupServiceIdKey, string | null>
>;

// `deployment.allByType` has always tried the compose id of a volume backup
// right after the application id.
export const COMPOSE_SECOND_VOLUME_BACKUP_SERVICE_KEYS = [
	"applicationId",
	"composeId",
	"postgresId",
	"mysqlId",
	"mariadbId",
	"mongoId",
	"redisId",
	"libsqlId",
] as const satisfies readonly VolumeBackupServiceIdKey[];

// The Backup Center coverage table and recent-activity feed have always
// attributed a volume row to its libsql service before its redis one.
export const LIBSQL_BEFORE_REDIS_VOLUME_BACKUP_SERVICE_KEYS = [
	"applicationId",
	"postgresId",
	"mysqlId",
	"mariadbId",
	"mongoId",
	"libsqlId",
	"redisId",
	"composeId",
] as const satisfies readonly VolumeBackupServiceIdKey[];

// Same as `getBackupServiceIds`, for a volume backup row (which can also
// belong to an application or a redis database).
export const getVolumeBackupServiceIds = (
	volumeBackup: VolumeBackupServiceIds,
	order: readonly VolumeBackupServiceIdKey[] = VOLUME_BACKUP_SERVICE_KEYS,
) => order.map((key) => volumeBackup[key]).filter((id): id is string => !!id);

export const getVolumeBackupServiceId = (
	volumeBackup: VolumeBackupServiceIds,
	order: readonly VolumeBackupServiceIdKey[] = VOLUME_BACKUP_SERVICE_KEYS,
) => getVolumeBackupServiceIds(volumeBackup, order)[0] ?? null;
