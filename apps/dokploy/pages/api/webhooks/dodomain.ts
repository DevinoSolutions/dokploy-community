import {
	DODOMAIN_DELIVERY_ID_HEADER,
	DODOMAIN_SIGNATURE_HEADER,
	DODOMAIN_WEBHOOK_MAX_BODY_BYTES,
	handleDoDomainWebhook,
} from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * DoDomain webhook receiver (`POST /api/webhooks/dodomain`).
 *
 * The HMAC signature over the raw request bytes is the only authentication,
 * so Next's body parser is disabled: parsing and re-serializing the JSON
 * would change the bytes that were signed. Unsigned or mis-signed requests
 * are refused with 401 before anything is parsed or written.
 */
export const config = {
	api: {
		bodyParser: false,
	},
};

class BodyTooLargeError extends Error {}

const readRawBody = async (req: NextApiRequest, limit: number) => {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer | string>) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		size += buffer.length;
		if (size > limit) throw new BodyTooLargeError();
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
};

const firstValue = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		return res.status(405).json({ error: "method_not_allowed" });
	}

	let rawBody: string;
	try {
		rawBody = await readRawBody(req, DODOMAIN_WEBHOOK_MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof BodyTooLargeError) {
			return res.status(413).json({ error: "payload_too_large" });
		}
		return res.status(400).json({ error: "unreadable_body" });
	}

	const integrationId = firstValue(req.query?.integration);
	const result = await handleDoDomainWebhook({
		rawBody,
		signature: firstValue(req.headers[DODOMAIN_SIGNATURE_HEADER]),
		deliveryIdHeader: firstValue(req.headers[DODOMAIN_DELIVERY_ID_HEADER]),
		integrationId: integrationId || null,
	});
	return res.status(result.status).json(result.body);
}
