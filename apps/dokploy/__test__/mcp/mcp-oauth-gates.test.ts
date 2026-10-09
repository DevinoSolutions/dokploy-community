import { describe, expect, it } from "vitest";

const {
	canonicalizeMcpResource,
	canonicalizeMcpResourceParam,
	createConsentProof,
	evaluateMcpAuthorizeGate,
	evaluateMcpRegisterBody,
	isMcpAuthorizeMethodAllowed,
	resolveMcpOrigin,
} = await import("@dokploy/server/services/mcp-oauth");

const SECRET = "consent-proof-test-secret";

describe("evaluateMcpRegisterBody", () => {
	it.each([
		["a missing body", undefined],
		["a body without redirect_uris", {}],
		["a non-array redirect_uris", { redirect_uris: "https://example.com/cb" }],
		["an empty redirect_uris", { redirect_uris: [] }],
		[
			"a non-string entry",
			{ redirect_uris: [{ uri: "https://a.example/cb" }] },
		],
		["a disallowed scheme", { redirect_uris: ["custom-app://callback"] }],
		[
			"one bad entry among good ones",
			{
				redirect_uris: ["https://a.example/cb", "http://evil.example/cb"],
			},
		],
	])("rejects %s", (_label, body) => {
		const decision = evaluateMcpRegisterBody(body);
		expect(decision.ok).toBe(false);
		if (!decision.ok) {
			expect(decision.error).toBe("invalid_redirect_uri");
		}
	});

	it("accepts loopback http and https targets", () => {
		expect(
			evaluateMcpRegisterBody({
				redirect_uris: [
					"http://localhost:53421/callback",
					"http://127.0.0.1:8080/cb",
					"https://claude.ai/api/mcp/auth_callback",
				],
			}),
		).toEqual({ ok: true });
	});
});

const authorizeQuery = {
	client_id: "client-1",
	redirect_uri: "http://127.0.0.1:8080/cb",
	state: "state-1",
	code_challenge: "challenge-1",
	scope: "openid dokploy:read",
	response_type: "code",
};

const proofFor = (overrides: Partial<Record<string, string>> = {}) =>
	createConsentProof(
		{
			userId: "user-1",
			clientId: authorizeQuery.client_id,
			redirectUri: authorizeQuery.redirect_uri,
			state: authorizeQuery.state,
			codeChallenge: authorizeQuery.code_challenge,
			scope: authorizeQuery.scope,
			...overrides,
		},
		SECRET,
	);

describe("evaluateMcpAuthorizeGate", () => {
	it("redirects an anonymous request to the consent page, keeping the OAuth params", () => {
		const decision = evaluateMcpAuthorizeGate({
			query: { ...authorizeQuery, consent: "stale-proof" },
			userId: null,
			secret: SECRET,
		});
		expect(decision.action).toBe("redirect");
		if (decision.action !== "redirect") return;
		expect(decision.location.startsWith("/mcp/authorize?")).toBe(true);
		const params = new URLSearchParams(decision.location.split("?")[1]);
		expect(params.get("client_id")).toBe(authorizeQuery.client_id);
		expect(params.get("redirect_uri")).toBe(authorizeQuery.redirect_uri);
		expect(params.get("state")).toBe(authorizeQuery.state);
		expect(params.get("code_challenge")).toBe(authorizeQuery.code_challenge);
		expect(params.get("scope")).toBe(authorizeQuery.scope);
		expect(params.get("response_type")).toBe("code");
		expect(decision.location).not.toContain("consent");
	});

	it("drops array-valued query params from the consent-page redirect", () => {
		const decision = evaluateMcpAuthorizeGate({
			query: { ...authorizeQuery, state: ["a", "b"] },
			userId: null,
			secret: SECRET,
		});
		expect(decision.action).toBe("redirect");
		if (decision.action !== "redirect") return;
		const params = new URLSearchParams(decision.location.split("?")[1]);
		expect(params.has("state")).toBe(false);
		expect(params.get("client_id")).toBe(authorizeQuery.client_id);
	});

	it("allows a signed-in request carrying the proof minted for it", () => {
		const decision = evaluateMcpAuthorizeGate({
			query: { ...authorizeQuery, consent: proofFor() },
			userId: "user-1",
			secret: SECRET,
		});
		expect(decision).toEqual({ action: "allow" });
	});

	it.each([
		["a proof minted for another user", { consent: proofFor() }, "user-2"],
		[
			"a proof whose scope no longer matches",
			{ consent: proofFor(), scope: "openid dokploy:admin" },
			"user-1",
		],
		[
			"a proof minted for another client",
			{ consent: proofFor({ clientId: "client-2" }) },
			"user-1",
		],
		["a missing proof", {}, "user-1"],
		["an empty proof", { consent: "" }, "user-1"],
		["a malformed proof", { consent: "not-a-proof" }, "user-1"],
	])("rejects %s", (_label, overrides, userId) => {
		const decision = evaluateMcpAuthorizeGate({
			query: { ...authorizeQuery, ...overrides },
			userId,
			secret: SECRET,
		});
		expect(decision.action).toBe("reject");
		if (decision.action !== "reject") return;
		expect(decision.error).toBe("consent_required");
	});
});

