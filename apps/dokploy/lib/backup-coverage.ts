// Pure helpers shared by the Backup Center coverage tree (client) and the
// `backupPolicy.composeChildren` query (server). No React / DB imports here so
// the logic stays unit-testable.

/** Database families surfaced with a dedicated icon in the coverage tree. */
export type DbKind =
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

/** Convention shared with the backup-policy "production preset". */
export const isProductionEnvironment = (environmentName: string): boolean =>
	environmentName.trim().toLowerCase() === "production";

// Ordered patterns: the first match wins. Mongo is tested before mysql so
// `percona-server-mongodb` classifies as mongo (not the mysql-family percona),
// and mariadb before mysql so `mariadb` never falls into the mysql bucket.
const DB_IMAGE_PATTERNS: ReadonlyArray<[DbKind, RegExp]> = [
	["mariadb", /mariadb/],
	["mongo", /mongo/],
	["postgres", /postgres|postgis|pgvector|timescaledb/],
	["mysql", /mysql|percona/],
	["redis", /redis|valkey|dragonfly|keydb/],
	["libsql", /libsql|sqld/],
];

/**
 * Classify a docker image reference into a database family, or null when it is
 * not a recognized database image. Handles registries, namespaces, tags and
 * digests (e.g. `ghcr.io/acme/postgres:16@sha256:...` → postgres).
 */
export const classifyDbImage = (
	image: string | null | undefined,
): DbKind | null => {
	if (!image) return null;
	// Strip digest, then tag (the tag colon is the last colon after the final
	// slash — a leading `host:port/` must survive), then lowercase.
	let ref = image.split("@")[0] ?? "";
	const lastSlash = ref.lastIndexOf("/");
	const lastColon = ref.lastIndexOf(":");
	if (lastColon > lastSlash) {
		ref = ref.slice(0, lastColon);
	}
	ref = ref.toLowerCase();
	// Match against the final path segment so `mysql/mysql-server` works, but
	// fall back to the whole reference for namespaced hits like
	// `percona/percona-server`.
	const name = ref.slice(ref.lastIndexOf("/") + 1);
	for (const [kind, pattern] of DB_IMAGE_PATTERNS) {
		if (pattern.test(name) || pattern.test(ref)) {
			return kind;
		}
	}
	return null;
};

/** Coverage service shape needed by the default-filter predicate. */
export interface FilterableService {
	type:
		| "application"
		| "postgres"
		| "mysql"
		| "mariadb"
		| "mongo"
		| "libsql"
		| "redis"
		| "compose";
	hasVolumes: boolean;
}

/** Service-type facet values selectable in the Coverage filters. */
export type ServiceType = FilterableService["type"];

/** Database service types grouped under "Databases" in the type facet. */
export const DATABASE_SERVICE_TYPES: readonly DbKind[] = [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
];

const DB_SERVICE_TYPES: ReadonlySet<FilterableService["type"]> = new Set(
	DATABASE_SERVICE_TYPES,
);

/** Whether a service type belongs to the "Databases" facet group. */
export const isDatabaseServiceType = (type: ServiceType): boolean =>
	DB_SERVICE_TYPES.has(type);

/**
 * The user-approved "hide non-prod plain apps" default:
 * - production environments show every service;
 * - other environments show databases and services with named volumes only —
 *   a volume-less application/compose in a non-prod environment is hidden.
 */
export const isServiceShownByDefault = (
	service: FilterableService,
	environmentName: string,
): boolean => {
	if (isProductionEnvironment(environmentName)) return true;
	if (DB_SERVICE_TYPES.has(service.type)) return true;
	return service.hasVolumes;
};

/**
 * Global facet selections of the Coverage filters. Empty arrays / false mean
 * "no explicit selection" — the default rule applies. The moment any facet is
 * explicitly selected, the explicit selection fully replaces the default rule:
 * facets combine with AND, values within a facet combine with OR.
 */
export interface CoverageFacets {
	/** Selected environment names (matched case-insensitively, trimmed). */
	environmentNames: string[];
	/** Selected service types. */
	serviceTypes: ServiceType[];
	/** Show only services without any backup coverage. */
	notCoveredOnly: boolean;
}

