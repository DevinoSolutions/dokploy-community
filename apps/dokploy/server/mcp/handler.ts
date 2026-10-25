import { db } from "@dokploy/server/db";
import { user as userTable } from "@dokploy/server/db/schema";
import {
	buildMemberSession,
	verifyApiKeyDetailed,
} from "@dokploy/server/lib/auth";
import {
	DOKPLOY_MCP_SCOPE_IDS,
	findMcpAccessToken,
	resolveDefaultOrganizationId,
} from "@dokploy/server/services/mcp-oauth";
import {
	EnvMergeError,
	type MergeSummary,
	envBlockLosses,
	mergeEnvText,
	summarizeMerge,
} from "@dokploy/server/services/env-merge";
import {
	findEmptiedSecretField,
	listEnvKeys,
	redactToolResult,
	scrubCommandFields,
	scrubSecretsInText,
} from "@dokploy/server/services/service-secrets";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import packageInfo from "../../package.json";
import { captureError } from "../sentry";
import {
	ENV_BLOCK_FIELDS,
	MERGE_ENV_ARG,
	type McpToolDefinition,
	REPLACE_ALL_ARG,
	UNSET_KEYS_ARG,
	envFieldsOf,
	isEnvSaveTool,
	isEnvUpdateTool,
	toolsForScopes,
} from "./registry";
import { CREDENTIAL_QUERIES, resolveInputScope } from "./scopes";

export interface McpAuth {
	userId: string;
	clientId: string;
	scopes: Set<string>;
	session: Awaited<ReturnType<typeof buildMemberSession>>["session"] & {
		/** OAuth bearer grants only: the client the token was issued to. */
		oauthClientId?: string;
	};
	user: Awaited<ReturnType<typeof buildMemberSession>>["user"];
	/**
	 * API-key grants only: admitted on a check another request made (recent
	 * or still in flight). Such a grant must be re-verified before it runs a
	 * tool, so the key's rate limit still counts every tool call.
	 */
	reusedVerification?: boolean;
}

/** Bearer → token row → default organization → synthesized member session. */
export const authenticateMcpBearer = async (
	authorization: string | undefined,
): Promise<McpAuth | null> => {
	if (!authorization?.startsWith("Bearer ")) return null;
	const token = await findMcpAccessToken(
		authorization.slice("Bearer ".length).trim(),
	);
	if (!token) return null;
	const organizationId = await resolveDefaultOrganizationId(token.userId);
	if (!organizationId) return null;
	const userRow = await db.query.user.findFirst({
		where: eq(userTable.id, token.userId),
	});
	if (!userRow) return null;
	const { session, user } = await buildMemberSession(userRow, organizationId);
	return {
		userId: token.userId,
		clientId: token.clientId,
		scopes: new Set(token.scopes),
		// The OAuth client rides on the session so the cancel trail can name it.
		session: { ...session, oauthClientId: token.clientId },
		user,
	};
};

/**
 * Marker `clientId` for grants that came from a Dokploy API key rather than
 * an OAuth client; the Settings → Profile client list keys on OAuth clients.
 */
export const MCP_API_KEY_CLIENT_ID = "api-key";

/**
 * The API key is valid but over its per-key rate limit. The endpoint answers
 * 429 + Retry-After for this, never 401: a 401 tells MCP clients the login is
 * gone, and Claude Code then marks the server "needs authentication" for every
 * session on the machine.
 */
export class McpApiKeyRateLimitedError extends Error {
	readonly retryAfterSeconds: number;

