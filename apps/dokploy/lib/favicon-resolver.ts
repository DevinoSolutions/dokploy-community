/**
 * Pure helpers for the favicon resolver API route. Kept dependency-free and
 * side-effect-free so the parsing/validation decisions can be unit-tested
 * without spinning up the HTTP handler, a database, or a network fetch.
 */

const HEAD_RE = /<head\b[^>]*>([\s\S]*?)<\/head>/i;
const LINK_RE = /<link\b[^>]*>/gi;
const REL_RE = /\brel\s*=\s*["']([^"']*)["']/i;
const HREF_RE = /\bhref\s*=\s*["']([^"']*)["']/i;

/**
 * Rank a `<link>` element's `rel` for icon preference. Lower wins. Returns
 * `null` for rels that are not an icon declaration we care about.
 *   0 = rel="icon"
 *   1 = rel="shortcut icon"
 *   2 = rel="apple-touch-icon" (or -precomposed)
 */
const relPriority = (rel: string): number | null => {
	const normalized = rel.toLowerCase().trim();
	const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
	if (
		tokens.has("apple-touch-icon") ||
		tokens.has("apple-touch-icon-precomposed")
	) {
		return 2;
	}
	if (tokens.has("icon")) {
		return tokens.has("shortcut") ? 1 : 0;
	}
	return null;
};

/**
 * Parse an HTML document's `<head>` for the best icon `<link>` href, following
 * the preference order icon > shortcut icon > apple-touch-icon. Ties are broken
 * by document order. Returns the raw (possibly relative) href, or `null` when
 * no icon link is present.
 */
export const parseIconHref = (html: string): string | null => {
	const headMatch = HEAD_RE.exec(html);
	const scope = headMatch?.[1] ?? html;

	let best: { priority: number; href: string } | null = null;
	for (const linkMatch of scope.matchAll(LINK_RE)) {
		const tag = linkMatch[0];
		const relMatch = REL_RE.exec(tag);
		if (!relMatch) continue;
		const priority = relPriority(relMatch[1] ?? "");
		if (priority === null) continue;
		const hrefMatch = HREF_RE.exec(tag);
		const href = hrefMatch?.[1]?.trim();
		if (!href) continue;
		if (!best || priority < best.priority) {
			best = { priority, href };
			if (priority === 0) break;
		}
	}

	return best?.href ?? null;
};

/**
 * Resolve an icon href (absolute or relative) against the page URL it was found
 * on. Returns `null` when the result is not an http(s) URL (e.g. a `data:` or
 * otherwise unparseable href), so callers never fetch a non-web target.
 */
export const resolveIconUrl = (href: string, base: string): string | null => {
	try {
		const resolved = new URL(href, base);
		if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
			return null;
		}
		return resolved.toString();
	} catch {
		return null;
	}
};

/**
 * Given a fetched page's HTML and the URL it was served from, return the icon
 * URL to fetch: the parsed `<link>` icon resolved to an absolute URL, or `null`
 * when there is no usable link (the caller then falls back to /favicon.ico).
 */
export const findIconUrl = (html: string, pageUrl: string): string | null => {
	const href = parseIconHref(html);
	if (!href) return null;
	return resolveIconUrl(href, pageUrl);
};

/**
 * True when `url` is an http(s) URL whose ENTIRE origin (scheme + host + port)
 * equals `baseOrigin`. The SSRF guard on the favicon route validates only the
 * originally-requested host against the domains table; every subsequent URL we
 * fetch — a `<link rel="icon">` href parsed from attacker-influenceable page
 * HTML, or a redirect `Location` — must match the full origin so it can never
 * be pivoted to a different scheme, a different host (`169.254.169.254`,
 * `localhost`), or, critically, a different PORT on the same resolved IP
 * (`:2375` Docker, `:5432`, `:6379`, …) which a host-only check would allow.
 * `baseOrigin` must be a canonical origin string (e.g. `new URL(base).origin`).
 */
export const isSameOrigin = (url: string, baseOrigin: string): boolean => {
	try {
		const parsed = new URL(url);
		return (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			parsed.origin === baseOrigin
		);
	} catch {
		return false;
	}
};

/**
 * True when `contentType` is a raster/vector-free image type we can safely
 * stream back from the same origin as the dashboard. `image/svg+xml` is
 * REJECTED: an SVG served with its genuine content-type executes inline
 * `<script>` on direct navigation (the global CSP only sets
 * `frame-ancestors 'none'`, and `nosniff` does not stop a correctly-typed SVG),
 * so an attacker-controlled favicon on a managed host would be a stored-XSS
 * vector in the Dokploy origin. Any `image/*` except svg is allowed.
 */
export const isSafeImageContentType = (contentType: string): boolean => {
	const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return type.startsWith("image/") && type !== "image/svg+xml";
};
