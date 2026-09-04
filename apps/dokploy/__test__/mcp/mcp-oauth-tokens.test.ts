import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = await import("@dokploy/server/db");
const { createConsentProof, findMcpAccessToken, verifyConsentProof } =
	await import("@dokploy/server/services/mcp-oauth");

const findFirst = vi.mocked(db.query.oauthAccessToken.findFirst);

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
		const expired = createConsentProof(basePayload, "secret", Date.now() - 1000);
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
});
