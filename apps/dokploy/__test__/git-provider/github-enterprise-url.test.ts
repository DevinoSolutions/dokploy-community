import {
	DEFAULT_GITHUB_API_URL,
	DEFAULT_GITHUB_URL,
	deriveGithubApiUrl,
	normalizeGithubUrl,
	parseGithubBaseUrl,
	STORED_GITHUB_URL_UNUSABLE,
} from "@dokploy/server/utils/providers/github";
import {
	GithubHostError,
	parseAllowedGithubHosts,
} from "@dokploy/server/utils/providers/github-host";
import { describe, expect, it, vi } from "vitest";

const urlOf = (result: ReturnType<typeof parseGithubBaseUrl>) =>
	"url" in result ? result.url : null;

describe("normalizeGithubUrl", () => {
	it("defaults to github.com when empty", () => {
		expect(normalizeGithubUrl("")).toBe(DEFAULT_GITHUB_URL);
		expect(normalizeGithubUrl(null)).toBe(DEFAULT_GITHUB_URL);
		expect(normalizeGithubUrl(undefined)).toBe(DEFAULT_GITHUB_URL);
		expect(normalizeGithubUrl("   ")).toBe(DEFAULT_GITHUB_URL);
	});

	it("assumes https when no scheme is given", () => {
		expect(normalizeGithubUrl("acme.ghe.com")).toBe("https://acme.ghe.com");
	});

	it("strips paths, queries and trailing slashes", () => {
		expect(normalizeGithubUrl("https://acme.ghe.com/")).toBe(
			"https://acme.ghe.com",
		);
		expect(normalizeGithubUrl("https://acme.ghe.com///")).toBe(
			"https://acme.ghe.com",
		);
		expect(normalizeGithubUrl("https://github.acme.com/some/path?x=1")).toBe(
			"https://github.acme.com",
		);
	});

	it("keeps an explicit port", () => {
		expect(normalizeGithubUrl("https://github.acme.com:8443")).toBe(
			"https://github.acme.com:8443",
		);
	});

	it("refuses a stored value it can't use instead of falling back to github.com", () => {
		for (const stored of [
			"ftp://github.acme.com",
			"http://github.internal",
			"http://oauth2:secret-token@github.acme.com",
			"https://",
			"https://github",
			"acme .ghe.com",
		]) {
			let thrown: unknown;
			try {
				normalizeGithubUrl(stored);
			} catch (error) {
				thrown = error;
			}
			expect(thrown, stored).toBeInstanceOf(GithubHostError);
			expect((thrown as Error).message).toBe(STORED_GITHUB_URL_UNUSABLE);
			// The stored value can carry credentials; it is not echoed back.
			expect((thrown as Error).message).not.toContain("secret-token");
		}
		expect(() => deriveGithubApiUrl("http://github.internal")).toThrow(
			STORED_GITHUB_URL_UNUSABLE,
		);
	});
});

describe("parseGithubBaseUrl", () => {
	it("accepts github.com and Enterprise hosts", () => {
		expect(urlOf(parseGithubBaseUrl("https://acme.ghe.com"))).toBe(
			"https://acme.ghe.com",
		);
		// A self-hosted instance behind the corporate network is a valid target.
		expect(urlOf(parseGithubBaseUrl("https://github.corp.acme.com"))).toBe(
			"https://github.corp.acme.com",
		);
		expect(urlOf(parseGithubBaseUrl("https://github.acme.com:8443"))).toBe(
			"https://github.acme.com:8443",
		);
	});

	it("treats an absent value as github.com", () => {
		// Not specified is different from specified wrong.
		expect(urlOf(parseGithubBaseUrl(undefined))).toBe(DEFAULT_GITHUB_URL);
		expect(urlOf(parseGithubBaseUrl(null))).toBe(DEFAULT_GITHUB_URL);
		expect(urlOf(parseGithubBaseUrl("  "))).toBe(DEFAULT_GITHUB_URL);
	});

	it("rejects plaintext http", () => {
		expect(parseGithubBaseUrl("http://acme.ghe.com")).toHaveProperty("error");
		expect(parseGithubBaseUrl("http://localhost:2375")).toHaveProperty("error");
	});

	it("rejects dotless hostnames", () => {
		expect(parseGithubBaseUrl("https://metadata")).toHaveProperty("error");
		expect(parseGithubBaseUrl("https://localhost")).toHaveProperty("error");
	});

	it("rejects a dotless hostname hidden behind the DNS root label", () => {
		// "metadata." resolves like "metadata" but the trailing dot would satisfy
		// a naive `includes(".")` check.
		expect(parseGithubBaseUrl("https://metadata.")).toHaveProperty("error");
		expect(parseGithubBaseUrl("https://localhost.")).toHaveProperty("error");
	});

	it("never falls back to github.com on a typo", () => {
		// The symptom that opened the ticket: a provider silently pointing at
		// github.com and reporting that it cannot find the repositories.
		for (const typo of [
			"htps://acme.ghe.com",
			"ftp://acme.ghe.com",
			"https://",
			"acme .ghe.com",
		]) {
			const result = parseGithubBaseUrl(typo);
			expect(result, typo).toHaveProperty("error");
			expect(urlOf(result), typo).not.toBe(DEFAULT_GITHUB_URL);
		}
	});
});

