import { parse } from "shell-quote";
import { describe, expect, it, vi } from "vitest";

// Fork-only coverage for the header-based clone credentials (Dokploy#5619):
// Bitbucket, preview head-ref checkouts, compose clones and remote servers.

vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: vi.fn(async () => ({
		githubId: "gh-1",
		githubUrl: "https://github.com",
		githubAppId: 1,
		githubPrivateKey: "key",
		githubInstallationId: "42",
	})),
}));

vi.mock("@octokit/auth-app", () => ({
	createAppAuth: vi.fn(),
}));

vi.mock("octokit", () => ({
	Octokit: class {
		auth = async () => ({ token: "gh-token" });
	},
}));

vi.mock("@dokploy/server/services/gitlab", () => ({
	findGitlabById: vi.fn(async () => ({
		gitlabId: "gl-1",
		gitlabUrl: "https://gitlab.example.com",
		gitlabInternalUrl: null,
		accessToken: "gl-token",
		expiresAt: Math.floor(Date.now() / 1000) + 3600,
	})),
	updateGitlab: vi.fn(),
}));

vi.mock("@dokploy/server/services/gitea", () => ({
	findGiteaById: vi.fn(async () => ({
		giteaId: "gt-1",
		giteaUrl: "https://gitea.example.com:3000",
		giteaInternalUrl: null,
		accessToken: "gt-token",
	})),
	updateGitea: vi.fn(),
}));

const bitbucketRows = vi.hoisted(() => ({
	current: {} as Record<string, string | null>,
}));

vi.mock("@dokploy/server/services/bitbucket", () => ({
	findBitbucketById: vi.fn(async () => bitbucketRows.current),
}));

const { cloneBitbucketRepository } = await import(
	"@dokploy/server/utils/providers/bitbucket"
);
const { cloneGithubRepository } = await import(
	"@dokploy/server/utils/providers/github"
);
const { cloneGitlabRepository } = await import(
	"@dokploy/server/utils/providers/gitlab"
);
const { cloneGiteaRepository } = await import(
	"@dokploy/server/utils/providers/gitea"
);

const basic = (value: string) => Buffer.from(value).toString("base64");

/** Every `-c <value>` pair git is given, as the shell would split them. */
const gitConfigArgs = (command: string): string[] => {
	const tokens = parse(command);
	const values: string[] = [];
	tokens.forEach((token, index) => {
		const next = tokens[index + 1];
		if (token === "-c" && typeof next === "string") {
			values.push(next);
		}
	});
	return values;
};

const header = (origin: string, credentials: string) =>
	`http.${origin}/.extraHeader=Authorization: Basic ${basic(credentials)}`;

// One shell word: quoted (spaces, Windows paths) or bare.
const ARG = "(?:'[^']*'|[^\\s']+)";
const REMOTE_COMPOSE_CODE = /compose[\\/]+my-app[\\/]+code/;

const base = { appName: "my-app", enableSubmodules: true, serverId: null };

describe("Bitbucket clone keeps credentials out of the URL", () => {
	const clone = (type?: "application" | "compose", serverId = null) =>
		cloneBitbucketRepository({
			...base,
			serverId,
			type,
			bitbucketRepository: "web",
			bitbucketOwner: "acme",
			bitbucketBranch: "main",
			bitbucketId: "bb-1",
		});

	it("sends an API token as the x-bitbucket-api-token-auth user", async () => {
		bitbucketRows.current = {
			apiToken: "bb-api-token",
			bitbucketEmail: "dev@acme.test",
			bitbucketUsername: null,
			appPassword: null,
		};

		const command = await clone();

		expect(command).not.toContain("bb-api-token");
		expect(command.replace(/\\/g, "")).toContain(
			"--recurse-submodules https://bitbucket.org/acme/web.git ",
		);
		expect(gitConfigArgs(command)).toEqual([
			header(
				"https://bitbucket.org",
				"x-bitbucket-api-token-auth:bb-api-token",
			),
		]);
	});

	it("sends username and app password as Basic credentials", async () => {
		bitbucketRows.current = {
			apiToken: null,
			bitbucketUsername: "acme-dev",
			appPassword: "app-pass",
		};

		const command = await clone();

		expect(command).not.toContain("app-pass");
		expect(command).not.toContain("acme-dev:");
		expect(gitConfigArgs(command)).toEqual([
			header("https://bitbucket.org", "acme-dev:app-pass"),
		]);
	});

	it("keeps a hostile app password inside a single quoted argument", async () => {
		const password = `p'a"ss $(touch /tmp/pwned);\`id\` w d`;
		bitbucketRows.current = {
			apiToken: null,
			bitbucketUsername: "acme-dev",
			appPassword: password,
		};

		const command = await clone();

		// Only base64 reaches the shell, and it round-trips to the exact header.
		expect(command).not.toContain("touch /tmp/pwned");
		expect(gitConfigArgs(command)).toEqual([
			header("https://bitbucket.org", `acme-dev:${password}`),
		]);
	});

	it("applies to compose clones on a remote server too", async () => {
		bitbucketRows.current = {
			apiToken: null,
			bitbucketUsername: "acme-dev",
			appPassword: "app-pass",
		};

		const command = await clone("compose", "srv-1" as never);

		expect(command).not.toContain("app-pass");
		expect(command).toMatch(REMOTE_COMPOSE_CODE);
		expect(gitConfigArgs(command)).toHaveLength(1);
	});
});