export const EMPTY_COVERAGE_FACETS: CoverageFacets = {
	environmentNames: [],
	serviceTypes: [],
	notCoveredOnly: false,
};

/** Whether any explicit facet is active (i.e. the default rule is replaced). */
export const hasExplicitFacets = (facets: CoverageFacets): boolean =>
	facets.environmentNames.length > 0 ||
	facets.serviceTypes.length > 0 ||
	facets.notCoveredOnly;

/** Environment names are compared trimmed and case-insensitively. */
export const normalizeEnvironmentName = (name: string): string =>
	name.trim().toLowerCase();

/**
 * Whether an environment survives the environment-name facet. With no
 * explicit name selection every environment is shown.
 */
export const isEnvironmentShownByFacets = (
	environmentName: string,
	facets: CoverageFacets,
): boolean =>
	facets.environmentNames.length === 0 ||
	facets.environmentNames.some(
		(selected) =>
			normalizeEnvironmentName(selected) ===
			normalizeEnvironmentName(environmentName),
	);

/**
 * Whether a service is visible under the active facets. Without any explicit
 * facet the default rule (`isServiceShownByDefault`) applies; with explicit
 * facets the service must pass every active facet (AND), where each facet is
 * an OR over its selected values.
 */
export const isServiceShownByFacets = (
	service: FilterableService,
	environmentName: string,
	covered: boolean,
	facets: CoverageFacets,
): boolean => {
	if (!hasExplicitFacets(facets)) {
		return isServiceShownByDefault(service, environmentName);
	}
	if (!isEnvironmentShownByFacets(environmentName, facets)) return false;
	if (
		facets.serviceTypes.length > 0 &&
		!facets.serviceTypes.includes(service.type)
	) {
		return false;
	}
	if (facets.notCoveredOnly && covered) return false;
	return true;
};

/** A single container parsed out of a compose file. */
export interface ComposeChildService {
	name: string;
	image: string | null;
	dbKind: DbKind | null;
	/** Named (top-level) volumes the container mounts, in declaration order. */
	volumes: string[];
}

// Bind mounts and inline paths are not named volumes: absolute/relative paths,
// home-relative paths and env-var driven sources are excluded.
const isNamedVolumeSource = (source: string): boolean =>
	source.length > 0 && !/^[./~$]/.test(source) && !source.includes("\\");

/**
 * Extract the child services of a parsed compose specification. Tolerates
 * malformed documents: anything that does not look like `{ services: {...} }`
 * yields an empty list, and malformed service/volume entries are skipped
 * rather than throwing.
 */
export const extractComposeChildren = (
	spec: unknown,
): ComposeChildService[] => {
	if (!spec || typeof spec !== "object") return [];
	const services = (spec as { services?: unknown }).services;
	if (!services || typeof services !== "object" || Array.isArray(services)) {
		return [];
	}

	const children: ComposeChildService[] = [];
	for (const [name, rawService] of Object.entries(
		services as Record<string, unknown>,
	)) {
		if (!rawService || typeof rawService !== "object") continue;
		const service = rawService as {
			image?: unknown;
			volumes?: unknown;
		};
		const image = typeof service.image === "string" ? service.image : null;

		const volumes: string[] = [];
		if (Array.isArray(service.volumes)) {
			for (const entry of service.volumes) {
				if (typeof entry === "string") {
					// Short syntax `source:target[:mode]`. A colon-less entry is an
					// anonymous volume; sources that look like paths are bind mounts.
					const colonIndex = entry.indexOf(":");
					if (colonIndex <= 0) continue;
					const source = entry.slice(0, colonIndex).trim();
					if (isNamedVolumeSource(source)) volumes.push(source);
				} else if (entry && typeof entry === "object") {
					// Long syntax `{ type: volume, source, target }`.
					const long = entry as { type?: unknown; source?: unknown };
					if (
						long.type === "volume" &&
						typeof long.source === "string" &&
						isNamedVolumeSource(long.source)
					) {
						volumes.push(long.source);
					}
				}
			}
		}

		children.push({
			name,
			image,
			dbKind: classifyDbImage(image),
			volumes: [...new Set(volumes)],
		});
	}
	return children;
};

