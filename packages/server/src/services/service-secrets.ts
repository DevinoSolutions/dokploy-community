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
export const SECRET_ROW_FIELDS = [
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
export const NESTED_SECRET_FIELDS = [
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
	// GitLab's webhook secret (`gitlab.webhookSecret`).
	"webhookSecret",
	"accessKey",
	"secretAccessKey",
	"encryptionKey",
	"encryptionPassword2",
	"privateKey",
	// AWS ECR registry credentials (`registry`, `buildRegistry`, `rollbackRegistry`).
	"awsAccessKeyId",
	"awsSecretAccessKey",
	// Raw rclone flags of a backup destination; they can carry a header or a token.
	"additionalFlags",
] as const;

/**
 * Nested columns that name an account rather than prove access to it. A caller
 * who may edit the service keeps them on the dashboard read (the registry form
 * shows the access key id); everybody else gets them blank.
 */
const NESTED_IDENTIFIER_FIELDS: readonly string[] = ["awsAccessKeyId"];

/** The three registries a service row can link; each can be an AWS ECR one. */
const SERVICE_REGISTRY_RELATIONS = [
	"registry",
	"buildRegistry",
	"rollbackRegistry",
] as const;

type AnyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const blankFields = (row: unknown, fields: readonly string[]): unknown => {
	if (!isRecord(row)) return row;
	const next: AnyRecord = { ...row };
	for (const field of fields) {
		if (typeof next[field] === "string") next[field] = BLANK;
		// A list column (a destination's `additionalFlags`): emptied, not removed.
		else if (Array.isArray(next[field])) next[field] = [];
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

/**
 * The row with the credentials of its linked registries blanked (every column
 * of `NESTED_SECRET_FIELDS`), for the dashboard read of `application.one`,
 * which otherwise keeps its values. The finder has to load
 * `awsSecretAccessKey`: the ECR login on the deploy path reads it from the
 * relation. A client never needs it, and the registry router withholds it from
 * everybody, so it is blanked here for every caller. The access key id names
 * the account rather than proving access to it, and stays for a caller who may
 * edit the service (`keepAccessKeyId`). Strings become `""`, null stays null.
 */
export const redactRegistryAwsKeys = <T extends object>(
	row: T,
	options: { keepAccessKeyId: boolean },
): T => {
	const record = row as AnyRecord;
	const fields = options.keepAccessKeyId
		? NESTED_SECRET_FIELDS.filter(
				(field) => !NESTED_IDENTIFIER_FIELDS.includes(field),
			)
		: NESTED_SECRET_FIELDS;
	let next: AnyRecord | null = null;
	for (const relation of SERVICE_REGISTRY_RELATIONS) {
		if (!(relation in record)) continue;
		next ??= { ...record };
		next[relation] = blankFields(record[relation], fields);
	}
	return (next ?? row) as T;
};

/**
 * What a start, stop or status mutation answers: the service id and the status
 * it was just set to. Not the row `find*ById` loaded: it holds `env`, the
 * webhook `refreshToken`, passwords and the linked registries' credentials,
 * and the `deployment.create` permission these routes need does not include
 * reading them (`application.one` withholds some of them from such callers).
 */
export const serviceStatusResult = <K extends string, S extends string>(
	row: Record<K, string>,
	idKey: K,
	applicationStatus: S,
) => ({ [idKey]: row[idKey], applicationStatus }) as Record<K, string> & {
	applicationStatus: S;
};

/**
 * What a delete mutation answers: the id of the service and the project and
 * environment it lived in, which the dashboard needs to go back to the
 * environment page. Not the row: `find*ById` loads `env`, the webhook
 * `refreshToken`, database passwords and a compose service's backup metadata,
 * and the `delete` permission does not include reading any of them.
 */
export const deletedServiceResult = <
	K extends string,
	R extends Record<K, string> & {
		environment: { environmentId: string; projectId: string };
	},
>(
	row: R,
	idKey: K,
) =>
	({
		[idKey]: row[idKey],
		environment: {
			environmentId: row.environment.environmentId,
			projectId: row.environment.projectId,
		},
	}) as Record<K, string> & {
		environment: { environmentId: string; projectId: string };
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
		...SERVICE_REGISTRY_RELATIONS,
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

const SECRET_KEYS_LOWER: ReadonlySet<string> = new Set(
	[...MCP_SECRET_KEYS].map((key) => key.toLowerCase()),
);

/**
 * Whether a field name is a secret, ignoring case: `Env`, `Password` and
 * `Token` from an external API (Docker inspect, a provider) count too.
 */
export const isSecretKey = (key: string): boolean =>
	SECRET_KEYS_LOWER.has(key.toLowerCase());

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

/** Entry fields that name a variable; any other field of an env entry object is a value. */
const ENV_ENTRY_NAME_KEYS: ReadonlySet<string> = new Set(["name", "key"]);

/** A value-bearing field: a non-empty string, array or object, or any number or boolean. */
const hasEnvValue = (value: unknown): boolean =>
	typeof value === "number" ||
	typeof value === "boolean" ||
	typeof value === "bigint" ||
	hasContent(value);

/**
 * One entry of an `env` array without its value, or the entry itself when it
 * has none. Covers every shape stored or returned: `"KEY=value"` (docker
 * `Env`), a bare `"KEY"` (name only), a `{ name, value }` or `{ KEY: value }`
 * object, and a `["KEY", "value"]` pair.
 */
const blankEnvEntry = (entry: unknown): unknown => {
	if (typeof entry === "string") {
		const at = entry.indexOf("=");
		return at < 0 || at === entry.length - 1 ? entry : entry.slice(0, at + 1);
	}
	if (Array.isArray(entry)) {
		if (entry.length < 2 || !entry.slice(1).some(hasEnvValue)) return entry;
		return [entry[0], ...entry.slice(1).map(() => BLANK)];
	}
	if (!isPlainObject(entry)) return entry;
	let copy: AnyRecord | null = null;
	for (const [field, value] of Object.entries(entry)) {
		const isName =
			ENV_ENTRY_NAME_KEYS.has(field.toLowerCase()) && typeof value === "string";
		if (isName || !hasEnvValue(value)) continue;
		copy ??= { ...entry };
		copy[field] = BLANK;
	}
	return copy ?? entry;
};

/**
 * Names kept, values dropped: `["A=1", "B="]` → `["A=", "B="]` and
 * `[{ name: "A", value: "1" }]` → `[{ name: "A", value: "" }]`. The array is
 * returned as is when nothing has a value.
 */
export const blankEnvArray = (entries: unknown[]): unknown[] => {
	let copy: unknown[] | null = null;
	entries.forEach((entry, index) => {
		const blanked = blankEnvEntry(entry);
		if (blanked === entry) return;
		copy ??= entries.slice();
		copy[index] = blanked;
	});
	return copy ?? entries;
};

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
		if (isSecretKey(key)) {
			if (key.toLowerCase() === "env" && Array.isArray(value)) {
				// A container `Env` is KEY=VALUE strings: keep the names, drop the values.
				next = blankEnvArray(value);
			} else if (hasContent(value)) {
				next = BLANK;
			}
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

/**
 * Variable-block columns that are nullable: `null` empties one just as `""`
 * does (lower case, matched without regard to case).
 */
const NULLABLE_BLOCK_KEYS: ReadonlySet<string> = new Set([
	"env",
	"buildargs",
	"buildsecrets",
	"previewenv",
	"previewbuildargs",
	"previewbuildsecrets",
]);

/** How many object/array levels below the arguments are searched for an emptied secret. */
export const EMPTIED_SECRET_MAX_DEPTH = 6;

/**
 * Whether an MCP mutation argument sets a secret field to an empty or
 * whitespace-only string, the shape a read-then-write round trip produces
 * once the read blanked the value. Recurses through objects and arrays down
 * to {@link EMPTIED_SECRET_MAX_DEPTH} levels, so a nested row such as
 * `metadata.postgres.databasePassword` or `items[0].password` is caught;
 * returns the offending field name.
 */
export const findEmptiedSecretField = (args: unknown): string | null => {
	const visit = (node: unknown, depth: number): string | null => {
		if (depth > EMPTIED_SECRET_MAX_DEPTH) return null;
		if (Array.isArray(node)) {
			for (const item of node) {
				const found = visit(item, depth + 1);
				if (found) return found;
			}
			return null;
		}
		if (!isPlainObject(node)) return null;
		for (const [key, value] of Object.entries(node)) {
			if (
				isSecretKey(key) &&
				((typeof value === "string" && value.trim() === "") ||
					(value === null && NULLABLE_BLOCK_KEYS.has(key.toLowerCase())))
			) {
				return key;
			}
		}
		for (const value of Object.values(node)) {
			const found = visit(value, depth + 1);
			if (found) return found;
		}
		return null;
	};
	return visit(args, 0);
};

/**
 * Scrubs credentials out of an error message before it reaches an MCP
 * client: URL userinfo (`scheme://user:pass@` → `scheme://***@`), a
 * `--token <x>` flag, and `token=<x>`-style assignments (`=` only, so a message like
 * "password: too short" stays readable).
 */
export const scrubSecretsInText = (text: string): string =>
	text
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1***@")
		.replace(
			/("[A-Za-z_]*(?:token|password|passwd|secret|api_?key)"\s*:\s*")[^"]*(")/gi,
			"$1***$2",
		)
		.replace(
			/(--(?:token|password|passwd|secret|api-key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi,
			"$1***",
		)
		.replace(
			/\b((?:access_?|refresh_?|api_?|auth_?|bearer_?)?(?:token|password|passwd|secret|api_?key))(\s*=\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi,
			"$1$2***",
		);

/** `-p` followed by a port mapping (`8080:80`, `127.0.0.1:80:80/tcp`) or a path (`mkdir -p /a/b`) is not a password. */
const looksLikePortMapping = (value: string) =>
	/^(\d{1,3}(\.\d{1,3}){3}:)?\d+(:\d+)?(\/(tcp|udp|sctp))?$/i.test(value) ||
	/^[/~.]/.test(value);

/**
 * {@link scrubSecretsInText} plus the `-p <password>` / `-p<password>` flag,
 * for fields known to hold a command line (where `-p` is a flag and not
 * prose). A value that looks like a port mapping is left alone.
 */
export const scrubCommandText = (text: string): string =>
	scrubSecretsInText(text).replace(
		/(^|\s)-p(\s*)(\S+)/g,
		(match, lead: string, gap: string, value: string) =>
			looksLikePortMapping(value) ? match : `${lead}-p${gap}***`,
	);

/**
 * Runs {@link scrubCommandText} over every `command` and `args` string (or
 * string array) in a result, at any depth, copying only what changes. For a
 * result where those fields really are argv (a container process listing);
 * never for service rows, where `command`/`args` is configuration the
 * caller may read, edit and write back.
 */
export const scrubCommandFields = (node: unknown): unknown => {
	if (Array.isArray(node)) {
		let copy: unknown[] | null = null;
		node.forEach((item, index) => {
			const next = scrubCommandFields(item);
			if (next === item) return;
			copy ??= node.slice();
			copy[index] = next;
		});
		return copy ?? node;
	}
	if (!isPlainObject(node)) return node;
	let copy: AnyRecord | null = null;
	for (const [key, value] of Object.entries(node)) {
		const lower = key.toLowerCase();
		let next: unknown;
		if (
			(lower === "command" || lower === "args") &&
			typeof value === "string"
		) {
			next = scrubCommandText(value);
		} else if (
			(lower === "command" || lower === "args") &&
			Array.isArray(value) &&
			value.every((entry) => typeof entry === "string")
		) {
			next = value.map((entry) => scrubCommandText(entry as string));
			if ((next as string[]).every((entry, i) => entry === value[i])) {
				next = value;
			}
		} else {
			next = scrubCommandFields(value);
		}
		if (next !== value) {
			copy ??= { ...node };
			copy[key] = next;
		}
	}
	return copy ?? node;
};
