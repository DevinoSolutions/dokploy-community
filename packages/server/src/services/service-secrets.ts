import { parse } from "dotenv";

/**
 * Key-only and value-free views of a service row (T-6991).
 *
 * `application.one` and `compose.one` return the whole row, so an agent that
 * only needs a variable's name ends up holding the live secret. This module
 * gives the routers two things: `listEnvKeys` for the names alone, and
 * `redactServiceSecrets` to blank every value-bearing field on the row and
 * on the relations `find*ById` loads.
 */

/**
 * Names of the variables in a dotenv-style block, each once, in the order they
 * first appear. Uses the parser that builds the deploy environment, so
 * comments, `export `, quotes, multiline values and `KEY=` agree with what is
 * actually deployed. Values are never returned.
 *
 * Keys that are plain integers (not valid shell names) are listed first, as JS
 * orders integer-like object keys before the rest.
 */
export const listEnvKeys = (source: string | null | undefined): string[] =>
	Object.keys(parse(source ?? ""));

const BLANK = "";

/** Columns on a service row whose value is a secret (or a credential to one). */
const SECRET_ROW_FIELDS = [
	"env",
	"buildArgs",
	"buildSecrets",
	"previewEnv",
	"previewBuildArgs",
	"previewBuildSecrets",
	// Docker-image registry password on an application.
	"password",
	// Webhook deploy token: anyone holding it can trigger a deploy.
	"refreshToken",
	"databasePassword",
	"databaseRootPassword",
] as const;

/** Credential columns that a nested provider/registry/destination row can carry. */
const NESTED_SECRET_FIELDS = [
	"password",
	"secret",
	"accessToken",
	"refreshToken",
	"appPassword",
	"apiToken",
	"clientSecret",
	"githubClientSecret",
	"githubPrivateKey",
	"githubWebhookSecret",
	"accessKey",
	"secretAccessKey",
	"encryptionKey",
	"encryptionPassword2",
	"privateKey",
] as const;

type AnyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const blankFields = (row: unknown, fields: readonly string[]): unknown => {
	if (!isRecord(row)) return row;
	const next: AnyRecord = { ...row };
	for (const field of fields) {
		if (typeof next[field] === "string") next[field] = BLANK;
	}
	return next;
};

const mapRows = (rows: unknown, fn: (row: unknown) => unknown): unknown =>
	Array.isArray(rows) ? rows.map(fn) : rows;

/** `https://user:token@host/repo` → `https://host/repo`. */
const stripUrlCredentials = (url: unknown): unknown => {
	if (typeof url !== "string") return url;
	return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1");
};

/** Database credentials a compose backup keeps in its `metadata` blob. */
const redactBackupMetadata = (metadata: unknown): unknown => {
	if (!isRecord(metadata)) return metadata;
	const next: AnyRecord = {};
	for (const [engine, config] of Object.entries(metadata)) {
		next[engine] = blankFields(config, [
			"databasePassword",
			"databaseRootPassword",
		]);
	}
	return next;
};

const redactBackup = (backup: unknown): unknown => {
	if (!isRecord(backup)) return backup;
	return {
		...backup,
		...("destination" in backup
			? { destination: blankFields(backup.destination, NESTED_SECRET_FIELDS) }
			: {}),
		...("metadata" in backup
			? { metadata: redactBackupMetadata(backup.metadata) }
			: {}),
	};
};

/** The agent token inside a server's monitoring config. */
const redactServer = (server: unknown): unknown => {
	if (!isRecord(server)) return server;
	const metrics = server.metricsConfig;
	if (!isRecord(metrics) || !isRecord(metrics.server)) return server;
	return {
		...server,
		metricsConfig: {
			...metrics,
			server: { ...metrics.server, token: BLANK },
		},
	};
};

/** Project and environment carry their own `env` that services inherit. */
const redactEnvironment = (environment: unknown): unknown => {
	if (!isRecord(environment)) return environment;
	return {
		...(blankFields(environment, ["env"]) as AnyRecord),
		...("project" in environment
			? { project: blankFields(environment.project, ["env"]) }
			: {}),
	};
};

/** Marker added to a redacted row so a reader can tell blank from unset. */
export interface SecretsRedacted {
	secretsRedacted: true;
}

/**
 * The row with every secret value blanked: the row's own `env`, `buildArgs`,
 * `buildSecrets`, `previewEnv`, `previewBuildArgs`, `previewBuildSecrets`,
 * `password`, `refreshToken` and database passwords, plus the same on the
 * relations `find*ById` loads (project/environment `env`, security basic-auth
 * passwords, git providers, registries, a custom git SSH key, backup
 * destinations and metadata, server monitoring token) and credentials embedded
 * in `customGitUrl`. Shape and types are unchanged: strings become `""`.
 *
 * Not touched, because they are configuration rather than a stored secret:
 * `composeFile`, `command`/`args` and file-mount contents. A literal secret
 * pasted into those still reads back.
 */
