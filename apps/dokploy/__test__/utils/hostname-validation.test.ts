import {
	getDomainHostError,
	INVALID_HOSTNAME_MESSAGE,
	isValidDomainHost,
	VALID_HOSTNAME_REGEX,
	WILDCARD_SINGLE_MESSAGE,
	WILDCARD_START_MESSAGE,
	wildcardHostRegexp,
} from "@dokploy/server";
import { describe, expect, it } from "vitest";

describe("VALID_HOSTNAME_REGEX", () => {
	it.each([
		"example.com",
		"sub.example.com",
		"bbn-client.example.com",
		"a.b.c.example.co",
		"xn--80ak6aa92e.com",
		"123.example.com",
	])("accepts valid hostname %s", (host) => {
		expect(VALID_HOSTNAME_REGEX.test(host)).toBe(true);
	});

	it.each([
		"bbn_client.example.com",
		"-example.com",
		"example-.com",
		"example",
		"exa mple.com",
		"example..com",
		"",
		`a${"a".repeat(63)}.com`,
	])("rejects invalid hostname %s", (host) => {
		expect(VALID_HOSTNAME_REGEX.test(host)).toBe(false);
	});

	// IDNs (Cyrillic, German umlauts, etc.) must be submitted in their
	// ACME/punycode form ("xn--...") — that's what Let's Encrypt issues
	// certificates for, so raw Unicode labels are rejected here.
	it.each(["пример.рф", "bücher.de", "日本語.jp"])(
		"rejects raw unicode IDN %s",
		(host) => {
			expect(VALID_HOSTNAME_REGEX.test(host)).toBe(false);
		},
	);

	it.each([
		"xn--e1afmkfd.xn--p1ai", // punycode for пример.рф
		"xn--bcher-kva.de", // punycode for bücher.de
		"xn--wgv71a119e.jp", // punycode for 日本語.jp
	])("accepts punycode-encoded IDN %s", (host) => {
		expect(VALID_HOSTNAME_REGEX.test(host)).toBe(true);
	});

	// The base regex itself stays wildcard-free — wildcard awareness lives in
	// getDomainHostError so plain-hostname consumers (e.g. the server web
	// domain form) keep rejecting asterisks.
	it("rejects wildcard hosts (handled by getDomainHostError instead)", () => {
		expect(VALID_HOSTNAME_REGEX.test("*.example.com")).toBe(false);
	});
});

describe("getDomainHostError / isValidDomainHost (wildcard-aware)", () => {
	it.each([
		"example.com",
		"foo.wild.devino.ca",
		"*.wild.devino.ca",
		"*.sub.example.com",
	])("accepts %s", (host) => {
		expect(getDomainHostError(host)).toBeNull();
		expect(isValidDomainHost(host)).toBe(true);
	});

	it.each([
		["bad*.x.com", WILDCARD_START_MESSAGE],
		["a.*.b.com", WILDCARD_START_MESSAGE],
		["*", WILDCARD_START_MESSAGE],
		["**.example.com", WILDCARD_START_MESSAGE],
		["*.*.com", WILDCARD_SINGLE_MESSAGE],
		["*.exa*mple.com", WILDCARD_SINGLE_MESSAGE],
		["*.", INVALID_HOSTNAME_MESSAGE],
		["under_score.com", INVALID_HOSTNAME_MESSAGE],
		["*.under_score.com", INVALID_HOSTNAME_MESSAGE],
	])("rejects %s with its specific message", (host, message) => {
		expect(getDomainHostError(host)).toBe(message);
		expect(isValidDomainHost(host)).toBe(false);
	});
});

describe("wildcardHostRegexp (Traefik v3 HostRegexp payload)", () => {
	it("emits an anchored Go regexp with the literal remainder escaped", () => {
		expect(wildcardHostRegexp("*.wild.devino.ca")).toBe(
			"^[a-zA-Z0-9-]+\\.wild\\.devino\\.ca\\z",
		);
		expect(wildcardHostRegexp("*.sub.example.com")).toBe(
			"^[a-zA-Z0-9-]+\\.sub\\.example\\.com\\z",
		);
	});

	it("never emits the Traefik v2 named-group syntax", () => {
		expect(wildcardHostRegexp("*.example.com")).not.toContain("{subdomain:");
	});

	it("matches exactly one subdomain label (Go \\z ~ JS $)", () => {
		// Go's RE2 supports \z but JS does not — swap it for $ to exercise the
		// matching semantics in-process.
		const re = new RegExp(
			wildcardHostRegexp("*.wild.devino.ca").replace(/\\z$/, "$"),
		);
		expect(re.test("foo.wild.devino.ca")).toBe(true);
		expect(re.test("wild.devino.ca")).toBe(false); // no bare apex
		expect(re.test("a.b.wild.devino.ca")).toBe(false); // single level only
		expect(re.test("foo.wild-devino.ca")).toBe(false); // dots stay literal
		expect(re.test("foo.wild.devino.ca.evil.com")).toBe(false); // anchored end
	});
});
