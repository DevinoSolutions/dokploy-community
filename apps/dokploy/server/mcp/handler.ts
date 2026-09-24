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
import { type McpToolDefinition, toolsForScopes } from "./registry";

export interface McpAuth {
	userId: string;
	clientId: string;
	scopes: Set<string>;
	session: Awaited<ReturnType<typeof buildMemberSession>>["session"];
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
		session,
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

const errorResult = (text: string): ToolCallResult => ({
	content: [{ type: "text", text }],
	isError: true,
});

/** Procedures can return bigint columns, which plain JSON.stringify throws on. */
const bigintReplacer = (_key: string, value: unknown) =>
	typeof value === "bigint" ? value.toString() : value;

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
	try {
		const result = await call(tool.path, args ?? {});
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
