import { beforeEach, describe, expect, it, vi } from "vitest";

// The head-ref checkout only builds shell strings; provider lookups and token
// handling are stubbed so the generated command is the thing under test.
const mocks = vi.hoisted(() => ({
	findGithubById: vi.fn(),
	findGiteaById: vi.fn(),
	findGitlabById: vi.fn(),
}));

vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: mocks.findGithubById,
}));

vi.mock("@dokploy/server/services/gitea", () => ({
	findGiteaById: mocks.findGiteaById,
	updateGitea: vi.fn(),
}));

vi.mock("@dokploy/server/services/gitlab", () => ({
	findGitlabById: mocks.findGitlabById,
	updateGitlab: vi.fn(),
}));

vi.mock("@octokit/auth-app", () => ({
	createAppAuth: vi.fn(),
}));

vi.mock("octokit", () => ({
	Octokit: class {
		auth = async () => ({ token: "gh-token" });
	},
}));

const { buildHeadRefCheckoutCommand, buildPreviewHeadRef } = await import(
	"@dokploy/server/utils/providers/head-ref"
);
const { cloneGithubRepository } = await import(
	"@dokploy/server/utils/providers/github"
);
const { cloneGiteaRepository } = await import(
	"@dokploy/server/utils/providers/gitea"
);
const { cloneGitlabRepository } = await import(
	"@dokploy/server/utils/providers/gitlab"
);

describe("buildPreviewHeadRef", () => {
	it("maps each provider to its pull-request head ref on the base repo", () => {
		expect(buildPreviewHeadRef("github", "7")).toBe("refs/pull/7/head");
		expect(buildPreviewHeadRef("gitea", "7")).toBe("refs/pull/7/head");
		expect(buildPreviewHeadRef("gitlab", "42")).toBe(
			"refs/merge-requests/42/head",
		);
	});

	it("returns null for providers without such a ref or without a PR number", () => {
		expect(buildPreviewHeadRef("bitbucket", "7")).toBeNull();
		expect(buildPreviewHeadRef("git", "7")).toBeNull();
		expect(buildPreviewHeadRef("github", null)).toBeNull();
		expect(buildPreviewHeadRef("github", "")).toBeNull();
		expect(buildPreviewHeadRef(undefined, "7")).toBeNull();
	});
});

describe("buildHeadRefCheckoutCommand", () => {
	const base = {
		cloneUrl: "https://example.com/acme/web.git",
		branch: "feature/thing",
		outputPath: "/code/preview",
		enableSubmodules: false,
	};

	it("fetches the head ref first and falls back to the branch", () => {
		const command = buildHeadRefCheckoutCommand({
			...base,
			headRef: "refs/pull/7/head",
		});

		expect(command).toContain("git init -q /code/preview;");
		expect(command).toContain(
			"fetch --progress --depth 1 origin -- refs/pull/7/head",
		);
		// The `||` fallback keeps branch-based previews working when a server
		// does not advertise the ref (or the stored PR number is not a PR).
		expect(command).toContain(
			"origin -- refs/pull/7/head || git -C /code/preview fetch --progress --depth 1 origin -- feature/thing;",
		);
		expect(command).toContain("git -C /code/preview checkout -q FETCH_HEAD;");
		expect(command).not.toContain("git clone");
	});

	it("never lets a branch name that looks like an option reach git as a flag", () => {
		const command = buildHeadRefCheckoutCommand({
			...base,
			branch: "--upload-pack=touch /tmp/pwned",
			headRef: "refs/pull/7/head",
		});

		// `--` ends option parsing, so the quoted branch can only be a refspec.
		expect(command).toContain(
			"fetch --progress --depth 1 origin -- '--upload-pack=touch /tmp/pwned';",
		);
	});

	it("updates submodules after the checkout when enabled", () => {
		const command = buildHeadRefCheckoutCommand({
			...base,
			headRef: "refs/pull/7/head",
			enableSubmodules: true,
		});

		expect(command).toContain(
			"git -C /code/preview submodule update --init --recursive;",
		);
	});

	it("escapes a head ref containing shell metacharacters", () => {
		const command = buildHeadRefCheckoutCommand({
			...base,
			headRef: "refs/pull/$(id)/head",
		});

		// shell-quote backslash-escapes every metacharacter, so the command
		// substitution can never execute.
		expect(command).toContain("origin -- refs/pull/\\$\\(id\\)/head");
		expect(command).not.toContain("origin -- refs/pull/$(id)/head");
	});
});