export const redactServiceSecrets = <T extends AnyRecord>(
	row: T,
): T & SecretsRedacted => {
	const next: AnyRecord = blankFields(row, SECRET_ROW_FIELDS) as AnyRecord;
	if ("customGitUrl" in next) {
		next.customGitUrl = stripUrlCredentials(next.customGitUrl);
	}
	if ("environment" in next) {
		next.environment = redactEnvironment(next.environment);
	}
	for (const relation of ["server", "buildServer"]) {
		if (relation in next) next[relation] = redactServer(next[relation]);
	}
	for (const relation of [
		"github",
		"gitlab",
		"bitbucket",
		"gitea",
		"registry",
		"buildRegistry",
		"rollbackRegistry",
		"customGitSSHKey",
	]) {
		if (relation in next) {
			next[relation] = blankFields(next[relation], NESTED_SECRET_FIELDS);
		}
	}
	if ("security" in next) {
		next.security = mapRows(next.security, (entry) =>
			blankFields(entry, ["password"]),
		);
	}
	if ("backups" in next) {
		next.backups = mapRows(next.backups, redactBackup);
	}
	next.secretsRedacted = true;
	return next as T & SecretsRedacted;
};

/**
 * `includeEnv` is true by default, so the dashboard keeps its behaviour; the
 * MCP dispatcher forces it to false unless the grant allows secret reads.
 */
export const shapeServiceRead = <T extends AnyRecord>(
	row: T,
	includeEnv: boolean | undefined,
): T | (T & SecretsRedacted) =>
	includeEnv === false ? redactServiceSecrets(row) : row;

/**
 * Keys whose value is blanked wherever they appear in an MCP tool result, at
 * any depth. A superset of the columns `redactServiceSecrets` knows, so a
 * route that nests a service row (environment.one, project.one, search, ...)
 * is covered without a per-route list.
 */
export const MCP_SECRET_KEYS: ReadonlySet<string> = new Set([
	"env",
	"buildArgs",
	"buildSecrets",
	"previewEnv",
	"previewBuildArgs",
	"previewBuildSecrets",
	"password",
	"databasePassword",
	"databaseRootPassword",
	"refreshToken",
	"accessToken",
	"idToken",
	"token",
	"secret",
	"clientSecret",
	"privateKey",
	"sshPrivateKey",
	"encryptionKey",
	"encryptionPassword",
	"encryptionPassword2",
	"secretAccessKey",
	"awsSecretAccessKey",
	"accessKey",
	"secretKey",
	"apiKey",
	"apiToken",
	"appPassword",
	"botToken",
	"appToken",
	"scimToken",
	"heartbeatKey",
	"licenseKey",
	"webhookSecret",
	"githubClientSecret",
	"githubPrivateKey",
	"githubWebhookSecret",
]);

const isPlainObject = (value: unknown): value is AnyRecord => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
};

const hasContent = (value: unknown): boolean =>
	typeof value === "string"
		? value !== ""
		: Array.isArray(value)
			? value.length > 0
			: isPlainObject(value)
				? Object.keys(value).length > 0
				: false;

interface Walked {
	value: unknown;
	changed: boolean;
}

/**
 * Copy-on-write walk: a subtree with nothing to blank is returned as the same
 * reference, so only the path down to a blanked field is copied. `path` holds
 * the containers being walked, which stops a cycle without flagging a
 * subtree that is merely shared.
 */
const walkSecrets = (node: unknown, path: Set<object>): Walked => {
	if (Array.isArray(node)) {
		if (path.has(node)) return { value: node, changed: false };
		path.add(node);
		let copy: unknown[] | null = null;
		node.forEach((item, index) => {
			const walked = walkSecrets(item, path);
			if (!walked.changed) return;
			copy ??= node.slice();
			copy[index] = walked.value;
		});
		path.delete(node);
		return { value: copy ?? node, changed: copy !== null };
	}
	if (!isPlainObject(node)) return { value: node, changed: false };
	if (path.has(node)) return { value: node, changed: false };
	path.add(node);
	let copy: AnyRecord | null = null;
	for (const [key, value] of Object.entries(node)) {
		let next: unknown = value;
		if (MCP_SECRET_KEYS.has(key)) {
			if (hasContent(value)) next = BLANK;
		} else if (key === "customGitUrl") {
			next = stripUrlCredentials(value);
		} else {
			const walked = walkSecrets(value, path);
			if (walked.changed) next = walked.value;
		}
		if (next !== value) {
			copy ??= { ...node };
			copy[key] = next;
		}
	}
	path.delete(node);
	return { value: copy ?? node, changed: copy !== null };
};

/**
 * An MCP tool result with every {@link MCP_SECRET_KEYS} value blanked to `""`
 * at any depth, and the userinfo stripped from `customGitUrl`. A top-level
 * object that had something blanked also carries `secretsRedacted: true`
 * (an array result cannot carry the marker). The input is not mutated, and
 * an untouched subtree is shared rather than copied.
 */
export const redactToolResult = (result: unknown): unknown => {
	const walked = walkSecrets(result, new Set());
	if (!walked.changed) return result;
	if (isPlainObject(walked.value)) {
		(walked.value as AnyRecord).secretsRedacted = true;
	}
	return walked.value;
};
