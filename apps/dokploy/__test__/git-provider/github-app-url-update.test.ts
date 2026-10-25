import { beforeEach, describe, expect, it, vi } from "vitest";

// The install step sends the browser to the stored app URL, so a changed link
// has to stay on the provider's GitHub instance. A value that is saved again
// unchanged is not re-judged, so providers saved earlier remain editable.

const mocks = vi.hoisted(() => ({
	findGithubById: vi.fn(),
	updateGithub: vi.fn(),
	updateGitProvider: vi.fn(),
	assertCanUpdateGitProvider: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({ db: {} }));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server", async () => {
	const { parseGithubAppUrl } = await vi.importActual<
		typeof import("@dokploy/server/utils/providers/github")
	>("@dokploy/server/utils/providers/github");
	return {
		parseGithubAppUrl,
		findGithubById: mocks.findGithubById,
		updateGithub: mocks.updateGithub,
		updateGitProvider: mocks.updateGitProvider,
		assertCanUpdateGitProvider: mocks.assertCanUpdateGitProvider,
		assertGitProviderAccess: vi.fn(),
		canViewGitProviderSecrets: vi.fn(),
		getAccessibleGitProviderIds: vi.fn(),
		getGithubBranches: vi.fn(),
		getGithubPullRequests: vi.fn(),
		getGithubRepositories: vi.fn(),
		haveGithubRequirements: vi.fn(),
	};
});

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

const { githubRouter } = await import("@/server/api/routers/github");

const caller = githubRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
} as Parameters<typeof githubRouter.createCaller>[0]);

const STORED = "https://github.com/apps/dokploy-test";

const input = (githubAppName: string) => ({
	githubId: "github-1",
	gitProviderId: "gp-1",
	name: "my-github",
	githubAppName,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findGithubById.mockResolvedValue({
		githubId: "github-1",
		gitProviderId: "gp-1",
		githubUrl: "https://github.com",
		githubAppName: STORED,
		gitProvider: { gitProviderId: "gp-1", organizationId: "org-a" },
	});
	mocks.assertCanUpdateGitProvider.mockResolvedValue(undefined);
});

describe("github.update app URL", () => {
	it("accepts a changed link on the provider's instance", async () => {
		await caller.update(input("https://github.com/apps/renamed"));

		expect(mocks.updateGithub).toHaveBeenCalledTimes(1);
	});

	it.each([
		"https://evil.example/apps/x",
		"javascript:alert(1)",
		"http://github.com/apps/x",
		"dokploy-test",
	])("refuses a changed link %s", async (githubAppName) => {
		await expect(caller.update(input(githubAppName))).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.updateGithub).not.toHaveBeenCalled();
		expect(mocks.updateGitProvider).not.toHaveBeenCalled();
	});

	it("keeps accepting the stored value, even one the rule would refuse", async () => {
		mocks.findGithubById.mockResolvedValue({
			githubId: "github-1",
			gitProviderId: "gp-1",
			githubUrl: "https://github.com",
			githubAppName: "my-personal-app",
			gitProvider: { gitProviderId: "gp-1", organizationId: "org-a" },
		});

		await caller.update(input("my-personal-app"));

		expect(mocks.updateGithub).toHaveBeenCalledTimes(1);
	});
});