describe("parseGithubBaseUrl host policy", () => {
	const none = new Set<string>();

	it.each([
		// Plain, decimal, octal, hex and short IPv4 forms all reach the URL
		// parser as the same address.
		"https://127.0.0.1",
		"https://10.0.0.5:8443",
		"https://169.254.169.254",
		"https://192.168.1.10",
		"https://8.8.8.8",
		"https://2130706433",
		"https://017700000001",
		"https://0x7f000001",
		"https://0x7f.1",
		"https://127.1",
		"https://0",
		// IPv6, bracketed.
		"https://[::1]",
		"https://[::]",
		"https://[fe80::1]",
		"https://[fd00::1]",
		"https://[::ffff:127.0.0.1]",
		"https://[2001:4860:4860::8888]",
	])("refuses the IP literal %s", (input) => {
		expect(parseGithubBaseUrl(input, none)).toHaveProperty("error");
	});

	it.each([
		"https://localhost",
		"https://localhost.",
		"https://app.localhost",
		"https://ghe.local",
		"https://ghe.local.",
		"https://github.corp.internal",
		"https://GITHUB.CORP.INTERNAL:8443",
	])("refuses the internal host name %s", (input) => {
		expect(parseGithubBaseUrl(input, none)).toHaveProperty("error");
	});

	it("names only the host the user typed", () => {
		const result = parseGithubBaseUrl("https://10.1.2.3:8443/x", none);
		expect(result).toHaveProperty("error");
		const message = "error" in result ? result.error : "";
		expect(message).toContain("10.1.2.3");
		expect(message).not.toContain("8443");
	});

	it("accepts a public host name, with or without a port", () => {
		for (const input of [
			"https://github.com",
			"https://acme.ghe.com",
			"https://github.acme.com",
			"https://github.acme.com:8443",
			"https://localhost.example.com",
			"https://internal.example.com",
			"https://local.example.com",
			"https://ghe.localhost.example.org",
		]) {
			expect(parseGithubBaseUrl(input, none), input).toHaveProperty("url");
		}
	});

	it("accepts an allowlisted internal host, exact match, any case", () => {
		const allowed = parseAllowedGithubHosts(
			" GHE.corp.internal, 10.0.0.5 ,, git.lan.local.",
		);
		expect(
			urlOf(parseGithubBaseUrl("https://ghe.corp.internal", allowed)),
		).toBe("https://ghe.corp.internal");
		expect(
			urlOf(parseGithubBaseUrl("https://GHE.CORP.INTERNAL:8443", allowed)),
		).toBe("https://ghe.corp.internal:8443");
		expect(urlOf(parseGithubBaseUrl("https://10.0.0.5", allowed))).toBe(
			"https://10.0.0.5",
		);
		expect(urlOf(parseGithubBaseUrl("https://git.lan.local", allowed))).toBe(
			"https://git.lan.local",
		);
		// Exact: neither a sibling, a parent nor a subdomain.
		for (const input of [
			"https://other.corp.internal",
			"https://corp.internal",
			"https://x.ghe.corp.internal",
			"https://10.0.0.6",
		]) {
			expect(parseGithubBaseUrl(input, allowed), input).toHaveProperty("error");
		}
	});

	it("matches an allowlisted IP in any spelling the URL parser normalizes", () => {
		const allowed = parseAllowedGithubHosts("10.0.0.5");
		expect(parseGithubBaseUrl("https://0xa000005", allowed)).toHaveProperty(
			"url",
		);
	});

	it("keeps the dotless host rule even when allowlisted", () => {
		const allowed = parseAllowedGithubHosts("metadata, [::1]", () => {});
		expect(parseGithubBaseUrl("https://metadata", allowed)).toHaveProperty(
			"error",
		);
		expect(parseGithubBaseUrl("https://[::1]", allowed)).toHaveProperty(
			"error",
		);
	});

	it("ignores an entry that is not a bare hostname and reports it", () => {
		const invalid: string[] = [];
		const allowed = parseAllowedGithubHosts(
			[
				"https://ghe.one.internal/",
				"ghe.two.internal:8443",
				"user@ghe.three.internal",
				"ghe.four.internal/path",
				"ghe five.internal",
				"[::1]",
				"ghe.ok.internal",
			].join(","),
			(entry) => invalid.push(entry),
		);

		expect([...allowed]).toEqual(["ghe.ok.internal"]);
		expect(invalid).toEqual([
			"https://ghe.one.internal/",
			"ghe.two.internal:8443",
			"user@ghe.three.internal",
			"ghe.four.internal/path",
			"ghe five.internal",
			"[::1]",
		]);
	});

	it("ignores an entry with a query, fragment, backslash, percent escape or wildcard", () => {
		const invalid: string[] = [];
		const entries = [
			"ghe.one.internal?x=1",
			"ghe.two.internal#frag",
			"ghe.three.internal\\evil.example",
			"ghe%2Efour.internal",
			"%67he.five.internal",
			"*.six.internal",
			"ghe.*.internal",
			"*",
		];
		const allowed = parseAllowedGithubHosts(
			[...entries, "ghe.ok.internal"].join(","),
			(entry) => invalid.push(entry),
		);

		expect([...allowed]).toEqual(["ghe.ok.internal"]);
		expect(invalid).toEqual(entries);
	});

	it("warns once per bad entry on the server log by default", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		parseAllowedGithubHosts("https://dup.example.internal/");
		parseAllowedGithubHosts("https://dup.example.internal/");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain(
			"https://dup.example.internal/",
		);
		warn.mockRestore();
	});

	it("allows any port on an allowlisted host", () => {
		const allowed = parseAllowedGithubHosts("ghe.corp.internal");
		expect(
			urlOf(parseGithubBaseUrl("https://ghe.corp.internal:9443", allowed)),
		).toBe("https://ghe.corp.internal:9443");
	});

	it("refuses an empty hostname with the invalid URL message", () => {
		for (const input of ["https://.", "https://..", "."]) {
			const result = parseGithubBaseUrl(input, none);
			expect(result, input).toHaveProperty("error");
			expect("error" in result ? result.error : "", input).toContain(
				"is not a valid URL",
			);
		}
	});

	it("is not affected by an empty or absent allowlist value", () => {
		expect([...parseAllowedGithubHosts(undefined)]).toEqual([]);
		expect([...parseAllowedGithubHosts("")]).toEqual([]);
		expect([...parseAllowedGithubHosts(" , ,")]).toEqual([]);
	});

	it("still normalizes a stored internal URL instead of falling back to github.com", () => {
		// The policy applies when a URL is entered and before a request is sent;
		// a provider saved earlier must not silently start talking to github.com.
		expect(normalizeGithubUrl("https://ghe.corp.internal")).toBe(
			"https://ghe.corp.internal",
		);
		expect(deriveGithubApiUrl("https://10.0.0.5")).toBe(
			"https://10.0.0.5/api/v3",
		);
	});
});

