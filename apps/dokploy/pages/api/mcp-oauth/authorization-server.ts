import { isMcpDisabled, resolveMcpOrigin } from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { buildAuthorizationServerMetadata } from "@/server/mcp/discovery";

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		return res.status(405).end();
	}
	if (isMcpDisabled()) return res.status(404).end();
	const origin = await resolveMcpOrigin(req.headers);
	if (!origin) return res.status(503).json({ error: "mcp_unconfigured" });
	res.setHeader("Cache-Control", "public, max-age=300");
	return res.status(200).json(buildAuthorizationServerMetadata(origin));
}
