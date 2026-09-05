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
	unauthorizedPayload,
} from "@/server/mcp/handler";
import { getMcpToolRegistry } from "@/server/mcp/registry";

// The MCP transport reads the raw JSON-RPC body itself.
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
	const contentLength = Number(req.headers["content-length"]);
	if (
		Number.isFinite(contentLength) &&
		contentLength > OPENAPI_MAX_JSON_BODY_SIZE
	) {
		return jsonRpcError(res, 413, "Payload too large");
	}

	const auth = await authenticateMcpBearer(req.headers.authorization);
	if (!auth) {
		const payload = unauthorizedPayload(origin);
		for (const [key, value] of Object.entries(payload.headers)) {
			res.setHeader(key, value);
		}
		return res.status(payload.status).json(payload.body);
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
	await server.connect(transport);
	await transport.handleRequest(req, res);
}
