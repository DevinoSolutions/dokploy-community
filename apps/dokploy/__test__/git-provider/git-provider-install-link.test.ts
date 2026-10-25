import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// "Action Required" providers have a link that finishes the connection (GitHub
// App install, GitLab authorize). The server routes behind it refuse anyone but
// the provider's creator or an org owner/admin, so a member does not get the
// link (it ended on a 403 page).

const mocks = vi.hoisted(() => ({
	providers: [] as unknown[],
	role: "member" as string,
}));

vi.mock("@/utils/api", () => {
	const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
	return {
		api: {
			gitProvider: {
				getAll: {
					useQuery: () => ({
						data: mocks.providers,
						isPending: false,
						refetch: vi.fn(),
					}),
				},
				remove: { useMutation: mutation },
				toggleShare: { useMutation: mutation },
			},
			user: {
				get: { useQuery: () => ({ data: { role: mocks.role } }) },
				getPermissions: {
					useQuery: () => ({ data: { gitProviders: { create: true } } }),
				},
			},
		},
	};
});

// The provider dialogs are not what is under test.
vi.mock(
	"@/components/dashboard/settings/git/bitbucket/add-bitbucket-provider",
	() => ({ AddBitbucketProvider: () => null }),
);
vi.mock(
	"@/components/dashboard/settings/git/bitbucket/edit-bitbucket-provider",
	() => ({ EditBitbucketProvider: () => null }),
);
vi.mock("@/components/dashboard/settings/git/gitea/add-gitea-provider", () => ({
	AddGiteaProvider: () => null,
}));
vi.mock(
	"@/components/dashboard/settings/git/gitea/edit-gitea-provider",
	() => ({ EditGiteaProvider: () => null }),
);
vi.mock(
	"@/components/dashboard/settings/git/github/add-github-provider",
	() => ({ AddGithubProvider: () => null }),
);
vi.mock(
	"@/components/dashboard/settings/git/github/edit-github-provider",
	() => ({ EditGithubProvider: () => null }),
);
vi.mock(
	"@/components/dashboard/settings/git/gitlab/add-gitlab-provider",
	() => ({ AddGitlabProvider: () => null }),
);
vi.mock(
	"@/components/dashboard/settings/git/gitlab/edit-gitlab-provider",
	() => ({ EditGitlabProvider: () => null }),
);

const { ShowGitProviders } = await import(
	"@/components/dashboard/settings/git/show-git-providers"
);

const provider = (
	type: "github" | "gitlab",
	{ isOwner }: { isOwner: boolean },
) => ({
	gitProviderId: `gp-${type}`,
	name: `my-${type}`,
	providerType: type,
	createdAt: new Date("2026-10-01T00:00:00Z").toISOString(),
	isOwner,
	sharedWithOrganization: true,
	github:
		type === "github"
			? {
					githubId: "github-1",
					githubAppName: "https://github.com/apps/test",
					githubUrl: "https://github.com",
					isConfigured: false,
				}
			: null,
	gitlab:
		type === "gitlab" ? { gitlabId: "gitlab-1", isConfigured: false } : null,
});

const render = () => renderToStaticMarkup(createElement(ShowGitProviders));

const GITHUB_LINK = "/api/providers/github/authorize?githubId=github-1";
const GITLAB_LINK = "/api/providers/gitlab/authorize?gitlabId=gitlab-1";

beforeEach(() => {
	mocks.role = "member";
	mocks.providers = [
		provider("github", { isOwner: false }),
		provider("gitlab", { isOwner: false }),
	];
});

describe("Action Required links", () => {
	it("are hidden from a member who did not create the provider", () => {
		const html = render();

		expect(html).toContain("Action Required");
		expect(html).not.toContain(GITHUB_LINK);
		expect(html).not.toContain(GITLAB_LINK);
	});

	it("are shown to the provider's creator", () => {
		mocks.providers = [
			provider("github", { isOwner: true }),
			provider("gitlab", { isOwner: true }),
		];
		const html = render();

		expect(html).toContain(GITHUB_LINK);
		expect(html).toContain(GITLAB_LINK);
	});

	it.each(["admin", "owner"])("are shown to an org %s", (role) => {
		mocks.role = role;
		const html = render();

		expect(html).toContain(GITHUB_LINK);
		expect(html).toContain(GITLAB_LINK);
	});

	it("no longer put an unsigned state in the GitHub install link", () => {
		mocks.role = "admin";

		expect(render()).not.toContain("gh_setup");
	});
});
