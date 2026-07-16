import { describe, expect, it } from "vitest";
import {
	findIconUrl,
	isSafeImageContentType,
	isSameOrigin,
	parseIconHref,
	resolveIconUrl,
} from "@/lib/favicon-resolver";

describe("parseIconHref", () => {
	it('finds an absolute href on rel="icon"', () => {
		const html =
			'<html><head><link rel="icon" href="https://example.com/icon.png"></head></html>';
		expect(parseIconHref(html)).toBe("https://example.com/icon.png");
	});

	it("finds a relative href", () => {
		const html = '<html><head><link rel="icon" href="/icon.png"></head></html>';
		expect(parseIconHref(html)).toBe("/icon.png");
	});

	it('recognizes rel="shortcut icon"', () => {
		const html =
			'<html><head><link rel="shortcut icon" href="/favicon.ico"></head></html>';
		expect(parseIconHref(html)).toBe("/favicon.ico");
	});

	it('prefers rel="icon" over rel="apple-touch-icon" when both present', () => {
		const html = `<html><head>
			<link rel="apple-touch-icon" href="/apple-icon.png">
			<link rel="icon" href="/icon.png">
		</head></html>`;
		expect(parseIconHref(html)).toBe("/icon.png");
	});

	it('prefers rel="icon" over rel="apple-touch-icon" regardless of document order', () => {
		const html = `<html><head>
			<link rel="icon" href="/icon.png">
			<link rel="apple-touch-icon" href="/apple-icon.png">
		</head></html>`;
		expect(parseIconHref(html)).toBe("/icon.png");
	});

	it('prefers rel="shortcut icon" over rel="apple-touch-icon"', () => {
		const html = `<html><head>
			<link rel="apple-touch-icon" href="/apple-icon.png">
			<link rel="shortcut icon" href="/favicon.ico">
		</head></html>`;
		expect(parseIconHref(html)).toBe("/favicon.ico");
	});

	it('falls back to rel="apple-touch-icon" when nothing better is present', () => {
		const html =
			'<html><head><link rel="apple-touch-icon" href="/apple-icon.png"></head></html>';
		expect(parseIconHref(html)).toBe("/apple-icon.png");
	});

	it("picks the first matching link when multiple icons share the same priority", () => {
		const html = `<html><head>
			<link rel="icon" href="/first.png">
			<link rel="icon" href="/second.png">
		</head></html>`;
		expect(parseIconHref(html)).toBe("/first.png");
	});

	it("returns null when there is no icon link", () => {
		const html = "<html><head><title>No icons here</title></head></html>";
		expect(parseIconHref(html)).toBeNull();
	});

	it("matches rel case-insensitively", () => {
		const html = '<html><head><link REL="ICON" href="/icon.png"></head></html>';
		expect(parseIconHref(html)).toBe("/icon.png");
	});
});

describe("resolveIconUrl", () => {
	it("resolves a relative href against the base URL", () => {
		expect(resolveIconUrl("/icon.png", "https://example.com/page")).toBe(
			"https://example.com/icon.png",
		);
	});

	it("passes through an absolute https URL", () => {
		expect(
			resolveIconUrl("https://cdn.example.com/icon.png", "https://example.com"),
		).toBe("https://cdn.example.com/icon.png");
	});

	it("passes through an absolute http URL", () => {
		expect(
			resolveIconUrl("http://example.com/icon.png", "https://example.com"),
		).toBe("http://example.com/icon.png");
	});

	it("returns null for a data: href", () => {
		expect(
			resolveIconUrl("data:image/png;base64,AAAA", "https://example.com"),
		).toBeNull();
	});

	it("returns null for a javascript: href", () => {
		expect(
			resolveIconUrl("javascript:alert(1)", "https://example.com"),
		).toBeNull();
	});
});

describe("findIconUrl", () => {
	it("resolves the parsed relative icon href against the page URL", () => {
		const html = '<html><head><link rel="icon" href="/icon.png"></head></html>';
		expect(findIconUrl(html, "https://example.com/some/page")).toBe(
			"https://example.com/icon.png",
		);
	});

	it("returns null when the page has no icon link", () => {
		const html = "<html><head></head></html>";
		expect(findIconUrl(html, "https://example.com")).toBeNull();
	});

	it("returns null when the only icon href is a data: URI", () => {
		const html =
			'<html><head><link rel="icon" href="data:image/png;base64,AAAA"></head></html>';
		expect(findIconUrl(html, "https://example.com")).toBeNull();
	});
});

describe("isSameOrigin", () => {
	const base = "https://example.com"; // new URL("https://example.com/").origin

	it("accepts a same-origin absolute URL", () => {
		expect(isSameOrigin("https://example.com/favicon.ico", base)).toBe(true);
	});

	it("accepts same origin with a path and query", () => {
		expect(isSameOrigin("https://example.com/a/b?x=1", base)).toBe(true);
	});

	it("rejects a different host", () => {
		expect(isSameOrigin("https://evil.com/favicon.ico", base)).toBe(false);
		expect(isSameOrigin("https://169.254.169.254/latest", base)).toBe(false);
	});

	it("rejects a different PORT on the same host (internal port pivot)", () => {
		expect(isSameOrigin("https://example.com:2375/", base)).toBe(false);
		expect(isSameOrigin("https://example.com:5432/", base)).toBe(false);
	});

	it("rejects a scheme flip on the same host", () => {
		expect(isSameOrigin("http://example.com/favicon.ico", base)).toBe(false);
	});

	it("rejects a userinfo-smuggled foreign host", () => {
		// WHATWG URL parses the host as evil.com, not example.com.
		expect(isSameOrigin("https://example.com@evil.com/", base)).toBe(false);
	});

	it("rejects protocol-relative and non-http(s) targets", () => {
		expect(isSameOrigin("//evil.com/x", base)).toBe(false);
		expect(isSameOrigin("data:image/png;base64,AAAA", base)).toBe(false);
		expect(isSameOrigin("javascript:alert(1)", base)).toBe(false);
	});

	it("returns false for an unparseable URL", () => {
		expect(isSameOrigin("not a url", base)).toBe(false);
	});
});

describe("isSafeImageContentType", () => {
	it("accepts raster image types", () => {
		expect(isSafeImageContentType("image/png")).toBe(true);
		expect(isSafeImageContentType("image/jpeg")).toBe(true);
		expect(isSafeImageContentType("image/webp")).toBe(true);
		expect(isSafeImageContentType("image/x-icon")).toBe(true);
		expect(isSafeImageContentType("image/vnd.microsoft.icon")).toBe(true);
	});

	it("accepts an image type with charset/params and mixed case", () => {
		expect(isSafeImageContentType("IMAGE/PNG; charset=binary")).toBe(true);
	});

	it("rejects image/svg+xml (executable on direct navigation)", () => {
		expect(isSafeImageContentType("image/svg+xml")).toBe(false);
		expect(isSafeImageContentType("image/svg+xml; charset=utf-8")).toBe(false);
		expect(isSafeImageContentType("IMAGE/SVG+XML")).toBe(false);
	});

	it("rejects non-image types", () => {
		expect(isSafeImageContentType("text/html")).toBe(false);
		expect(isSafeImageContentType("application/json")).toBe(false);
		expect(isSafeImageContentType("")).toBe(false);
	});
});
