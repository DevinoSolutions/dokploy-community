/**
 * What the backup routers hand to the client.
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
 * later stays out of the response until somebody asks for it here. The
 * `backup-read-view` test compares these lists with the tables, so adding a
 * column without classifying it fails there.
 */

type AnyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

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
export const SERVICE_RELATION_KEYS = {
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
} as const;

/**
 * The destination without credentials. `additionalFlags` is left out too: they
 * are raw rclone flags and can carry a header or a token.
 */
export const DESTINATION_READ_KEYS = [
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

/** The same list as a drizzle `columns` projection, for queries that load a destination. */
export const DESTINATION_READ_COLUMNS = {
	destinationId: true,
	name: true,
	provider: true,
	bucket: true,
	region: true,
	endpoint: true,
	organizationId: true,
	createdAt: true,
	encryptionEnabled: true,
	filenameEncryption: true,
	directoryNameEncryption: true,
} as const satisfies Record<(typeof DESTINATION_READ_KEYS)[number], true>;

export const ENVIRONMENT_READ_KEYS = [
	"environmentId",
	"name",
	"projectId",
] as const;
export const PROJECT_READ_KEYS = [
	"projectId",
	"name",
	"organizationId",
] as const;

type ServiceRelation = keyof typeof SERVICE_RELATION_KEYS;

/** The row without anything outside `K`; null and undefined pass through. */
type Narrow<R, K extends string> = R extends null | undefined
	? R
	: Pick<R, Extract<keyof R, K>>;

type EnvironmentView<E> = E extends null | undefined
	? E
	: Narrow<E, (typeof ENVIRONMENT_READ_KEYS)[number]> &
			(E extends { project: infer P }
				? { project: Narrow<P, (typeof PROJECT_READ_KEYS)[number]> }
				: unknown);

type ServiceView<R, K extends ServiceRelation> = R extends null | undefined
	? R
	: Narrow<R, (typeof SERVICE_RELATION_KEYS)[K][number]> &
			(R extends { environment: infer E }
				? { environment: EnvironmentView<E> }
				: unknown);

/**
 * The type of a row after `withRelations`: the related rows keep only the
 * allowlisted fields, so a caller of the router cannot name a removed one.
 */
export type WithReadRelations<T> = {
	[P in keyof T]: P extends ServiceRelation
		? ServiceView<T[P], P>
		: P extends "destination"
			? Narrow<T[P], (typeof DESTINATION_READ_KEYS)[number]>
			: T[P];
};

const pick = (row: unknown, keys: readonly string[]): unknown => {
	if (!isRecord(row)) return row;
	const next: AnyRecord = {};
	for (const key of keys) {
		if (key in row) next[key] = row[key];
	}
	return next;
};

const environmentView = (environment: unknown): unknown => {
	const view = pick(environment, ENVIRONMENT_READ_KEYS);
	if (!isRecord(view) || !isRecord(environment)) return view;
	if ("project" in environment) {
		view.project = pick(environment.project, PROJECT_READ_KEYS);
	}
	return view;
};

const serviceView = (key: ServiceRelation, row: unknown): unknown => {
	if (row === null || row === undefined) return row;
	const view = pick(row, SERVICE_RELATION_KEYS[key]);
	if (!isRecord(view) || !isRecord(row)) return view;
	if ("environment" in row) view.environment = environmentView(row.environment);
	return view;
};

const withRelations = <T extends AnyRecord>(row: T): WithReadRelations<T> => {
	const next: AnyRecord = { ...row };
	for (const key of Object.keys(SERVICE_RELATION_KEYS) as ServiceRelation[]) {
		if (key in next) next[key] = serviceView(key, next[key]);
	}
	if ("destination" in next) {
		next.destination = pick(next.destination, DESTINATION_READ_KEYS);
	}
	return next as WithReadRelations<T>;
};

/**
 * What a backup's `metadata` may show to a caller who cannot use it. It holds
 * the database user and password of a compose backup (see the `metadata`
 * column), and `z.any()` on the way in means nothing else is promised about its
 * shape. So this is an allowlist over whatever is there, at any depth: the keys
 * below keep their value, every other string becomes "" and every other
 * non-container value becomes null. A password under a new engine, or nested
 * one level deeper, is blank without anybody having to name it.
 *
 * An allowlist rather than a pattern for secret-looking names: it cannot miss a
 * credential called something unexpected, and the forms that need the values
 * (edit backup, restore) are served by the callers who may update or restore,
 * who get the metadata untouched.
 */
const METADATA_VISIBLE_KEYS: ReadonlySet<string> = new Set([
	"databaseUser",
	"serviceName",
]);

const MAX_METADATA_DEPTH = 8;

const blankMetadata = (value: unknown, depth: number): unknown => {
	if (Array.isArray(value)) {
		return depth >= MAX_METADATA_DEPTH
			? []
			: value.map((item) => blankMetadata(item, depth + 1));
	}
	if (isRecord(value)) {
		if (depth >= MAX_METADATA_DEPTH) return {};
		const next: AnyRecord = {};
		for (const [key, inner] of Object.entries(value)) {
			if (METADATA_VISIBLE_KEYS.has(key) && typeof inner === "string") {
				next[key] = inner;
			} else {
				next[key] = blankMetadata(inner, depth + 1);
			}
		}
		return next;
	}
	return typeof value === "string" ? "" : null;
};

/** `metadata` with every value outside the visible keys blanked. */
export const redactBackupMetadata = <M>(metadata: M): M => {
	if (metadata === null || metadata === undefined) return metadata;
	return blankMetadata(metadata, 0) as M;
};

/**
 * A backup as the client sees it. Related services and the destination keep
 * only their identifying fields. `metadata` holds the database credentials of
 * a compose backup, which the edit form sends back on save, so it is kept for a
 * caller who may update the backup and blanked for one who may only read it.
 */
export const toBackupReadView = <T extends AnyRecord>(
	backup: T,
	options: { canUpdate: boolean },
): WithReadRelations<T> => {
	const view = withRelations(backup) as AnyRecord;
	if (!options.canUpdate && "metadata" in view) {
		view.metadata = redactBackupMetadata(view.metadata);
	}
	return view as WithReadRelations<T>;
};

/** A volume backup as the client sees it: its own columns plus identifying fields of what it backs up. */
export const toVolumeBackupReadView = <T extends AnyRecord>(
	volumeBackup: T,
): WithReadRelations<T> => withRelations(volumeBackup);
