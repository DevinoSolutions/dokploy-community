/**
 * Serialization + secret-redaction helpers for exporting a Dokploy project to
 * a portable JSON document (Dokploy/dokploy#1733).
 *
 * These functions are intentionally pure (no DB / IO) so the secret-redaction
 * behaviour can be unit-tested in isolation. The router is responsible for
 * loading the project graph and passing it in.
 */

/**
 * Version of the project export JSON format. Bump this whenever the shape
 * changes so a future importer can detect and migrate older exports.
 */
export const PROJECT_EXPORT_VERSION = 1 as const;

/**
 * Keys whose values are secrets and must be stripped from an export unless the
 * caller explicitly opts in with `includeSecrets`. Matched case-insensitively
 * against the whole key name, so it also covers `databasePassword`,
 * `refreshToken`, `serviceAccountKey`, etc.
 */
const SECRET_KEY_PATTERN =
	/password|secret|token|passphrase|privatekey|serviceaccount|credential/i;

/**
 * Keys that hold free-form environment-variable blobs. These routinely contain
 * secrets, so they are redacted together with the explicit secret keys.
 */
const ENV_KEY_PATTERN = /^env$/i;

const redactValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(redactValue);
	}
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (SECRET_KEY_PATTERN.test(key) || ENV_KEY_PATTERN.test(key)) {
				result[key] = null;
			} else {
				result[key] = redactValue(item);
			}
		}
		return result;
	}
	return value;
};

/**
 * Recursively null out secret-bearing fields (passwords, tokens, refresh
 * tokens, environment blobs, etc.). Returns the input untouched when
 * `includeSecrets` is true.
 */
export const redactProjectSecrets = <T>(
	value: T,
	includeSecrets: boolean,
): T => (includeSecrets ? value : (redactValue(value) as T));

export interface ProjectExportEnvironment {
	name: string;
	description: string | null;
	env: string | null;
	services: {
		applications: unknown[];
		compose: unknown[];
		postgres: unknown[];
		mysql: unknown[];
		mariadb: unknown[];
		mongo: unknown[];
		redis: unknown[];
		libsql: unknown[];
	};
}

export interface ProjectExportPayload {
	project: {
		name: string;
		description: string | null;
		env: string | null;
	};
	environments: ProjectExportEnvironment[];
}

/**
 * Wrap a fully-loaded project graph in the versioned export envelope and redact
 * secrets unless the caller opts in. The envelope metadata (`version`,
 * `exportedAt`, `includeSecrets`) is added after redaction so it is never
 * stripped.
 */
export const assembleProjectExport = (
	payload: ProjectExportPayload,
	includeSecrets: boolean,
) => ({
	version: PROJECT_EXPORT_VERSION,
	exportedAt: new Date().toISOString(),
	includeSecrets,
	...redactProjectSecrets(payload, includeSecrets),
});

export type ProjectExport = ReturnType<typeof assembleProjectExport>;
