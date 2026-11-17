/**
 * What `backup.one` and `volumeBackups.one` hand to the client.
 *
 * `findBackupById` and `findVolumeBackupById` load every service the backup
 * belongs to with a bare relation (`postgres: true`, `compose: true`, ...). The
 * backup runners need that: they read the database password and the names to
 * run the dump. A client does not, and the whole row carries credentials: the
 * database passwords, the compose webhook `refreshToken`, every `env`, and the
 * destination's encryption keys.
 *
 * So the finders stay as they are for internal callers, and the routers answer
 * with these views. Related rows are copied through an allowlist (not a list of
 * secret columns to blank), so a credential column added to a service table
 * later stays out of the response until somebody asks for it here.
 */

type AnyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const pick = (row: unknown, keys: readonly string[]): unknown => {
	if (!isRecord(row)) return row;
	const next: AnyRecord = {};
	for (const key of keys) {
		if (key in row) next[key] = row[key];
	}
	return next;
};

const SERVICE_KEYS = [
	"appName",
	"name",
	"description",
	"serverId",
	"environmentId",
	"applicationStatus",
	"createdAt",
] as const;

/** Per relation: the primary key plus what identifies and places the service. */
const SERVICE_RELATIONS: Record<string, readonly string[]> = {
	application: ["applicationId", ...SERVICE_KEYS],
	postgres: ["postgresId", ...SERVICE_KEYS],
	mysql: ["mysqlId", ...SERVICE_KEYS],
	mariadb: ["mariadbId", ...SERVICE_KEYS],
	mongo: ["mongoId", ...SERVICE_KEYS],
	redis: ["redisId", ...SERVICE_KEYS],
	libsql: ["libsqlId", ...SERVICE_KEYS],
	compose: [
		"composeId",
		"appName",
		"name",
		"description",
		"serverId",
		"environmentId",
		"composeStatus",
		"composeType",
		"sourceType",
		"createdAt",
	],
};

/**
 * The destination without credentials. `additionalFlags` is left out too: they
 * are raw rclone flags and can carry a header or a token.
 */
const DESTINATION_KEYS = [
	"destinationId",
	"name",
	"provider",
	"bucket",
	"region",
	"endpoint",
	"organizationId",
	"createdAt",
	"encryptionEnabled",
	"filenameEncryption",
	"directoryNameEncryption",
] as const;

const ENVIRONMENT_KEYS = ["environmentId", "name", "projectId"] as const;
const PROJECT_KEYS = ["projectId", "name", "organizationId"] as const;

const environmentView = (environment: unknown): unknown => {
	const view = pick(environment, ENVIRONMENT_KEYS);
	if (!isRecord(view) || !isRecord(environment)) return view;
	if ("project" in environment) {
		view.project = pick(environment.project, PROJECT_KEYS);
	}
	return view;
};

const serviceView = (key: string, row: unknown): unknown => {
	if (row === null || row === undefined) return row;
	const view = pick(row, SERVICE_RELATIONS[key] ?? []);
	if (!isRecord(view) || !isRecord(row)) return view;
	if ("environment" in row) view.environment = environmentView(row.environment);
	return view;
};

const withRelations = <T extends AnyRecord>(row: T): T => {
	const next: AnyRecord = { ...row };
	for (const key of Object.keys(SERVICE_RELATIONS)) {
		if (key in next) next[key] = serviceView(key, next[key]);
	}
	if ("destination" in next) {
		next.destination = pick(next.destination, DESTINATION_KEYS);
	}
	return next as T;
};

/** Database credentials a compose backup keeps in its `metadata` blob. */
const METADATA_SECRET_FIELDS = ["databasePassword", "databaseRootPassword"];

const blankMetadataCredentials = (metadata: unknown): unknown => {
	if (!isRecord(metadata)) return metadata;
	const next: AnyRecord = {};
	for (const [engine, config] of Object.entries(metadata)) {
		if (!isRecord(config)) {
			next[engine] = config;
			continue;
		}
		const copy: AnyRecord = { ...config };
		for (const field of METADATA_SECRET_FIELDS) {
			if (typeof copy[field] === "string") copy[field] = "";
		}
		next[engine] = copy;
	}
	return next;
};

/**
 * A backup as the client sees it. Related services and the destination keep
 * only their identifying fields. `metadata` holds the database user and
 * password of a compose backup, which the edit form sends back on save, so it
 * is kept for a caller who may update the backup and blanked for one who may
 * only read it.
 */
export const toBackupReadView = <T extends AnyRecord>(
	backup: T,
	options: { canUpdate: boolean },
): T => {
	const view = withRelations(backup) as AnyRecord;
	if (!options.canUpdate && "metadata" in view) {
		view.metadata = blankMetadataCredentials(view.metadata);
	}
	return view as T;
};

/** A volume backup as the client sees it: its own columns plus identifying fields of what it backs up. */
export const toVolumeBackupReadView = <T extends AnyRecord>(
	volumeBackup: T,
): T => withRelations(volumeBackup);