	constructor(retryAfterSeconds: number) {
		super(`API key rate limit exceeded; retry in ${retryAfterSeconds}s`);
		this.name = "McpApiKeyRateLimitedError";
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/**
 * How long a verified API key is reused to admit a request. Every MCP client
 * opens with several protocol requests (initialize, notifications,
 * tools/list), so without reuse N sessions starting together spend 3N of the
 * key's rate limit before doing any work. The endpoint re-verifies tool calls
 * that were admitted from a reused check.
 */
export const MCP_API_KEY_HANDSHAKE_TTL_MS = 60_000;
const MCP_API_KEY_HANDSHAKE_CACHE_MAX = 500;

const handshakeAuthCache = new Map<
	string,
	{ auth: McpAuth; expiresAt: number }
>();
const pendingHandshakeAuth = new Map<string, Promise<McpAuth | null>>();

const apiKeyCacheId = (apiKey: string) =>
	createHash("sha256").update(apiKey).digest("hex");

const rememberHandshakeAuth = (cacheId: string, auth: McpAuth) => {
	handshakeAuthCache.delete(cacheId);
	if (handshakeAuthCache.size >= MCP_API_KEY_HANDSHAKE_CACHE_MAX) {
		const oldest = handshakeAuthCache.keys().next().value;
		if (oldest !== undefined) handshakeAuthCache.delete(oldest);
	}
	handshakeAuthCache.set(cacheId, {
		auth,
		expiresAt: Date.now() + MCP_API_KEY_HANDSHAKE_TTL_MS,
	});
};

/** Test hook: forget every reused API-key verification. */
export const clearMcpApiKeyHandshakeCache = () => {
	handshakeAuthCache.clear();
	pendingHandshakeAuth.clear();
};

export interface McpAuthenticateOptions {
	/**
	 * False to admit the request on a recent verification of the same API key,
	 * with concurrent checks sharing one lookup, so a burst of clients does not
	 * drain the key's rate limit. Defaults to true (always verify).
	 */
	countsAgainstRateLimit?: boolean;
}

/**
 * `x-api-key` → the same member session the REST API builds for that key,
 * with every MCP scope. API keys never expire or rotate, so an automation
 * fleet that shares one MCP configuration does not depend on a single OAuth
 * grant surviving every client on the machine. Throws
 * {@link McpApiKeyRateLimitedError} when the key is throttled.
 */
export const authenticateMcpApiKey = async (
	apiKey: string | undefined,
	{ countsAgainstRateLimit = true }: McpAuthenticateOptions = {},
): Promise<McpAuth | null> => {
	if (!apiKey) return null;
	const cacheId = apiKeyCacheId(apiKey);

	const verify = async (): Promise<McpAuth | null> => {
		const verification = await verifyApiKeyDetailed(apiKey);
		if (verification.status === "rate_limited") {
			throw new McpApiKeyRateLimitedError(verification.retryAfterSeconds);
		}
		if (verification.status === "invalid") {
			handshakeAuthCache.delete(cacheId);
			return null;
		}
		const { session, user } = verification.member;
		const auth: McpAuth = {
			userId: user.id,
			clientId: MCP_API_KEY_CLIENT_ID,
			scopes: new Set<string>(DOKPLOY_MCP_SCOPE_IDS),
			session,
			user,
		};
		rememberHandshakeAuth(cacheId, auth);
		return auth;
	};

	if (countsAgainstRateLimit) return verify();

	const reused = (auth: McpAuth | null): McpAuth | null =>
		auth && { ...auth, reusedVerification: true };
	const cached = handshakeAuthCache.get(cacheId);
	if (cached && cached.expiresAt > Date.now()) return reused(cached.auth);
	const pending = pendingHandshakeAuth.get(cacheId);
	if (pending) return pending.then(reused);
	const lookup = verify().finally(() => pendingHandshakeAuth.delete(cacheId));
	pendingHandshakeAuth.set(cacheId, lookup);
	return lookup;
};

/** `x-api-key` wins when present; otherwise the OAuth bearer path. */
export const authenticateMcpRequest = async (
	headers: IncomingHttpHeaders,
	options: McpAuthenticateOptions = {},
): Promise<McpAuth | null> => {
	const apiKey = headers["x-api-key"];
	if (typeof apiKey === "string" && apiKey) {
		return authenticateMcpApiKey(apiKey, options);
	}
	return authenticateMcpBearer(headers.authorization);
};

/**
 * True when a parsed JSON-RPC body (single message or batch) invokes a tool.
 * Anything else is protocol traffic that may ride on a recent API-key check.
 */
export const invokesTool = (body: unknown): boolean => {
	const messages = Array.isArray(body) ? body : [body];
	return messages.some(
		(message) =>
			typeof message !== "object" ||
			message === null ||
			(message as { method?: unknown }).method === "tools/call",
	);
};

/**
 * Diagnostic for "MCP keeps asking me to log in" reports: classify why a
 * request carrying credentials was refused. Only a token prefix is logged.
 */
export const describeRejectedMcpRequest = (headers: IncomingHttpHeaders) => {
	const apiKey = headers["x-api-key"];
	if (typeof apiKey === "string" && apiKey) return "api_key_invalid";
	const authorization = headers.authorization;
	if (!authorization) return "no_credentials";
	if (!authorization.startsWith("Bearer ")) return "not_bearer";
	const token = authorization.slice("Bearer ".length).trim();
	if (!token) return "empty_bearer";
	return `bearer_rejected tokenPrefix=${token.slice(0, 8)}`;
};

export const unauthorizedPayload = (origin: string) => {
	const wwwAuthenticate = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
	return {
		status: 401 as const,
		headers: {
			"WWW-Authenticate": wwwAuthenticate,
			"Access-Control-Expose-Headers": "WWW-Authenticate",
		},
		body: {
			jsonrpc: "2.0" as const,
			error: { code: -32000, message: "Unauthorized: Authentication required" },
			id: null,
		},
	};
};

/**
 * Refusal raised while reading the JSON-RPC body, carrying the HTTP status and
 * JSON-RPC error code the endpoint should answer with.
 */
export class McpRequestBodyError extends Error {
	readonly status: number;
	readonly rpcCode: number;

	constructor(status: number, rpcCode: number, message: string) {
		super(message);
		this.name = "McpRequestBodyError";
		this.status = status;
		this.rpcCode = rpcCode;
	}
}

export interface JsonBodyRequest extends AsyncIterable<Buffer | string> {
	headers: IncomingHttpHeaders;
}

/**
 * Reads and parses the JSON-RPC body with a hard byte ceiling. The SDK's own
 * `handleRequest` buffers the whole stream with no limit, so the body is read
 * here and handed to it pre-parsed. Aborts as soon as the limit is passed
 * rather than after buffering everything.
 */
export const readJsonBody = async (
	req: JsonBodyRequest,
	limit: number,
): Promise<unknown> => {
	const contentType = req.headers["content-type"];
	const mediaType =
		typeof contentType === "string"
			? contentType.split(";")[0]?.trim().toLowerCase()
			: undefined;
	if (mediaType !== "application/json") {
		throw new McpRequestBodyError(
			415,
			-32000,
			"Unsupported Media Type. MCP over Streamable HTTP requires application/json.",
		);
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		size += buffer.length;
		if (size > limit) {
			throw new McpRequestBodyError(413, -32000, "Payload too large");
		}
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new McpRequestBodyError(400, -32700, "Parse error");
	}
};

export type ProcedureCall = (path: string, args: unknown) => Promise<unknown>;

/**
 * Declared as a type alias, not an interface: the SDK's `CallToolResult` is a
 * loose object (it carries an index signature) and only type aliases get an
 * implicit index signature, so an interface here fails to assign.
 */
export type ToolCallResult = {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: true;
};

/** Error text goes through the scrub: a message can quote a URL or a flag with a token in it. */
const errorResult = (text: string): ToolCallResult => ({
	content: [{ type: "text", text: scrubSecretsInText(text) }],
	isError: true,
});

/** Procedures can return bigint columns, which plain JSON.stringify throws on. */
const bigintReplacer = (_key: string, value: unknown) =>
	typeof value === "bigint" ? value.toString() : value;

/**
 * `*.one` reads that return a service row with secret values (env, build
 * args and secrets, database passwords, tokens). They take `includeEnv`; the
 * dispatcher, not the caller, decides it (T-6991).
 */
export const SECRET_READ_PATHS: ReadonlySet<string> = new Set([
	"application.one",
	"compose.one",
	"postgres.one",
	"mysql.one",
	"mariadb.one",
	"mongo.one",
	"redis.one",
	"libsql.one",
]);

/** The one scope whose grant already covers reading stored credentials. */
export const SECRET_READ_SCOPE = "dokploy:admin";

/**
 * Forces `includeEnv` on the secret-bearing reads. Values are omitted unless
 * the call passes `includeEnv: true` AND the grant includes
 * `dokploy:admin` (the scope that gates every other credential read); any
 * other value, or a missing one, becomes false. The tool schema only
 * documents this: the override here is what enforces it.
 */
export const applySecretReadPolicy = (
	path: string,
	args: unknown,
	scopes: Set<string>,
): unknown => {
	if (!SECRET_READ_PATHS.has(path)) return args;
	const input =
		typeof args === "object" && args !== null && !Array.isArray(args)
			? (args as Record<string, unknown>)
			: {};
	return {
		...input,
		includeEnv: input.includeEnv === true && scopes.has(SECRET_READ_SCOPE),
	};
};

/**
 * Admin-scope tools whose whole purpose is to hand back a credential, so their
 * result is not blanked: every credential query in the scope table, plus the
 * mutations that mint one (an API key, an instance or SCIM token, a generated
 * SSH key pair). Each already requires `dokploy:admin`.
 */
export const CREDENTIAL_RESULT_PATHS: ReadonlySet<string> = new Set([
	...CREDENTIAL_QUERIES,
	"user.createApiKey",
	"user.generateToken",
	"scim.generateToken",
	"scim.rotateToken",
	"sshKey.generate",
]);

/**
 * Read-scope tools whose result is variable NAMES by construction: the `env`
 * array in an envKeys reply holds keys, and the generic walk would blank it.
 */
export const KEYS_ONLY_RESULT_PATHS: ReadonlySet<string> = new Set([
	"application.envKeys",
	"compose.envKeys",
	"postgres.envKeys",
	"mysql.envKeys",
	"mariadb.envKeys",
	"mongo.envKeys",
	"redis.envKeys",
	"libsql.envKeys",
]);

/** Argument that lets an admin write an empty value into a secret field. */
export const ALLOW_EMPTY_SECRETS_ARG = "allowEmptySecrets";

/**
 * A read over MCP blanks secret values, so a read-modify-write loop sends the
 * blank straight back. For a mutation, refuses any secret-named field set to an
 * empty or whitespace-only string (top level and nested), unless the call
 * passes `allowEmptySecrets: true` AND the grant has `dokploy:admin`. The flag
 * is stripped before the procedure sees the arguments. A `create*` mutation
 * has no stored value to erase, so it is not checked.
 *
 * This check knows nothing about what is stored: the exemptions that depend on
 * it (an empty block with nothing in it, a public docker image) are in
 * {@link guardMcpWrite}.
 */
export const guardSecretWriteBack = (
	tool: Pick<McpToolDefinition, "name" | "type" | "procedureName"> &
		Partial<Pick<McpToolDefinition, "routerName">>,
	args: unknown,
	scopes: Set<string>,
): { args: unknown; error?: string } => {
	if (tool.type !== "mutation") return { args };
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return { args };
	}
	const { [ALLOW_EMPTY_SECRETS_ARG]: flag, ...rest } = args as Record<
		string,
		unknown
	>;
	if (flag === true && scopes.has(SECRET_READ_SCOPE)) return { args: rest };
	if (/^create/i.test(tool.procedureName)) return { args: rest };
	const field = findEmptiedSecretField(rest);
	if (!field) return { args: rest };
	const shape = {
		type: tool.type,
		routerName: tool.routerName ?? "",
		procedureName: tool.procedureName,
	};
	const alsoReplace =
		isEnvSaveTool(shape) || isEnvUpdateTool(shape)
			? ` and ${REPLACE_ALL_ARG}: true`
			: "";
	return {
		args: rest,
		error: `BAD_REQUEST: ${tool.name} sets \`${field}\` to an empty value. Secret values are redacted when read over MCP (they read back as ""), so writing that back would erase the stored secret. Leave the field out to keep it unchanged, use the envKeys tool to see which variables exist, and send the full set you want to keep (saveEnvironment replaces the whole env; pass ${MERGE_ENV_ARG}: true to change only some variables). To clear a value on purpose, repeat the call with ${ALLOW_EMPTY_SECRETS_ARG}: true${alsoReplace}, which needs the ${SECRET_READ_SCOPE} scope.`,
	};
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

type GuardedArgs = {
	args: unknown;
	error?: string;
	/** After a `mergeEnv` save: what each block gained and lost, counts and names only. */
	mergeReport?: Array<{ block: string } & MergeSummary>;
};

type GuardInput = {
	tool: McpToolDefinition;
	args: unknown;
	scopes: Set<string>;
	call: ProcedureCall;
};

/** Scope that lets a caller see variable names (`envKeys` is a read-scope tool). */
const NAMES_SCOPE = "dokploy:read";

/** How many variable names an error lists before summarizing the rest. */
const MAX_LISTED_KEYS = 50;

const describeKeys = (keys: string[]) =>
	keys.length <= MAX_LISTED_KEYS
		? keys.join(", ")
		: `${keys.slice(0, MAX_LISTED_KEYS).join(", ")} and ${keys.length - MAX_LISTED_KEYS} more`;

const omitKeys = (
	source: Record<string, unknown>,
	keys: readonly string[],
): Record<string, unknown> => {
	const copy = { ...source };
	for (const key of keys) delete copy[key];
	return copy;
};

const storedText = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * Reads the service row (or project/environment) a call writes to, server
 * side and with the real values: they are only compared or merged here and
 * never returned. Null when the row cannot be trusted.
 */
const makeRowReader = (
	tool: McpToolDefinition,
	idField: string,
	id: string,
	call: ProcedureCall,
) => {
	let row: Promise<Record<string, unknown> | null> | undefined;
	return () => {
		row ??= call(`${tool.routerName}.one`, {
			[idField]: id,
			...(SECRET_READ_PATHS.has(`${tool.routerName}.one`)
				? { includeEnv: true }
				: {}),
		}).then((value) =>
			isRecord(value) && value.secretsRedacted !== true ? value : null,
		);
		return row;
	};
};

/** `unsetKeys`: an array of names (for `env`) or `{ env, buildArgs, buildSecrets }` arrays. */
const parseUnsetKeys = (
	raw: unknown,
): { unset: Record<string, string[]> } | { error: string } => {
	const bad = {
		error: `${UNSET_KEYS_ARG} must be an array of variable names (for env) or an object with env, buildArgs and buildSecrets arrays of names`,
	};
	if (raw === undefined) return { unset: {} };
	const isNames = (value: unknown): value is string[] =>
		Array.isArray(value) && value.every((name) => typeof name === "string");
	if (isNames(raw)) return { unset: { env: raw } };
	if (!isRecord(raw)) return bad;
	const unset: Record<string, string[]> = {};
	for (const [field, names] of Object.entries(raw)) {
		if (!(ENV_BLOCK_FIELDS as readonly string[]).includes(field)) return bad;
		if (!isNames(names)) return bad;
		unset[field] = names;
	}
	return { unset };
};

/**
 * `saveEnvironment` replaces the whole variable set, and a read over MCP
 * returns every value blank, so a client that reads and then sends
 * `NEW=1` silently erases the other variables (T-7007). The `*-update` tools
 * of the same services, and of projects and environments (shared env), take
 * the same blocks. Over MCP only (the dashboard calls the procedure directly):
 *
 * - default: refuse a call whose blocks would drop variables that exist now,
 *   or keep a name but blank its value. The error counts them and, with
 *   `dokploy:read`, names them; never values. `null` counts as an empty block.
 * - `replaceAll: true`: replace the blocks sent on purpose.
 * - `mergeEnv: true` (saveEnvironment only): the variables sent are set or
 *   added, the rest are kept, and `unsetKeys` removes named ones. The merge
 *   runs here, against the stored values, which never leave the server.
 *
 * The flags are stripped before the procedure sees the arguments.
 */
export const guardEnvironmentWrite = async ({
	tool,
	args,
	scopes,
	call,
}: GuardInput): Promise<GuardedArgs> => {
	if (!isRecord(args)) return { args };
	const isSave = isEnvSaveTool(tool);
	const {
		[REPLACE_ALL_ARG]: replaceAll,
		[MERGE_ENV_ARG]: mergeEnv,
		[UNSET_KEYS_ARG]: unsetKeys,
		...input
	} = args;
	const fail = (message: string): GuardedArgs => ({
		args: input,
		error: `BAD_REQUEST: ${tool.name} ${message}`,
	});
	if (!isSave && (mergeEnv !== undefined || unsetKeys !== undefined)) {
		return fail(
			`does not take ${MERGE_ENV_ARG} or ${UNSET_KEYS_ARG}; they only work with saveEnvironment.`,
		);
	}
	const merge = mergeEnv === true;
	if (merge && replaceAll === true) {
		return fail(`cannot combine ${MERGE_ENV_ARG} with ${REPLACE_ALL_ARG}.`);
	}
	if (unsetKeys !== undefined && !merge) {
		return fail(
			`${UNSET_KEYS_ARG} only works together with ${MERGE_ENV_ARG}: true.`,
		);
	}
	const idField = `${tool.routerName}Id`;
	const id = input[idField];
	if (typeof id !== "string" || id === "") {
		// Let the procedure's own input validation name the problem.
		return guardSecretWriteBack(tool, input, scopes);
	}
	const readRow = makeRowReader(tool, idField, id, call);
	const blockFields = envFieldsOf(tool);
	const sent = blockFields.filter((field) => input[field] !== undefined);
	for (const field of sent) {
		const value = input[field];
		if (typeof value === "string" || (value === null && !merge)) continue;
		return fail(
			`${field} must be a string${merge ? "" : " or null"}, not ${value === null ? "null" : typeof value}.`,
		);
	}
	const forwarded = omitKeys(input, [ALLOW_EMPTY_SECRETS_ARG]);

	if (merge) {
		const parsed = parseUnsetKeys(unsetKeys);
		if ("error" in parsed) return fail(`${parsed.error}.`);
		// Empty strings in the blocks are "no change" here, not an erased secret.
		const checked = guardSecretWriteBack(
			tool,
			omitKeys(input, blockFields),
			scopes,
		);
		if (checked.error) return { args: input, error: checked.error };
		for (const field of Object.keys(parsed.unset)) {
			if (!(blockFields as readonly string[]).includes(field)) {
				return fail(`${tool.routerName} has no ${field} to unset keys from.`);
			}
		}
		const row = await readRow();
		if (!row) {
			return fail(
				`could not read the stored variables to merge with; use ${REPLACE_ALL_ARG}: true to replace them instead.`,
			);
		}
		const next: Record<string, unknown> = { ...forwarded };
		const report: NonNullable<GuardedArgs["mergeReport"]> = [];
		for (const field of blockFields) {
			if (!(field in row)) continue;
			const stored = storedText(row[field]);
			const incoming = (input[field] as string | undefined) ?? "";
			const unset = parsed.unset[field] ?? [];
			if (incoming.trim() !== "" && listEnvKeys(incoming).length === 0) {
				return fail(
					`${field} contains no KEY=VALUE definitions to merge. Send dotenv-style lines, or an empty string for a block you do not change.`,
				);
			}
			if (incoming === "" && unset.length === 0) {
				// Nothing to change: keep the stored block as it is.
				next[field] = stored;
				continue;
			}
			try {
				next[field] = mergeEnvText(stored, incoming, unset);
			} catch (error) {
				if (error instanceof EnvMergeError) {
					return fail(
						`cannot merge ${field}: ${error.message}. Use ${REPLACE_ALL_ARG}: true to replace it instead.`,
					);
				}
				throw error;
			}
			report.push({ block: field, ...summarizeMerge(stored, incoming, unset) });
		}
		return { args: next, mergeReport: report };
	}

	let guarded = guardSecretWriteBack(tool, input, scopes);
	if (guarded.error) {
		// An empty block is only an erased secret when something is stored in
		// it, and a save always carries every block (most services have no
		// build secrets): look at what is stored before refusing.
		const empty = sent.filter(
			(field) =>
				input[field] === null || (input[field] as string).trim() === "",
		);
		if (empty.length === 0) return { args: input, error: guarded.error };
		const row = await readRow();
		const checked = { ...input };
		for (const field of empty) {
			if (
				row &&
				field in row &&
				listEnvKeys(storedText(row[field])).length === 0
			) {
				delete checked[field];
			}
		}
		guarded = guardSecretWriteBack(tool, checked, scopes);
		if (guarded.error) return { args: input, error: guarded.error };
	}
	if (replaceAll === true || sent.length === 0) return { args: forwarded };

	const row = await readRow();
	if (!row) {
		return fail(
			`could not read the stored variables to compare with; use ${REPLACE_ALL_ARG}: true to replace them anyway.`,
		);
	}
	const canName = scopes.has(NAMES_SCOPE);
	const dropped: string[] = [];
	const blanked: string[] = [];
	const droppedBy: string[] = [];
	const blankedBy: string[] = [];
	const label = (field: string, names: string[]) =>
		canName ? `${field}: ${describeKeys(names)}` : `${field}: ${names.length}`;
	for (const field of sent) {
		if (!(field in row)) {
			return fail(
				`could not read the stored ${field} to compare with; use ${REPLACE_ALL_ARG}: true to replace it anyway.`,
			);
		}
		const losses = envBlockLosses(
			storedText(row[field]),
			storedText(input[field]),
		);
		if (losses.dropped.length > 0) {
			dropped.push(...losses.dropped);
			droppedBy.push(label(field, losses.dropped));
		}
		if (losses.blanked.length > 0) {
			blanked.push(...losses.blanked);
			blankedBy.push(label(field, losses.blanked));
		}
	}
	if (dropped.length === 0 && blanked.length === 0) {
		return { args: forwarded };
	}
	const parts: string[] = [];
	if (dropped.length > 0) {
		parts.push(
			`drop ${dropped.length} existing variable(s) (${droppedBy.join("; ")})`,
		);
	}
	if (blanked.length > 0) {
		parts.push(
			`blank the value of ${blanked.length} existing variable(s) (${blankedBy.join("; ")})`,
		);
	}
	const how = isSave
		? `To set or add only some variables and keep the others, repeat with ${MERGE_ENV_ARG}: true (${UNSET_KEYS_ARG} removes named ones). To replace everything on purpose, repeat with ${REPLACE_ALL_ARG}: true.`
		: `Send the variables you want to keep with their values, or repeat with ${REPLACE_ALL_ARG}: true to replace the block on purpose.`;
	return fail(
		`would ${parts.join(" and ")}. Values read back blank over MCP, so a partial or blanked list erases the rest.${canName ? "" : ` Variable names need the ${NAMES_SCOPE} scope.`} ${how}`,
	);
};

/**
 * `saveDockerProvider` with an empty password and no username is a public
 * image: no registry credentials. That is only legitimate when none are stored
 * either; otherwise the empty password would clear a stored credential, which
 * stays an admin-only `allowEmptySecrets` write. The username has to be sent
 * (empty or null): a missing one leaves the stored username in place.
 */
export const guardDockerProviderSave = async ({
	tool,
	args,
	scopes,
	call,
}: GuardInput): Promise<GuardedArgs> => {
	const strict = guardSecretWriteBack(tool, args, scopes);
	if (!strict.error || !isRecord(args)) return strict;
	const { password, username, applicationId } = args;
	const noUsername =
		username === null ||
		(typeof username === "string" && username.trim() === "");
	if (
		typeof password !== "string" ||
		password.trim() !== "" ||
		!noUsername ||
		typeof applicationId !== "string"
	) {
		return strict;
	}
	// Any other emptied secret in the call is still refused.
	if (guardSecretWriteBack(tool, omitKeys(args, ["password"]), scopes).error) {
		return strict;
	}
	const row = await call("application.one", {
		applicationId,
		includeEnv: true,
	});
	if (!isRecord(row) || row.secretsRedacted === true) return strict;
	if (
		storedText(row.username).trim() !== "" ||
		storedText(row.password) !== ""
	) {
		return strict;
	}
	return {
		args: {
			...omitKeys(args, [ALLOW_EMPTY_SECRETS_ARG]),
			username: typeof username === "string" ? "" : username,
		},
	};
};

/** Every write guard, picked by tool. */
export const guardMcpWrite = (
	input: GuardInput,
): Promise<GuardedArgs> | GuardedArgs => {
	const { tool, args, scopes } = input;
	if (isEnvSaveTool(tool) || isEnvUpdateTool(tool)) {
		return guardEnvironmentWrite(input);
	}
	if (tool.type === "mutation" && tool.procedureName === "saveDockerProvider") {
		return guardDockerProviderSave(input);
	}
	return guardSecretWriteBack(tool, args ?? {}, scopes);
};

/**
 * Tools whose result carries real argv in `command`/`args`, so the command
 * line is scrubbed of flag and URL credentials. Only these: a service's own
 * `command`/`args` is configuration that must read back unchanged.
 */
export const COMMAND_LINE_RESULT_PATHS: ReadonlySet<string> = new Set([
	"server.getContainerProcesses",
]);

/**
 * Whether a tool result is blanked before it is returned: always, except for
 * a credential tool, an envKeys tool (names only), and a `.one` read whose (already admin-gated)
 * `includeEnv` is true.
 */
export const shouldRedactResult = (path: string, forcedArgs: unknown) => {
	if (CREDENTIAL_RESULT_PATHS.has(path)) return false;
	if (KEYS_ONLY_RESULT_PATHS.has(path)) return false;
	if (
		SECRET_READ_PATHS.has(path) &&
		typeof forcedArgs === "object" &&
		forcedArgs !== null &&
		(forcedArgs as { includeEnv?: unknown }).includeEnv === true
	) {
		return false;
	}
	return true;
};

/** Scope check, then execution through the injected tRPC caller. */
export const executeMcpTool = async ({
	tool,
	args,
	scopes,
	call,
}: {
	tool: McpToolDefinition;
	args: unknown;
	scopes: Set<string>;
	call: ProcedureCall;
}): Promise<ToolCallResult> => {
	if (!scopes.has(tool.scope)) {
		return errorResult(
			`Tool ${tool.name} requires scope ${tool.scope}, which this authorization does not include. Re-authorize with that scope enabled.`,
		);
	}
	const inputScope = resolveInputScope(tool.path, args);
	if (inputScope && !scopes.has(inputScope)) {
		return errorResult(
			`Tool ${tool.name} with type "fetch" clones the source and requires scope ${inputScope}, which this authorization does not include. Use type "cache", or re-authorize with that scope enabled.`,
		);
	}
	try {
		const guarded = await guardMcpWrite({
			tool,
			args: args ?? {},
			scopes,
			call,
		});
		if (guarded.error) return errorResult(guarded.error);
		const callArgs = applySecretReadPolicy(tool.path, guarded.args, scopes);
		const written = await call(tool.path, callArgs);
		// A merge answers with what it set and removed (counts), not a bare true.
		const raw = guarded.mergeReport
			? { saved: written, merge: guarded.mergeReport }
			: written;
		// Second line of defence: whatever a route nests (a service row inside
		// an environment, a project, a search hit) loses its secret fields.
		const redacted = shouldRedactResult(tool.path, callArgs)
			? redactToolResult(raw)
			: raw;
		const result = COMMAND_LINE_RESULT_PATHS.has(tool.path)
			? scrubCommandFields(redacted)
			: redacted;
		const text =
			result === undefined ? "null" : JSON.stringify(result, bigintReplacer);
		// Reuse the serialized form so structuredContent is JSON-safe too: a
		// bigint anywhere in it would otherwise throw inside the transport.
		const structured =
			result && typeof result === "object" && !Array.isArray(result)
				? (JSON.parse(text) as Record<string, unknown>)
				: undefined;
		return {
			content: [{ type: "text", text }],
			...(structured ? { structuredContent: structured } : {}),
		};
	} catch (error) {
		if (error instanceof TRPCError) {
			return errorResult(`${error.code}: ${error.message}`);
		}
		captureError(error, { handler: "mcp", tool: tool.name });
		console.error(`[mcp] ${tool.name} failed`, error);
		return errorResult(
			`INTERNAL_SERVER_ERROR: ${tool.name} failed unexpectedly`,
		);
	}
};

/** Builds a `call` bound to a tRPC caller: `caller[router][procedure](args)`. */
export const makeProcedureCall = (
	caller: Record<string, Record<string, (input: unknown) => Promise<unknown>>>,
): ProcedureCall => {
	return (path, args) => {
		const [routerName, ...rest] = path.split(".");
		const procedureName = rest.join(".");
		const procedure = caller[routerName ?? ""]?.[procedureName];
		if (!procedure) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `Unknown tool path ${path}`,
			});
		}
		return procedure(args);
	};
};

/**
 * One MCP `Server` per HTTP request: tools/list filtered to the grant,
 * tools/call scope-checked then executed. Cheap: the registry is prebuilt.
 */
export const createMcpRequestServer = ({
	tools,
	scopes,
	call,
}: {
	tools: McpToolDefinition[];
	scopes: Set<string>;
	call: ProcedureCall;
}) => {
	const server = new Server(
		{ name: "dokploy", version: packageInfo.version },
		{ capabilities: { tools: {} } },
	);
	const allowed = toolsForScopes(tools, scopes);
	const byName = new Map(allowed.map((tool) => [tool.name, tool]));

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: allowed.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema as {
				type: "object";
				[key: string]: unknown;
			},
			annotations: tool.annotations,
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = byName.get(request.params.name);
		if (!tool) {
			return errorResult(
				`Unknown tool ${request.params.name} (not granted or does not exist)`,
			);
		}
		return executeMcpTool({
			tool,
			args: request.params.arguments,
			scopes,
			call,
		});
	});

	return server;
};