/**
 * Whether a configured volume backup covers a compose named volume. Deployed
 * compose volumes are usually prefixed with the stack/app name
 * (`<appName>_<volume>`), so both the exact name and the prefixed form match.
 */
export const isComposeVolumeCovered = (
	volumeName: string,
	backedUpVolumeNames: readonly string[],
): boolean =>
	backedUpVolumeNames.some(
		(backedUp) =>
			backedUp === volumeName || backedUp.endsWith(`_${volumeName}`),
	);

// --- Backup Center: verifying real files in the destination bucket ---

/**
 * Build the `search` argument for `backup.listBackupFiles` that lists exactly
 * the files stored under a backup's prefix. Mirrors the server-side
 * `normalizeS3Path`: surrounding whitespace and leading/trailing slashes are
 * stripped, then a trailing slash is appended so the listing targets the prefix
 * as a directory. An empty prefix lists the bucket root.
 */
export const buildBackupListPrefix = (prefix: string): string => {
	const normalized = prefix.trim().replace(/^\/+|\/+$/g, "");
	return normalized ? `${normalized}/` : "";
};

/**
 * Recover the backup timestamp from a dump file name. Backup files are written
 * as `<ISO-with-`:`-and-`.`-replaced-by-`-`>.<ext>.gz` (see `getBackupTimestamp`),
 * e.g. `2026-07-17T12-30-45-123Z.sql.gz`. `listBackupFiles` lists with
 * `--no-modtime`, so the name is the only timestamp source. Returns null when
 * the name carries no recognizable timestamp.
 */
export const parseBackupTimestamp = (fileName: string): Date | null => {
	const match = fileName.match(
		/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/,
	);
	if (!match) return null;
	const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? null : date;
};

/** Count the actual backup files (excluding directories) in an rclone listing. */
export const countBackupFiles = (
	files: ReadonlyArray<{ IsDir: boolean }>,
): number => files.reduce((total, file) => (file.IsDir ? total : total + 1), 0);

// --- Backup Center: coverage-tree search ---

/**
 * Case-insensitive, whitespace-trimmed substring match. An empty query matches
 * everything, so callers can pass the raw search box value unconditionally.
 */
export const textMatchesQuery = (text: string, query: string): boolean => {
	const normalized = query.trim().toLowerCase();
	if (normalized === "") return true;
	return text.toLowerCase().includes(normalized);
};

/**
 * Whether a coverage service is surfaced by the free-text coverage search. The
 * query matches against the service name and its owning project/environment
 * names (compose children are matched separately, as they load lazily).
 */
export const serviceMatchesSearch = (
	fields: { name: string; projectName: string; environmentName: string },
	query: string,
): boolean => {
	if (query.trim() === "") return true;
	return (
		textMatchesQuery(fields.name, query) ||
		textMatchesQuery(fields.projectName, query) ||
		textMatchesQuery(fields.environmentName, query)
	);
};

// --- Backup Center: activity log parsing ---

// A path/key ending in a known backup artifact extension. `[^\s"'`()]+` walks
// back to the previous separator so the whole path (including any `bucket/` or
// `:s3:` remote prefix) is captured. `tar.gz` precedes bare `tar` so a gzipped
// tarball is not truncated.
const BACKUP_ARTIFACT_PATTERN =
	/[^\s"'`()]+\.(?:sql\.gz|bson\.gz|dump\.gz|tar\.gz|zip|tar)/gi;

/**
 * Extract the uploaded artifact path from a backup run log, or null when none
 * is present (database/compose dump runs do not echo the path on success). The
 * last match wins — it is the final upload line for the run.
 */
export const extractBackupArtifactPath = (
	log: string | null | undefined,
): string | null => {
	if (!log) return null;
	const matches = log.match(BACKUP_ARTIFACT_PATTERN);
	if (!matches || matches.length === 0) return null;
	const last = matches[matches.length - 1]?.replace(/[.,;]+$/, "");
	return last || null;
};
