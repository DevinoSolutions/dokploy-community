import { db } from "@dokploy/server/db";
import { validateRequest } from "@dokploy/server/lib/auth";
import { eq } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";
import { findIconUrl } from "@/lib/favicon-resolver";
import { domains } from "@/server/db/schema";

const REQUEST_TIMEOUT_MS = 5000;
const MAX_ICON_BYTES = 1024 * 1024; // 1 MB
const MAX_REDIRECTS = 3;
const SUCCESS_CACHE = "public, max-age=86400, stale-while-revalidate=604800";
const FAILURE_CACHE = "public, max-age=3600";

const parseHttps = (value: unknown): boolean => {
	const raw = Array.isArray(value) ? value[0] : value;
	return raw === "1" || raw === "true";
};

const getStringParam = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

/**
 * True when `url` is an http(s) URL whose hostname equals `host`
 * (case-insensitive). The SSRF guard on this route validates only the
 * originally-requested host against the domains table; every subsequent URL we
 * fetch — a `<link rel="icon">` href parsed from attacker-influenceable page
 * HTML, or a redirect `Location` — must be re-checked against that same host so
 * it can never be pivoted to `169.254.169.254`, `localhost`, or any other
 * internal target the guard never approved.
 */
const isSameHost = (url: string, host: string): boolean => {
	try {
		const parsed = new URL(url);
		return (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			parsed.hostname.toLowerCase() === host.toLowerCase()
		);
	} catch {
		return false;
	}
};

/**
 * Fetch a URL with a hard timeout and a byte cap enforced while streaming the
 * body, so a hostile or oversized response cannot exhaust memory. Redirects are
 * followed manually (`redirect: "manual"`) and every hop is re-validated to
 * stay on `host`, closing the redirect-based SSRF pivot. Returns the buffered
 * body plus its content-type, or `null` on any failure (off-host hop, non-ok
 * status, timeout, network error, too many redirects, or exceeding the cap).
 */
const fetchCapped = async (
	url: string,
	accept: string,
	host: string,
): Promise<{ body: Buffer; contentType: string } | null> => {
	let currentUrl = url;
	for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
		if (!isSameHost(currentUrl, host)) {
			return null;
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(currentUrl, {
				signal: controller.signal,
				headers: { accept },
				redirect: "manual",
			});
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (!location) {
					return null;
				}
				// Re-validated against `host` at the top of the next iteration.
				currentUrl = new URL(location, currentUrl).toString();
				continue;
			}
			if (!response.ok || !response.body) {
				return null;
			}
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let received = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) {
					received += value.length;
					if (received > MAX_ICON_BYTES) {
						await reader.cancel();
						return null;
					}
					chunks.push(value);
				}
			}
			return {
				body: Buffer.concat(chunks),
				contentType: response.headers.get("content-type") ?? "",
			};
		} catch {
			return null;
		} finally {
			clearTimeout(timeout);
		}
	}
	return null;
};

const notFound = (res: NextApiResponse) => {
	res.setHeader("Cache-Control", FAILURE_CACHE);
	res.status(404).end();
};

/**
 * Resolve and stream a project domain's real favicon.
 *
 * The handler is auth-gated (better-auth session or API key) and SSRF-guarded:
 * the requested `host` must exist in the `domain` table, so only hosts the
 * instance already manages are ever fetched. It reads the page's `<head>` for a
 * declared icon `<link>`, falls back to `/favicon.ico`, verifies the response
 * is an image, and streams the bytes back with long-lived cache headers. Any
 * failure is a short-cached 404 so failing hosts are not re-probed on every
 * render.
 */
export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		res.status(405).end();
		return;
	}

	const { session } = await validateRequest(req);
	if (!session) {
		res.status(401).end();
		return;
	}

	const host = getStringParam(req.query.host);
	if (!host) {
		res.status(400).end();
		return;
	}
	const https = parseHttps(req.query.https);

	// SSRF guard: only ever fetch hosts this instance already manages.
	const domain = await db.query.domains.findFirst({
		where: eq(domains.host, host),
		columns: { domainId: true },
	});
	if (!domain) {
		notFound(res);
		return;
	}

	const scheme = https ? "https" : "http";
	const base = `${scheme}://${host}/`;

	let iconUrl: string | null = null;
	const page = await fetchCapped(base, "text/html", host);
	if (page && /text\/html/i.test(page.contentType)) {
		const parsed = findIconUrl(page.body.toString("utf8"), base);
		// The page HTML is attacker-influenceable, so only trust an icon href
		// that resolves back to the same managed host; anything else falls
		// through to the /favicon.ico default below.
		if (parsed && isSameHost(parsed, host)) {
			iconUrl = parsed;
		}
	}
	if (!iconUrl) {
		iconUrl = `${scheme}://${host}/favicon.ico`;
	}

	const icon = await fetchCapped(iconUrl, "image/*", host);
	if (!icon || !/^image\//i.test(icon.contentType)) {
		notFound(res);
		return;
	}

	res.setHeader("Content-Type", icon.contentType);
	res.setHeader("Cache-Control", SUCCESS_CACHE);
	res.status(200).send(icon.body);
}
