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
	authenticateMcpBearer,
	createMcpRequestServer,
	makeProcedureCall,
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

	const auth = await authenticateMcpBearer(req.headers.authorization);
	if (!auth) {
		const payload = unauthorizedPayload(origin);
		for (const [key, value] of Object.entries(payload.headers)) {
			res.setHeader(key, value);
		}
		return res.status(payload.status).json(payload.body);
	}

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
