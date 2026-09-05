import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/services/mcp-oauth", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/services/mcp-oauth")>();
	return {
		...actual,
		resolveMcpOrigin: vi.fn(async () => "https://dok.example.com"),
		resolveDefaultOrganizationId: vi.fn(async () => "org-1"),
		findOrganizationName: vi.fn(async () => ({ id: "org-1", name: "Devino" })),
		findOAuthApplicationByClientId: vi.fn(async () => clientRow),
		listMcpAuthorizations: vi.fn(async () => []),
		revokeMcpAuthorization: vi.fn(async () => {}),
		recordMcpConsent: vi.fn(async () => {}),
		createConsentProof: vi.fn(() => "123.sig"),
		isMcpDisabled: vi.fn(() => false),
	};
});

let clientRow: {
	clientId: string;
	name: string;
	redirectUrls: string[];
	disabled: boolean;
} | null = null;

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");
const { isMcpDisabled, revokeMcpAuthorization } = await import(
	"@dokploy/server/services/mcp-oauth"
);

const caller = createCallerFactory(appRouter)({
	user: {
		id: "user-1",
		email: "u@example.com",
		role: "member",
		ownerId: "owner",
	},
	session: { activeOrganizationId: "org-1" },
	req: { headers: {} },
	res: {},
} as never);

const approveInput = {
	clientId: "client-1",
	redirectUri: "http://localhost:4321/callback",
	responseType: "code",
	state: "st",
	codeChallenge: "chal",
	codeChallengeMethod: "S256",
	scopes: ["dokploy:read", "dokploy:deploy"],
};

describe("mcp router", () => {
	beforeEach(() => {
		clientRow = {
			clientId: "client-1",
			name: "Claude Code",
			redirectUrls: ["http://localhost:4321/callback"],
			disabled: false,
		};
	});

	it("connectionInfo reports endpoint, add command, organization and scope catalogue", async () => {
		const info = await caller.mcp.connectionInfo();
		expect(info.enabled).toBe(true);
		expect(info.endpoint).toBe("https://dok.example.com/api/mcp");
		expect(info.addCommand).toBe(
			"claude mcp add --transport http --scope user dokploy https://dok.example.com/api/mcp",
		);
		expect(info.organization).toEqual({ id: "org-1", name: "Devino" });
		expect(info.scopes.map((s) => s.id)).toContain("dokploy:read");
		expect(info.scopes.every((s) => typeof s.toolCount === "number")).toBe(
			true,
		);
	});

	it("revokeAuthorization is scoped to the caller", async () => {
		await caller.mcp.revokeAuthorization({ clientId: "client-1" });
		expect(revokeMcpAuthorization).toHaveBeenCalledWith("user-1", "client-1");
	});

	it("approveAuthorization records the grant and returns the plugin URL with openid/offline_access, sorted scopes and the consent proof", async () => {
		const { recordMcpConsent } = await import(
			"@dokploy/server/services/mcp-oauth"
		);
		const { url } = await caller.mcp.approveAuthorization(approveInput);
		expect(recordMcpConsent).toHaveBeenCalledWith("user-1", "client-1", [
			"dokploy:deploy",
			"dokploy:read",
		]);
		const parsed = new URL(url, "https://dok.example.com");
		expect(parsed.pathname).toBe("/api/auth/mcp/authorize");
		expect(parsed.searchParams.get("scope")).toBe(
			"openid offline_access dokploy:deploy dokploy:read",
		);
		expect(parsed.searchParams.get("consent")).toBe("123.sig");
		expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
		expect(parsed.searchParams.get("state")).toBe("st");
	});

	it("approveAuthorization rejects unknown clients, unregistered redirects, bad PKCE and unknown scopes", async () => {
		await expect(
			caller.mcp.approveAuthorization({
				...approveInput,
				redirectUri: "http://localhost:9/other",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			caller.mcp.approveAuthorization({
				...approveInput,
				codeChallengeMethod: "plain",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			caller.mcp.approveAuthorization({
				...approveInput,
				scopes: ["dokploy:root"],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		clientRow = null;
		await expect(
			caller.mcp.approveAuthorization(approveInput),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("approveAuthorization refuses to mint a proof while the kill switch is on", async () => {
		const { recordMcpConsent } = await import(
			"@dokploy/server/services/mcp-oauth"
		);
		vi.mocked(recordMcpConsent).mockClear();
		vi.mocked(isMcpDisabled).mockReturnValueOnce(true);
		await expect(
			caller.mcp.approveAuthorization(approveInput),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(recordMcpConsent).not.toHaveBeenCalled();
	});
});
