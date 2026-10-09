import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = await import("@dokploy/server/db");
const schema = await import("@dokploy/server/db/schema");
const {
	createConsentProof,
	findMcpAccessToken,
	findOAuthApplicationByClientId,
	hashOAuthToken,
	isStaleRotatedRefreshToken,
	listMcpAuthorizations,
	normalizeMcpRegisterBody,
	purgeExpiredMcpTokens,
	recordMcpConsent,
	revokeMcpAuthorization,
	rewriteLegacyAuthUrl,
	verifyConsentProof,
	withAdvertisedIssuer,
} = await import("@dokploy/server/services/mcp-oauth");

// The db mock in __test__/setup.ts returns one shared table mock for every
// table, so `findFirst`/`findMany` are the same spies whatever table is read.
const findFirst = vi.mocked(db.query.oauthAccessToken.findFirst);
const findMany = vi.mocked(db.query.oauthRefreshToken.findMany);
const dbDelete = vi.mocked(db.delete);
const dbInsert = vi.mocked(db.insert);
const dbUpdate = vi.mocked(db.update);

const basePayload = {
	userId: "user-1",
	clientId: "client-1",
	redirectUri: "http://localhost:1234/callback",
	state: "abc",
	codeChallenge: "chal",
	scope: "openid offline_access dokploy:read",
};

describe("consent proof", () => {
	it("round-trips and tolerates scope order", () => {
		const proof = createConsentProof(basePayload, "secret");
		expect(
			verifyConsentProof(
				proof,
				{ ...basePayload, scope: "dokploy:read openid offline_access" },
				"secret",
			),
		).toBe(true);
	});

	it("rejects a changed field, a bad signature, and an expired proof", () => {
		const proof = createConsentProof(basePayload, "secret");
		expect(
			verifyConsentProof(proof, { ...basePayload, userId: "user-2" }, "secret"),
		).toBe(false);
		expect(
			verifyConsentProof(
				proof,
				{ ...basePayload, scope: "openid offline_access dokploy:admin" },
				"secret",
			),
		).toBe(false);
		expect(verifyConsentProof(proof, basePayload, "other-secret")).toBe(false);
		const expired = createConsentProof(
			basePayload,
			"secret",
			Date.now() - 1000,
		);
		expect(verifyConsentProof(expired, basePayload, "secret")).toBe(false);
		expect(verifyConsentProof("garbage", basePayload, "secret")).toBe(false);
	});
});

describe("hashOAuthToken", () => {
	// The same digest migration 0211 computes in SQL
	// (base64url(sha256(token)) without padding) and the provider's "hashed"
	// token storage expects. A mismatch would orphan every migrated grant.
	it("is unpadded base64url SHA-256", () => {
		expect(hashOAuthToken("abc")).toBe(
			"ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
		);
		expect(hashOAuthToken("abc")).toHaveLength(43);
	});
});

describe("findMcpAccessToken", () => {
	beforeEach(() => findFirst.mockReset());

	const live = {
		userId: "user-1",
		clientId: "client-1",
		scopes: ["openid", "offline_access", "dokploy:read", "dokploy:deploy"],
		expiresAt: new Date(Date.now() + 60_000),
		revoked: null,
		client: { disabled: false },
	};

	it("returns null for unknown, expired or revoked tokens", async () => {
		findFirst.mockResolvedValueOnce(undefined as never);
		expect(await findMcpAccessToken("nope")).toBeNull();
		findFirst.mockResolvedValueOnce({
			...live,
			expiresAt: new Date(Date.now() - 1),
		} as never);
		expect(await findMcpAccessToken("t")).toBeNull();
		findFirst.mockResolvedValueOnce({ ...live, revoked: new Date() } as never);
		expect(await findMcpAccessToken("t")).toBeNull();
	});

	it("returns userId, clientId and the scope list for a live token", async () => {
		findFirst.mockResolvedValueOnce(live as never);
		expect(await findMcpAccessToken("t")).toEqual({
			userId: "user-1",
			clientId: "client-1",
			scopes: ["openid", "offline_access", "dokploy:read", "dokploy:deploy"],
		});
	});

	it("returns null for an empty token without querying", async () => {
		expect(await findMcpAccessToken("")).toBeNull();
		expect(findFirst).not.toHaveBeenCalled();
	});

	it("returns null when the client has been disabled", async () => {
		findFirst.mockResolvedValueOnce({
			...live,
			client: { disabled: true },
		} as never);
		expect(await findMcpAccessToken("t")).toBeNull();
	});
});

