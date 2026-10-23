import { beforeEach, describe, expect, it, vi } from "vitest";

// `gitProviders:create` is what lets a member add a provider of their own, so
// it must not also let them rewrite one somebody else connected: that swaps the
// token or endpoint every deploy using the provider clones with. Only the
// provider's creating user or an org owner/admin may update it (T-6895).
const mocks = vi.hoisted(() => ({
	findMember: vi.fn(),
	findGithubById: vi.fn(),
	findGitlabById: vi.fn(),
	findGiteaById: vi.fn(),
	findBitbucketById: vi.fn(),
	updateGithub: vi.fn(),
	updateGitlab: vi.fn(),
	updateGitea: vi.fn(),
	updateBitbucket: vi.fn(),
	updateGitProvider: vi.fn(),
}));

vi.mock("@dokploy/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/db")>()),
	db: { query: { member: { findFirst: mocks.findMember } } },
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(async () => false),
}));

vi.mock("@dokploy/server", async () => {
	// the real authorization, over the scripted member row
	const real = await vi.importActual<
		typeof import("@dokploy/server/services/git-provider")
	>("@dokploy/server/services/git-provider");
	const stubs: Record<string | symbol, unknown> = {};
	const named: Record<string, unknown> = {
		IS_CLOUD: false,
		assertCanUpdateGitProvider: real.assertCanUpdateGitProvider,
		canViewGitProviderSecrets: real.canViewGitProviderSecrets,
		findGithubById: mocks.findGithubById,
		findGitlabById: mocks.findGitlabById,
		findGiteaById: mocks.findGiteaById,
		findBitbucketById: mocks.findBitbucketById,
		updateGithub: mocks.updateGithub,
		updateGitlab: mocks.updateGitlab,
		updateGitea: mocks.updateGitea,
		updateBitbucket: mocks.updateBitbucket,
		updateGitProvider: mocks.updateGitProvider,
	};
	return new Proxy(stubs, {
		get: (target, key) => {
			if (key === "then") {
				return undefined;
			}
			if (typeof key === "string" && key in named) {
				return named[key];
			}
			target[key] ??= vi.fn();
			return target[key];
		},
		has: () => true,
	});
});

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
	findMemberByUserId: vi.fn(async () => ({ accessedProjects: [] })),
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

const PROVIDERS = [
	{
		router: "github",
		idKey: "githubId",
		find: () => mocks.findGithubById,
		update: () => mocks.updateGithub,
		input: {
			githubAppName: "app",
		},
	},
	{
		router: "gitlab",
		idKey: "gitlabId",
		find: () => mocks.findGitlabById,
		update: () => mocks.updateGitlab,
		input: { gitlabUrl: "https://gitlab.example.com" },
	},
	{
		router: "gitea",
		idKey: "giteaId",
		find: () => mocks.findGiteaById,
		update: () => mocks.updateGitea,
		input: { giteaUrl: "https://gitea.example.com" },
	},
	{
		router: "bitbucket",
		idKey: "bitbucketId",
		find: () => mocks.findBitbucketById,
		update: () => mocks.updateBitbucket,
		input: { bitbucketUsername: "me" },
	},
] as const;

const ctxOf = (userId: string) => ({
	session: { activeOrganizationId: "org-1", userId },
	user: { id: userId, email: `${userId}@example.com`, role: "member" },
});

const callerOf = async (router: string, userId: string) => {
	const module = await import(`@/server/api/routers/${router}`);
	return module[`${router}Router`].createCaller(ctxOf(userId));
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.updateGitProvider.mockResolvedValue({});
	for (const provider of PROVIDERS) {
		provider.find().mockResolvedValue({
			[provider.idKey]: "provider-1",
			gitProviderId: "gp-1",
			gitProvider: {
				gitProviderId: "gp-1",
				userId: "creator",
				organizationId: "org-1",
			},
		});
		provider.update().mockResolvedValue({});
	}
});

describe.each(PROVIDERS)("$router.update", { timeout: 60_000 }, (provider) => {
	const input = {
		[provider.idKey]: "provider-1",
		gitProviderId: "gp-1",
		name: "renamed",
		...provider.input,
	};

	it("refuses a member who did not create the provider", async () => {
		mocks.findMember.mockResolvedValue({ role: "member" });
		const caller = await callerOf(provider.router, "other-member");

		await expect(caller.update(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(provider.update()).not.toHaveBeenCalled();
		expect(mocks.updateGitProvider).not.toHaveBeenCalled();
	});

	it("allows the user who created the provider", async () => {
		mocks.findMember.mockResolvedValue({ role: "member" });
		const caller = await callerOf(provider.router, "creator");

		await caller.update(input);

		expect(provider.update()).toHaveBeenCalledTimes(1);
	});

	it.each(["owner", "admin"])("allows an org %s", async (role) => {
		mocks.findMember.mockResolvedValue({ role });
		const caller = await callerOf(provider.router, "someone-else");

		await caller.update(input);

		expect(provider.update()).toHaveBeenCalledTimes(1);
	});

	it("still refuses a provider of another organization, even for its creator", async () => {
		mocks.findMember.mockResolvedValue({ role: "owner" });
		provider.find().mockResolvedValue({
			[provider.idKey]: "provider-1",
			gitProviderId: "gp-1",
			gitProvider: {
				gitProviderId: "gp-1",
				userId: "creator",
				organizationId: "org-other",
			},
		});
		const caller = await callerOf(provider.router, "creator");

		await expect(caller.update(input)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(provider.update()).not.toHaveBeenCalled();
	});
});
