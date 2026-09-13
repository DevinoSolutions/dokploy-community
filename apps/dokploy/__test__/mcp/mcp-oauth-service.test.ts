import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: vi.fn(async () => webServerSettingsRow),
}));

let webServerSettingsRow: { host?: string | null } | undefined;

const { db } = await import("@dokploy/server/db");
const {
	getMcpAccessTokenSeconds,
	getMcpRefreshGraceSeconds,
	getMcpRefreshTokenSeconds,
	isAllowedRedirectUri,
	isMcpDisabled,
	resolveDefaultOrganizationId,
	resolveMcpOrigin,
} = await import("@dokploy/server/services/mcp-oauth");

const findFirst = vi.mocked(db.query.member.findFirst);

// The vitest config statically `define`s `process.env`, so tests pass an
// explicit env object instead of mutating process.env.
describe("mcp-oauth env knobs", () => {
	it("defaults to 30d access / 365d refresh / 5min grace", () => {
		expect(getMcpAccessTokenSeconds({})).toBe(720 * 3600);
		expect(getMcpRefreshTokenSeconds({})).toBe(365 * 86400);
		expect(getMcpRefreshGraceSeconds({})).toBe(300);
	});

	it("honours positive integer overrides and ignores garbage", () => {
		expect(
			getMcpAccessTokenSeconds({ DOKPLOY_MCP_ACCESS_TOKEN_HOURS: "6" }),
		).toBe(6 * 3600);
		expect(
			getMcpRefreshTokenSeconds({ DOKPLOY_MCP_REFRESH_TOKEN_DAYS: "-3" }),
		).toBe(365 * 86400);
	});

	// Unlike the TTLs, 0 is a real setting here: it means "revoke at once".
	it("accepts a zero grace period but still rejects garbage", () => {
		expect(
			getMcpRefreshGraceSeconds({ DOKPLOY_MCP_REFRESH_GRACE_SECONDS: "0" }),
		).toBe(0);
		expect(
			getMcpRefreshGraceSeconds({ DOKPLOY_MCP_REFRESH_GRACE_SECONDS: "30" }),
		).toBe(30);
		expect(
			getMcpRefreshGraceSeconds({ DOKPLOY_MCP_REFRESH_GRACE_SECONDS: "-1" }),
		).toBe(300);
		expect(
			getMcpRefreshGraceSeconds({ DOKPLOY_MCP_REFRESH_GRACE_SECONDS: "nope" }),
		).toBe(300);
	});

	it("isMcpDisabled only for the literal string true", () => {
		expect(isMcpDisabled({ DOKPLOY_MCP_DISABLED: "true" })).toBe(true);
		expect(isMcpDisabled({ DOKPLOY_MCP_DISABLED: "1" })).toBe(false);
		expect(isMcpDisabled({})).toBe(false);
	});
});

describe("isAllowedRedirectUri", () => {
	it.each([
		"http://localhost/callback",
		"http://localhost:53421/callback",
		"http://127.0.0.1:8080/cb",
		"http://[::1]:5000/cb",
		"https://example.com/oauth/callback",
	])("allows %s", (uri) => {
		expect(isAllowedRedirectUri(uri)).toBe(true);
	});

	it.each([
		"http://example.com/callback",
		"http://localhost.evil.com/callback",
		"javascript:alert(1)",
		"custom-app://callback",
		"not a url",
		"",
		"https://example.com/cb#frag",
		"http://localhost:1234/cb#frag",
		"https://ok.example/a,http://evil.tld/cb",
	])("rejects %s", (uri) => {
		expect(isAllowedRedirectUri(uri)).toBe(false);
	});
});

describe("resolveMcpOrigin", () => {
	beforeEach(() => {
		webServerSettingsRow = undefined;
	});

	it("prefers BETTER_AUTH_URL (origin only)", async () => {
		webServerSettingsRow = { host: "other.example.com" };
		expect(
			await resolveMcpOrigin(
				{},
				{ BETTER_AUTH_URL: "https://dok.example.com/api/auth" },
			),
		).toBe("https://dok.example.com");
	});

	it("falls back to https://<webServerSettings.host>", async () => {
		webServerSettingsRow = { host: "dok.example.com" };
		expect(await resolveMcpOrigin({}, {})).toBe("https://dok.example.com");
	});

	it("returns null when nothing is configured outside development", async () => {
		webServerSettingsRow = { host: null };
		expect(
			await resolveMcpOrigin(
				{ host: "1.2.3.4:3000" },
				{ NODE_ENV: "production" },
			),
		).toBeNull();
	});

	it("uses the Host header in development only", async () => {
		webServerSettingsRow = { host: null };
		expect(
			await resolveMcpOrigin(
				{ host: "localhost:3000" },
				{ NODE_ENV: "development" },
			),
		).toBe("http://localhost:3000");
	});
});

describe("resolveDefaultOrganizationId", () => {
	beforeEach(() => {
		findFirst.mockReset();
	});

	it("returns the organization of the first membership row (ordered is_default desc, created_at asc)", async () => {
		findFirst.mockResolvedValueOnce({ organizationId: "org-default" } as never);
		expect(await resolveDefaultOrganizationId("user-1")).toBe("org-default");
		const call = findFirst.mock.calls[0]?.[0] as { orderBy?: unknown[] };
		expect(call.orderBy).toHaveLength(2);
	});

	it("returns null without a membership", async () => {
		findFirst.mockResolvedValueOnce(undefined as never);
		expect(await resolveDefaultOrganizationId("user-1")).toBeNull();
	});
});
