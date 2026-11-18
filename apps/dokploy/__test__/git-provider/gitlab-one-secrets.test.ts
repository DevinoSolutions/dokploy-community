import { beforeEach, describe, expect, it, vi } from "vitest";

// gitlab.one hides the provider's credentials from a caller who may not view
// them. `webhookSecret` authenticates /api/deploy/gitlab (findGitlabByWebhookSecret),
// so whoever holds it can trigger deploys: it is one of those credentials.
const mocks = vi.hoisted(() => ({
	findGitlabById: vi.fn(),
	canViewGitProviderSecrets: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	findGitlabById: mocks.findGitlabById,
	canViewGitProviderSecrets: mocks.canViewGitProviderSecrets,
	assertGitProviderAccess: vi.fn(async () => undefined),
	getAccessibleGitProviderIds: vi.fn(async () => new Set()),
}));
vi.mock("@dokploy/server/db", () => ({ db: {} }));
vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
}));
vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

const { gitlabRouter } = await import("@/server/api/routers/gitlab");

const caller = gitlabRouter.createCaller({
	user: { id: "u1", role: "member" },
	session: { activeOrganizationId: "org-a" },
} as never);

const row = () => ({
	gitlabId: "gl-1",
	gitlabUrl: "https://gitlab.example.com",
	applicationId: "app-1",
	secret: "SECRET-secret",
	accessToken: "SECRET-access",
	refreshToken: "SECRET-refresh",
	webhookSecret: "SECRET-webhook",
	gitProvider: { gitProviderId: "gp-1", organizationId: "org-a" },
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findGitlabById.mockResolvedValue(row());
});

describe("gitlab.one", () => {
	it("returns every credential to a caller who may view them", async () => {
		mocks.canViewGitProviderSecrets.mockResolvedValue(true);

		const result = await caller.one({ gitlabId: "gl-1" });

		expect(result.webhookSecret).toBe("SECRET-webhook");
		expect(result.accessToken).toBe("SECRET-access");
	});

	it("blanks every credential, the webhook secret included, for one who may not", async () => {
		mocks.canViewGitProviderSecrets.mockResolvedValue(false);

		const result = await caller.one({ gitlabId: "gl-1" });

		expect(result).toMatchObject({
			gitlabId: "gl-1",
			gitlabUrl: "https://gitlab.example.com",
			secret: null,
			accessToken: null,
			refreshToken: null,
			webhookSecret: null,
		});
		expect(JSON.stringify(result)).not.toContain("SECRET-");
	});
});