describe("preview head-ref checkouts keep the token out of the remote", () => {
	const headRefBase = { ...base, enableSubmodules: true };

	it.each([
		{
			provider: "github",
			token: "gh-token",
			origin: "https://github.com",
			url: "https://github.com/acme/web.git",
			build: () =>
				cloneGithubRepository({
					...headRefBase,
					owner: "acme",
					repository: "web",
					branch: "feature/thing",
					headRef: "refs/pull/7/head",
					githubId: "gh-1",
				}),
		},
		{
			provider: "gitlab",
			token: "gl-token",
			origin: "https://gitlab.example.com",
			url: "https://gitlab.example.com/acme/web.git",
			build: () =>
				cloneGitlabRepository({
					...headRefBase,
					gitlabBranch: "feature/thing",
					headRef: "refs/merge-requests/7/head",
					gitlabId: "gl-1",
					gitlabPathNamespace: "acme/web",
					gitlabOwner: "acme",
					gitlabRepository: "web",
				} as Parameters<typeof cloneGitlabRepository>[0]),
		},
		{
			provider: "gitea",
			token: "gt-token",
			origin: "https://gitea.example.com:3000",
			url: "https://gitea.example.com:3000/acme/web.git",
			build: () =>
				cloneGiteaRepository({
					...headRefBase,
					giteaBranch: "feature/thing",
					headRef: "refs/pull/7/head",
					giteaId: "gt-1",
					giteaOwner: "acme",
					giteaRepository: "web",
				}),
		},
	])(
		"$provider adds the header to fetch and submodule update, not the remote",
		async ({ token, origin, url, build }) => {
			const command = await build();
			const plain = command.replace(/\\/g, "");

			expect(command).not.toContain(token);
			expect(plain).toContain(`remote add origin ${url};`);
			expect(plain).not.toMatch(/\/\/[^/\s]*@/);

			// Both fetches (head ref, then the branch fallback) and the submodule
			// update talk to the remote, so each one carries the header.
			expect(gitConfigArgs(command)).toEqual([
				header(origin, `oauth2:${token}`),
				header(origin, `oauth2:${token}`),
				header(origin, `oauth2:${token}`),
			]);
			expect(plain).toMatch(new RegExp(`git -c ${ARG} -C ${ARG} fetch `));
			expect(plain).toMatch(
				new RegExp(`git -c ${ARG} -C ${ARG} submodule update `),
			);
			// Local-only steps never need credentials.
			expect(plain).toMatch(
				new RegExp(`git -C ${ARG} checkout -q FETCH_HEAD;`),
			);
			expect(plain).toMatch(new RegExp(`git -C ${ARG} remote add origin `));
		},
	);
});

describe("compose clones on a remote server", () => {
	it("passes the quoted header in the command string run over SSH", async () => {
		const command = await cloneGithubRepository({
			...base,
			type: "compose",
			serverId: "srv-1",
			owner: "acme",
			repository: "web",
			branch: "main",
			githubId: "gh-1",
		});

		expect(command).toMatch(REMOTE_COMPOSE_CODE);
		expect(command).not.toContain("gh-token");
		expect(gitConfigArgs(command)).toEqual([
			header("https://github.com", "oauth2:gh-token"),
		]);
		// The value contains a space: it must stay one quoted argument.
		expect(command).toContain("-c 'http.https://github.com/.extraHeader=");
	});
});
