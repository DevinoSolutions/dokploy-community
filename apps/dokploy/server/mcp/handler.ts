import { db } from "@dokploy/server/db";
import { user as userTable } from "@dokploy/server/db/schema";
import { buildMemberSession } from "@dokploy/server/lib/auth";
import {
	findMcpAccessToken,
	resolveDefaultOrganizationId,
} from "@dokploy/server/services/mcp-oauth";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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