describe("deriveGithubApiUrl", () => {
	it("maps github.com to api.github.com", () => {
		expect(deriveGithubApiUrl("https://github.com")).toBe(
			DEFAULT_GITHUB_API_URL,
		);
		expect(deriveGithubApiUrl("https://www.github.com")).toBe(
			DEFAULT_GITHUB_API_URL,
		);
		expect(deriveGithubApiUrl(undefined)).toBe(DEFAULT_GITHUB_API_URL);
	});

	it("prefixes api. for data residency tenants", () => {
		expect(deriveGithubApiUrl("https://acme.ghe.com")).toBe(
			"https://api.acme.ghe.com",
		);
		expect(deriveGithubApiUrl("americancreditacceptance.ghe.com")).toBe(
			"https://api.americancreditacceptance.ghe.com",
		);
	});

	it("uses /api/v3 for Enterprise Server", () => {
		expect(deriveGithubApiUrl("https://github.acme.com")).toBe(
			"https://github.acme.com/api/v3",
		);
		expect(deriveGithubApiUrl("https://github.acme.com:8443")).toBe(
			"https://github.acme.com:8443/api/v3",
		);
	});

	it("does not treat a lookalike host as data residency", () => {
		// Must not match the .ghe.com branch just because the string contains it.
		expect(deriveGithubApiUrl("https://ghe.com.acme.io")).toBe(
			"https://ghe.com.acme.io/api/v3",
		);
	});

	it("still detects data residency behind the DNS root label", () => {
		// "acme.ghe.com." would otherwise miss endsWith(".ghe.com") and fall
		// through to the /api/v3 branch.
		expect(deriveGithubApiUrl("https://acme.ghe.com.")).toBe(
			"https://api.acme.ghe.com",
		);
	});

	it("maps www.github.com, which a user may well type", () => {
		// Not dead weight: GitHub never redirects a manifest there, but the value
		// comes from a text field. Without this it would derive
		// https://www.github.com/api/v3.
		expect(deriveGithubApiUrl("https://www.github.com")).toBe(
			DEFAULT_GITHUB_API_URL,
		);
	});
});

describe("providers created before Enterprise support", () => {
	it("keeps pointing at github.com", () => {
		// The column defaults to https://github.com, but a null must not break it.
		expect(deriveGithubApiUrl(null)).toBe(DEFAULT_GITHUB_API_URL);
		expect(new URL(normalizeGithubUrl(null)).host).toBe("github.com");
	});
});