describe("findOAuthApplicationByClientId", () => {
	beforeEach(() => findFirst.mockReset());

	it("returns null for an empty client id without querying", async () => {
		expect(await findOAuthApplicationByClientId("")).toBeNull();
		expect(findFirst).not.toHaveBeenCalled();
	});

	it("returns null for an unknown client", async () => {
		findFirst.mockResolvedValueOnce(undefined as never);
		expect(await findOAuthApplicationByClientId("nope")).toBeNull();
	});

	it("returns the redirect list and names an anonymous client", async () => {
		findFirst.mockResolvedValueOnce({
			clientId: "client-1",
			name: null,
			redirectUris: ["http://localhost:1234/cb", "https://example.com/cb"],
			disabled: null,
		} as never);
		expect(await findOAuthApplicationByClientId("client-1")).toEqual({
			clientId: "client-1",
			name: "Unnamed client",
			redirectUrls: ["http://localhost:1234/cb", "https://example.com/cb"],
			disabled: false,
		});
	});
});

describe("isStaleRotatedRefreshToken", () => {
	beforeEach(() => findFirst.mockReset());
	const now = new Date("2026-10-09T12:00:00.000Z");

	it("is false for an empty, unknown or live token", async () => {
		expect(await isStaleRotatedRefreshToken("", now)).toBe(false);
		expect(findFirst).not.toHaveBeenCalled();
		findFirst.mockResolvedValueOnce(undefined as never);
		expect(await isStaleRotatedRefreshToken("t", now)).toBe(false);
		findFirst.mockResolvedValueOnce({
			revoked: null,
			rotationReplayExpiresAt: null,
		} as never);
		expect(await isStaleRotatedRefreshToken("t", now)).toBe(false);
	});

	// Inside the replay window the provider answers with the response of the
	// refresh that consumed the token, so a retried request recovers.
	it("is false for a rotated token still inside its replay window", async () => {
		findFirst.mockResolvedValueOnce({
			revoked: new Date(now.getTime() - 10_000),
			rotationReplayExpiresAt: new Date(now.getTime() + 60_000),
		} as never);
		expect(await isStaleRotatedRefreshToken("t", now)).toBe(false);
	});

	// Past the window the provider would delete the whole grant family; the
	// auth hook refuses just this token instead.
	it("is true once the replay window has closed or never existed", async () => {
		findFirst.mockResolvedValueOnce({
			revoked: new Date(now.getTime() - 600_000),
			rotationReplayExpiresAt: new Date(now.getTime() - 1),
		} as never);
		expect(await isStaleRotatedRefreshToken("t", now)).toBe(true);
		findFirst.mockResolvedValueOnce({
			revoked: new Date(now.getTime() - 600_000),
			rotationReplayExpiresAt: null,
		} as never);
		expect(await isStaleRotatedRefreshToken("t", now)).toBe(true);
	});
});

describe("legacy auth URLs", () => {
	it("maps the 1.6 MCP OAuth endpoints and keeps the query", () => {
		expect(rewriteLegacyAuthUrl("/api/auth/mcp/token")).toBe(
			"/api/auth/oauth2/token",
		);
		expect(rewriteLegacyAuthUrl("/api/auth/mcp/register")).toBe(
			"/api/auth/oauth2/register",
		);
		expect(rewriteLegacyAuthUrl("/api/auth/mcp/authorize?client_id=a&x=1")).toBe(
			"/api/auth/oauth2/authorize?client_id=a&x=1",
		);
	});

	it("maps the 1.6 SAML callback to the 1.7 ACS", () => {
		expect(rewriteLegacyAuthUrl("/api/auth/sso/saml2/callback/okta-saml")).toBe(
			"/api/auth/sso/saml2/sp/acs/okta-saml",
		);
	});

	it("leaves every other URL alone", () => {
		for (const url of [
			"/api/auth/oauth2/token",
			"/api/auth/get-session",
			"/api/auth/mcp/get-session",
			"/api/auth/sso/saml2/callback/a/b",
			"/api/auth/sso/callback/oidc-1",
			"/api/auth/mcp/tokenx",
		]) {
			expect(rewriteLegacyAuthUrl(url)).toBe(url);
		}
	});

	it("replaces the issuer of an authorization response", () => {
		expect(
			withAdvertisedIssuer(
				"http://localhost:1234/cb?code=c&state=s&iss=https%3A%2F%2Fdok.example.com%2Fapi%2Fauth",
				"https://dok.example.com",
			),
		).toBe(
			"http://localhost:1234/cb?code=c&state=s&iss=https%3A%2F%2Fdok.example.com",
		);
		expect(
			withAdvertisedIssuer("/mcp/authorize?client_id=a", "https://x.test"),
		).toBe("/mcp/authorize?client_id=a");
		expect(
			withAdvertisedIssuer("http://localhost:1234/cb?code=c", "https://x.test"),
		).toBe("http://localhost:1234/cb?code=c");
	});
});