describe("isMcpAuthorizeMethodAllowed", () => {
	// The provider reads POST parameters from the body while the consent
	// proof is checked on the query, so only GET may reach it.
	it("allows only GET", () => {
		expect(isMcpAuthorizeMethodAllowed("GET")).toBe(true);
		expect(isMcpAuthorizeMethodAllowed("get")).toBe(true);
		for (const method of [
			"POST",
			"PUT",
			"PATCH",
			"DELETE",
			"HEAD",
			"",
			undefined,
		]) {
			expect(isMcpAuthorizeMethodAllowed(method)).toBe(false);
		}
	});
});

describe("canonicalizeMcpResource", () => {
	const origin = "https://devino-first.basa-ulmer.ts.net";
	const advertised = `${origin}/api/mcp`;
	const aliases = ["dokploy.example.com", "10.0.0.5:3000"];

	it("passes the advertised resource through unchanged", () => {
		expect(canonicalizeMcpResource(advertised, origin, aliases)).toBe(
			advertised,
		);
	});

	it.each([
		["a trailing slash", `${advertised}/`],
		["several trailing slashes", `${advertised}//`],
		[
			"http on the advertised host",
			"http://devino-first.basa-ulmer.ts.net/api/mcp",
		],
		["an upper-case host", "https://DEVINO-FIRST.basa-ulmer.ts.net/api/mcp"],
		["the configured host alias", "https://dokploy.example.com/api/mcp"],
		["the request host with a port", "http://10.0.0.5:3000/api/mcp/"],
	])("maps %s to the advertised resource", (_label, resource) => {
		expect(canonicalizeMcpResource(resource, origin, aliases)).toBe(
			advertised,
		);
	});

	it.each([
		["another host", "https://evil.example.com/api/mcp"],
		["another path", `${origin}/api/other`],
		["a sub-path", `${advertised}/x`],
		["a query", `${advertised}?a=1`],
		["a fragment", `${advertised}#x`],
		["credentials", "https://u:p@devino-first.basa-ulmer.ts.net/api/mcp"],
		["another scheme", "ftp://devino-first.basa-ulmer.ts.net/api/mcp"],
		[
			"a host alias on another port",
			"https://dokploy.example.com:8443/api/mcp",
		],
		["garbage", "not a url"],
	])("refuses %s", (_label, resource) => {
		expect(canonicalizeMcpResource(resource, origin, aliases)).toBeNull();
	});

	it("canonicalizes string and repeated params, leaving foreign values for the provider to reject", () => {
		expect(canonicalizeMcpResourceParam(`${advertised}/`, origin, aliases)).toBe(
			advertised,
		);
		expect(
			canonicalizeMcpResourceParam(
				[`${advertised}/`, advertised, "https://evil.example.com/api/mcp"],
				origin,
				aliases,
			),
		).toEqual([advertised, "https://evil.example.com/api/mcp"]);
		expect(canonicalizeMcpResourceParam(undefined, origin, aliases)).toBe(
			undefined,
		);
	});

	it("always accepts the resource the protected-resource metadata advertises", async () => {
		const { buildProtectedResourceMetadata } = await import(
			"@/server/mcp/discovery"
		);
		// Same derivation as pages/api/mcp-oauth/protected-resource.ts.
		const resolved = await resolveMcpOrigin(
			{ host: "ignored.example.com" },
			{ BETTER_AUTH_URL: `${origin}/some/path` },
		);
		expect(resolved).toBe(origin);
		const { resource } = buildProtectedResourceMetadata(resolved as string);
		expect(resource).toBe(advertised);
		expect(canonicalizeMcpResource(resource, resolved as string)).toBe(
			resource,
		);
		expect(canonicalizeMcpResource(`${resource}/`, resolved as string)).toBe(
			resource,
		);
	});
});