describe("clone helpers with a head ref", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findGithubById.mockResolvedValue({
			githubId: "gh-1",
			githubUrl: "https://github.com",
			githubAppId: 1,
			githubPrivateKey: "key",
			githubInstallationId: "42",
		});
		mocks.findGiteaById.mockResolvedValue({
			giteaId: "gitea-1",
			giteaUrl: "https://gitea.example.com",
			giteaInternalUrl: null,
			accessToken: "gitea-token",
			refreshToken: null,
			clientId: null,
			clientSecret: null,
		});
		mocks.findGitlabById.mockResolvedValue({
			gitlabId: "gl-1",
			gitlabUrl: "https://gitlab.example.com",
			gitlabInternalUrl: null,
			accessToken: "gitlab-token",
			// Far enough ahead that refreshGitlabToken returns before fetching.
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
		});
	});

	it("checks out a GitHub PR head from the base repository", async () => {
		const command = await cloneGithubRepository({
			appName: "preview-app",
			owner: "acme",
			repository: "web",
			branch: "feature/thing",
			headRef: "refs/pull/7/head",
			githubId: "gh-1",
			enableSubmodules: false,
			serverId: null,
		});

		// shell-quote backslash-escapes the URL; strip them for the host check
		// (same normalization as github-clone-host.test.ts).
		expect(command.replace(/\\/g, "")).toContain(
			"https://oauth2:gh-token@github.com/acme/web.git",
		);
		expect(command).toContain(
			"fetch --progress --depth 1 origin -- refs/pull/7/head",
		);
		expect(command).toContain("origin -- refs/pull/7/head || git -C");
		expect(command).toContain("origin -- feature/thing;");
		expect(command).toContain("checkout -q FETCH_HEAD;");
		expect(command).not.toContain("git clone");
	});

	it("checks out a Gitea PR head from the base repository", async () => {
		const command = await cloneGiteaRepository({
			appName: "preview-app",
			giteaBranch: "feature/thing",
			headRef: "refs/pull/7/head",
			giteaId: "gitea-1",
			giteaOwner: "acme",
			giteaRepository: "web",
			enableSubmodules: false,
			serverId: null,
		});

		expect(command).toContain(
			"fetch --progress --depth 1 origin -- refs/pull/7/head",
		);
		expect(command).toContain("origin -- feature/thing;");
		expect(command).toContain("checkout -q FETCH_HEAD;");
		expect(command).not.toContain("git clone");
	});

	it("checks out a GitLab MR head from the base project", async () => {
		// gitlabOwner/gitlabRepository are checked by the clone requirements but
		// not declared on the interface — production passes them via the service
		// row spread, so spread them here too.
		const serviceRow = {
			gitlabOwner: "group",
			gitlabRepository: "repository",
		};
		const command = await cloneGitlabRepository({
			appName: "preview-app",
			gitlabBranch: "feature/thing",
			headRef: "refs/merge-requests/42/head",
			gitlabId: "gl-1",
			gitlabPathNamespace: "group/repository",
			enableSubmodules: false,
			serverId: null,
			...serviceRow,
		});

		expect(command).toContain(
			"fetch --progress --depth 1 origin -- refs/merge-requests/42/head",
		);
		expect(command).toContain("origin -- feature/thing;");
		expect(command).toContain("checkout -q FETCH_HEAD;");
		expect(command).not.toContain("git clone");
	});

	it("keeps the plain branch clone when no head ref is given", async () => {
		const command = await cloneGithubRepository({
			appName: "preview-app",
			owner: "acme",
			repository: "web",
			branch: "main",
			githubId: "gh-1",
			enableSubmodules: false,
			serverId: null,
		});

		expect(command).toContain("git clone --branch main");
		expect(command).not.toContain("git init -q");
		expect(command).not.toContain("FETCH_HEAD");
	});
});