describe("normalizeMcpRegisterBody", () => {
	it("declares loopback registrations native", () => {
		expect(
			normalizeMcpRegisterBody({
				redirect_uris: ["http://localhost:4321/callback"],
				token_endpoint_auth_method: "none",
			}),
		).toEqual({
			redirect_uris: ["http://localhost:4321/callback"],
			token_endpoint_auth_method: "none",
			application_type: "native",
		});
	});

	it("leaves explicit types, https-only registrations and junk alone", () => {
		expect(
			normalizeMcpRegisterBody({
				redirect_uris: ["http://127.0.0.1:1/cb"],
				application_type: "web",
			}),
		).toBeNull();
		expect(
			normalizeMcpRegisterBody({ redirect_uris: ["https://app.example.com/cb"] }),
		).toBeNull();
		expect(normalizeMcpRegisterBody(null)).toBeNull();
		expect(normalizeMcpRegisterBody(["x"])).toBeNull();
	});
});

describe("token hygiene", () => {
	// mockClear, not mockReset: the setup's `db.delete` implementation returns
	// the query chain and must survive between cases.
	beforeEach(() => {
		dbDelete.mockClear();
	});

	it("purgeExpiredMcpTokens deletes dead tokens, assertions, expired 1.6 rows and abandoned registrations", async () => {
		dbUpdate.mockClear();
		await purgeExpiredMcpTokens();
		const tables = dbDelete.mock.calls.map(([table]) => table);
		expect(tables).toEqual([
			schema.oauthRefreshToken,
			schema.oauthAccessToken,
			schema.oauthClientAssertion,
			schema.legacyOauthAccessToken,
			schema.oauthClient,
		]);
		// Live 1.6 rows are the rollback copy: neither the consent nor the
		// client table of 1.6 is purged.
		expect(tables).not.toContain(schema.legacyOauthConsent);
		expect(tables).not.toContain(schema.legacyOauthApplication);
		// Replay responses past their window are cleared, rows kept.
		expect(dbUpdate).toHaveBeenCalledTimes(1);
		expect(dbUpdate).toHaveBeenCalledWith(schema.oauthRefreshToken);
	});

	it("revokeMcpAuthorization deletes the 1.7 tokens and consents and the matching 1.6 rows", async () => {
		await revokeMcpAuthorization("user-1", "client-1");
		expect(dbDelete.mock.calls.map(([table]) => table)).toEqual([
			schema.oauthAccessToken,
			schema.oauthRefreshToken,
			schema.oauthConsent,
			schema.legacyOauthAccessToken,
			schema.legacyOauthConsent,
		]);
	});

	it("recordMcpConsent replaces the previous grant instead of accumulating rows", async () => {
		dbInsert.mockClear();
		await recordMcpConsent("user-1", "client-1", ["openid", "dokploy:read"]);
		expect(dbDelete).toHaveBeenCalledTimes(1);
		expect(dbInsert).toHaveBeenCalledTimes(1);
	});
});

describe("listMcpAuthorizations", () => {
	beforeEach(() => findMany.mockReset());

	it("groups by client, never projects token columns, and dates the grant from the consent row", async () => {
		const oldest = new Date("2026-01-01T00:00:00.000Z");
		const clientTwoAt = new Date("2026-02-01T00:00:00.000Z");
		const newest = new Date("2026-03-01T00:00:00.000Z");
		const consentedAt = new Date("2025-12-01T00:00:00.000Z");
		// The query reads the newest rows first.
		findMany.mockResolvedValueOnce([
			{
				clientId: "client-1",
				scopes: ["openid", "dokploy:read", "dokploy:deploy"],
				createdAt: newest,
				expiresAt: newest,
				client: { name: "Claude Code" },
			},
			{
				clientId: "client-2",
				scopes: ["openid", "offline_access", "dokploy:backups"],
				createdAt: clientTwoAt,
				expiresAt: clientTwoAt,
				client: { name: null },
			},
			{
				clientId: "client-1",
				scopes: ["openid", "dokploy:read"],
				createdAt: oldest,
				expiresAt: oldest,
				client: { name: "Claude Code" },
			},
		] as never);
		findMany.mockResolvedValueOnce([
			{ clientId: "client-1", createdAt: consentedAt },
		] as never);

		const authorizations = await listMcpAuthorizations("user-1");

		expect(authorizations).toHaveLength(2);
		expect(authorizations[0]).toEqual({
			clientId: "client-1",
			clientName: "Claude Code",
			scopes: ["dokploy:read", "dokploy:deploy"],
			authorizedAt: consentedAt,
			lastRefreshedAt: newest,
			refreshExpiresAt: newest,
		});
		expect(authorizations[1]).toEqual({
			clientId: "client-2",
			clientName: "Unnamed client",
			scopes: ["dokploy:backups"],
			authorizedAt: clientTwoAt,
			lastRefreshedAt: clientTwoAt,
			refreshExpiresAt: clientTwoAt,
		});

		const tokenQuery = findMany.mock.calls[0]?.[0] as {
			columns?: Record<string, boolean>;
			limit?: number;
		};
		expect(tokenQuery.limit).toBe(200);
		expect(tokenQuery.columns).not.toHaveProperty("token");
	});
});
