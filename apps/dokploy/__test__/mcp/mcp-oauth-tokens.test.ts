import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = await import("@dokploy/server/db");
const {
	createConsentProof,
	deleteConsumedRefreshToken,
	findMcpAccessToken,
	findOAuthApplicationByClientId,
	listMcpAuthorizations,
	purgeExpiredMcpTokens,
	recordMcpConsent,
	revokeMcpAuthorization,
	verifyConsentProof,
} = await import("@dokploy/server/services/mcp-oauth");

// The db mock in __test__/setup.ts returns one shared table mock for every
// table, so `findFirst`/`findMany` are the same spies whatever table is read.
const findFirst = vi.mocked(db.query.oauthAccessToken.findFirst);
const findMany = vi.mocked(db.query.oauthAccessToken.findMany);
const dbDelete = vi.mocked(db.delete);
const dbInsert = vi.mocked(db.insert);

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

describe("findMcpAccessToken", () => {
	beforeEach(() => findFirst.mockReset());

	it("returns null for unknown or expired tokens", async () => {
		findFirst.mockResolvedValueOnce(undefined as never);
		expect(await findMcpAccessToken("nope")).toBeNull();
		findFirst.mockResolvedValueOnce({
			accessToken: "t",
			accessTokenExpiresAt: new Date(Date.now() - 1),
			userId: "user-1",
			clientId: "c",
			scopes: "openid",
		} as never);
		expect(await findMcpAccessToken("t")).toBeNull();
	});

	it("returns userId, clientId and the scope list for a live token", async () => {
		findFirst.mockResolvedValueOnce({
			accessToken: "t",
			accessTokenExpiresAt: new Date(Date.now() + 60_000),
			userId: "user-1",
			clientId: "client-1",
			scopes: "openid offline_access dokploy:read dokploy:deploy",
		} as never);
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

	it("returns null when the client application has been disabled", async () => {
		findFirst.mockResolvedValueOnce({
			accessToken: "t",
			accessTokenExpiresAt: new Date(Date.now() + 60_000),
			userId: "user-1",
			clientId: "client-1",
			scopes: "openid dokploy:read",
			application: { disabled: true },
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

	it("splits redirect urls and names an anonymous client", async () => {
		findFirst.mockResolvedValueOnce({
			clientId: "client-1",
			name: null,
			redirectUrls: "http://localhost:1234/cb,https://example.com/cb",
			disabled: false,
		} as never);
		expect(await findOAuthApplicationByClientId("client-1")).toEqual({
			clientId: "client-1",
			name: "Unnamed client",
			redirectUrls: ["http://localhost:1234/cb", "https://example.com/cb"],
			disabled: false,
		});
	});
});

describe("token hygiene", () => {
	// mockClear, not mockReset: the setup's `db.delete` implementation returns
	// the query chain and must survive between cases.
	beforeEach(() => dbDelete.mockClear());

	it("deleteConsumedRefreshToken skips an empty token and deletes a real one", async () => {
		await deleteConsumedRefreshToken("");
		expect(dbDelete).not.toHaveBeenCalled();
		await deleteConsumedRefreshToken("refresh-1");
		expect(dbDelete).toHaveBeenCalledTimes(1);
	});

	it("purgeExpiredMcpTokens deletes dead tokens and abandoned registrations", async () => {
		await purgeExpiredMcpTokens();
		expect(dbDelete).toHaveBeenCalledTimes(2);
	});

	it("revokeMcpAuthorization deletes both the tokens and the consents", async () => {
		await revokeMcpAuthorization("user-1", "client-1");
		expect(dbDelete).toHaveBeenCalledTimes(2);
	});

	it("recordMcpConsent replaces the previous grant instead of accumulating rows", async () => {
		dbInsert.mockClear();
		await recordMcpConsent("user-1", "client-1", ["dokploy:read"]);
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
		findMany.mockResolvedValueOnce([
			{
				clientId: "client-1",
				scopes: "openid dokploy:read",
				createdAt: oldest,
				refreshTokenExpiresAt: null,
				application: { name: "Claude Code" },
			},
			{
				clientId: "client-2",
				scopes: "openid offline_access dokploy:backups",
				createdAt: clientTwoAt,
				refreshTokenExpiresAt: null,
				application: { name: null },
			},
			{
				clientId: "client-1",
				scopes: "openid dokploy:read dokploy:deploy",
				createdAt: newest,
				refreshTokenExpiresAt: newest,
				application: { name: "Claude Code" },
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
			refreshExpiresAt: null,
		});

		const tokenQuery = findMany.mock.calls[0]?.[0] as {
			columns?: Record<string, boolean>;
			limit?: number;
		};
		expect(tokenQuery.limit).toBe(200);
		expect(tokenQuery.columns).not.toHaveProperty("accessToken");
		expect(tokenQuery.columns).not.toHaveProperty("refreshToken");
	});
});
