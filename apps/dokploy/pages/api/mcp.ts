import {
	isMcpDisabled,
	OPENAPI_MAX_JSON_BODY_SIZE,
	resolveMcpOrigin,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextApiRequest, NextApiResponse } from "next";
import { appRouter } from "@/server/api/root";
import { createCallerFactory } from "@/server/api/trpc";
import {
	authenticateMcpRequest,
	createMcpRequestServer,
	describeRejectedMcpRequest,
	invokesTool,
	makeProcedureCall,
	McpApiKeyRateLimitedError,
	McpRequestBodyError,
	readJsonBody,
	unauthorizedPayload,
} from "@/server/mcp/handler";
import { getMcpToolRegistry } from "@/server/mcp/registry";
import { captureError } from "@/server/sentry";

// The body is read by readJsonBody so the byte ceiling is enforced while
// streaming; the SDK transport would otherwise buffer it unbounded.
export const config = { api: { bodyParser: false } };

const createCaller = createCallerFactory(appRouter);

const jsonRpcError = (
	res: NextApiResponse,
	status: number,
	message: string,
	code = -32000,
) =>
	res
		.status(status)
		.json({ jsonrpc: "2.0", error: { code, message }, id: null });

/**
 * A throttled API key is still a good key: answer 429 + Retry-After, never
 * 401, or MCP clients drop their login. Anything else is rethrown.
 */
const rejectThrottled = (res: NextApiResponse, error: unknown) => {
	if (!(error instanceof McpApiKeyRateLimitedError)) throw error;
	console.warn(
		`[mcp-diag] request throttled: reason=api_key_rate_limited retryAfter=${error.retryAfterSeconds}s`,
	);
	res.setHeader("Retry-After", String(error.retryAfterSeconds));
	return jsonRpcError(
		res,
		429,
		`Rate limit exceeded for this API key. Retry in ${error.retryAfterSeconds}s.`,
	);
};

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (isMcpDisabled()) {
		return res.status(503).json({
			error: "mcp_disabled",
			message:
				"The MCP server is disabled on this instance (DOKPLOY_MCP_DISABLED=true).",
		});
	}
	const origin = await resolveMcpOrigin(req.headers);
	if (!origin) {
		return res.status(503).json({
			error: "mcp_unconfigured",
			message:
				"The MCP server needs a public origin. Set the server domain under Settings → Server, or set BETTER_AUTH_URL.",
		});
	}
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		return jsonRpcError(
			res,
			405,
			"Method not allowed. MCP over Streamable HTTP uses POST.",
		);
	}
	// Cheap pre-check on the declared length; readJsonBody still enforces the
	// ceiling on the actual stream, since Content-Length can lie or be absent.
	const contentLength = Number(req.headers["content-length"]);
	if (
		Number.isFinite(contentLength) &&
		contentLength > OPENAPI_MAX_JSON_BODY_SIZE
	) {
		return jsonRpcError(res, 413, "Payload too large", -32000);
	}

	const rejectUnauthenticated = () => {
		const reason = describeRejectedMcpRequest(req.headers);
		if (reason !== "no_credentials") {
			console.warn(`[mcp-diag] request rejected: reason=${reason}`);
		}
		const payload = unauthorizedPayload(origin);
		for (const [key, value] of Object.entries(payload.headers)) {
			res.setHeader(key, value);
		}
		return res.status(payload.status).json(payload.body);
	};

	// Authenticate before touching the body. API-key requests are admitted on a
	// recent check of the same key (concurrent checks share one lookup), so a
	// burst of clients opening sessions does not drain the key's rate limit;
	// tool calls admitted that way are re-verified once the body is known.
	let auth: Awaited<ReturnType<typeof authenticateMcpRequest>>;
	try {
		auth = await authenticateMcpRequest(req.headers, {
			countsAgainstRateLimit: false,
		});
	} catch (error) {
		return rejectThrottled(res, error);
	}
	if (!auth) return rejectUnauthenticated();

	let body: unknown;
	try {
		body = await readJsonBody(req, OPENAPI_MAX_JSON_BODY_SIZE);
	} catch (error) {
		if (error instanceof McpRequestBodyError) {
			return jsonRpcError(res, error.status, error.message, error.rpcCode);
		}
		captureError(error, { handler: "mcp-body" });
		return jsonRpcError(res, 400, "Could not read the request body");
	}

	if (auth.reusedVerification && invokesTool(body)) {
		try {
			auth = await authenticateMcpRequest(req.headers);
		} catch (error) {
			return rejectThrottled(res, error);
		}
		if (!auth) return rejectUnauthenticated();
	}

	const caller = createCaller({
		// @ts-ignore — same synthesized shape the REST handler builds via createTRPCContext
		session: auth.session,
		// @ts-ignore
		user: auth.user,
		db,
		req,
		res,
	});
	const server = createMcpRequestServer({
		tools: await getMcpToolRegistry(),
		scopes: auth.scopes,
		call: makeProcedureCall(caller as never),
	});
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
	});
	res.on("close", () => {
		void transport.close();
		void server.close();
	});
	try {
		await server.connect(transport);
		await transport.handleRequest(req, res, body);
	} catch (error) {
		captureError(error, { handler: "mcp-transport" });
		console.error("[mcp] transport failure", error);
		if (!res.headersSent) {
			jsonRpcError(res, 500, "Internal server error", -32603);
		}
	}
}
