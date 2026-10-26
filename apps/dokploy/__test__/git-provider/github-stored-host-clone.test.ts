import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A clone runs under git, outside the pinned fetch, so cloneGithubRepository
// checks the stored host itself before the token is minted or any command is
// built, and tells git not to follow a redirect from an Enterprise host.

const mocks = vi.hoisted(() => ({
	findGithubById: vi.fn(),
	lookup: vi.fn(),
	octokitCreated: vi.fn(),
}));

vi.mock("node:dns/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:dns/promises")>()),
	lookup: mocks.lookup,
}));

vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: mocks.findGithubById,
}));

vi.mock("@octokit/auth-app", () => ({
	createAppAuth: vi.fn(),
}));

vi.mock("octokit", () => ({
	Octokit: class {
		constructor() {
			mocks.octokitCreated();
		}
		auth = async () => ({ token: "gh-token" });
	},
}));

const { cloneGithubRepository } = await import(
	"@dokploy/server/utils/providers/github"
);
const { GithubHostError } = await import(
	"@dokploy/server/utils/providers/github-host"
);

const provider = (githubUrl: string) => ({
	githubId: "gh-1",
	githubUrl,
	githubAppId: 1,
	githubPrivateKey: "key",
	githubInstallationId: "42",
});

const clone = async (extra: Record<string, unknown> = {}) =>
	(
		await cloneGithubRepository({
			appName: "my-app",
			owner: "acme",
			repository: "web",
			branch: "main",
			githubId: "gh-1",
			enableSubmodules: false,
			serverId: null,
			...extra,
		})
	).replace(/\\/g, "");

const NO_REDIRECTS = "-c http.followRedirects=false";

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	mocks.lookup.mockResolvedValue([{ address: "140.82.112.3", family: 4 }]);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("cloneGithubRepository checks the stored host", () => {
	it.each([
		["a private address", "10.20.30.40"],
		["loopback", "127.0.0.1"],
		["the metadata address", "169.254.169.254"],
	])("refuses a host that now resolves to %s", async (_label, address) => {
		mocks.findGithubById.mockResolvedValue(
			provider("https://github.corp.acme.com"),
		);
		mocks.lookup.mockResolvedValue([{ address, family: 4 }]);

		const error = await clone().catch((e) => e);

		expect(error).toBeInstanceOf(GithubHostError);
		expect(error.message).toContain("github.corp.acme.com");
		expect(error.message).not.toContain(address);
		// Before the token is minted or a command is built.
		expect(mocks.octokitCreated).not.toHaveBeenCalled();
	});

	it("refuses an IP address and an internal name without resolving it", async () => {
		for (const githubUrl of ["https://10.0.0.5", "https://ghe.internal"]) {
			mocks.findGithubById.mockResolvedValue(provider(githubUrl));
			await expect(clone()).rejects.toBeInstanceOf(GithubHostError);
		}
		expect(mocks.lookup).not.toHaveBeenCalled();
	});

	it("checks the API host of a ghe.com tenant too", async () => {
		mocks.findGithubById.mockResolvedValue(provider("https://acme.ghe.com"));
		mocks.lookup.mockImplementation(async (hostname: string) => [
			{
				address: hostname.startsWith("api.") ? "10.0.0.9" : "140.82.112.3",
				family: 4,
			},
		]);

		await expect(clone()).rejects.toBeInstanceOf(GithubHostError);
		expect(mocks.lookup.mock.calls.map((call) => call[0])).toEqual([
			"acme.ghe.com",
			"api.acme.ghe.com",
		]);
	});

	it("clones from an allowlisted host that resolves to a private address", async () => {
		vi.stubEnv("DOKPLOY_GITHUB_ENTERPRISE_ALLOWED_HOSTS", "ghe.corp.internal");
		mocks.findGithubById.mockResolvedValue(
			provider("https://ghe.corp.internal"),
		);
		mocks.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

		const command = await clone();

		expect(command).toContain("https://ghe.corp.internal/acme/web.git");
		expect(mocks.octokitCreated).toHaveBeenCalled();
	});

	it("does not resolve github.com", async () => {
		for (const githubUrl of ["https://github.com", ""]) {
			mocks.findGithubById.mockResolvedValue(provider(githubUrl));
			await clone();
		}
		expect(mocks.lookup).not.toHaveBeenCalled();
	});
});

describe("cloneGithubRepository and redirects", () => {
	it("tells git not to follow redirects when it clones from an Enterprise host", async () => {
		mocks.findGithubById.mockResolvedValue(
			provider("https://github.corp.acme.com"),
		);

		const command = await clone();

		expect(command).toContain(`git ${NO_REDIRECTS} -c 'http.https://`);
		expect(command).toMatch(/clone --branch main --depth 1/);
	});

	it("applies it to the pinned checkout and to the preview head ref fetches", async () => {
		mocks.findGithubById.mockResolvedValue(
			provider("https://github.corp.acme.com"),
		);

		const pinned = await clone({ pinCommit: "a".repeat(40) });
		const preview = await clone({
			headRef: "refs/pull/7/head",
			enableSubmodules: true,
		});

		// Every command that talks to the remote carries it.
		for (const command of [pinned, preview]) {
			const remoteCalls = command
				.split(";")
				.filter((part) => /\b(clone|fetch|submodule update)\b/.test(part))
				.filter((part) => part.includes("git "));
			expect(remoteCalls.length).toBeGreaterThan(0);
			for (const call of remoteCalls) {
				expect(call).toContain(NO_REDIRECTS);
			}
		}
	});

	it("leaves github.com as it was", async () => {
		mocks.findGithubById.mockResolvedValue(provider("https://github.com"));

		const command = await clone({ pinCommit: "a".repeat(40) });

		expect(command).not.toContain("followRedirects");
	});
});
