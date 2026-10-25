import { beforeEach, describe, expect, it, vi } from "vitest";

// The connection test calls the provider's stored host, and what comes back
// (a connection error, the text a service on that host answered) can name an
// internal address. The client gets a generic message, or the host policy's
// own message; the detail goes to the server log without addresses.

const mocks = vi.hoisted(() => ({
	findGithubById: vi.fn(),
	assertGitProviderAccess: vi.fn(),
	getGithubRepositories: vi.fn(),
	getGithubBranches: vi.fn(),
	getGithubPullRequests: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({ db: {} }));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server", async () => {
	const { githubClientError } = await vi.importActual<
		typeof import("@dokploy/server/utils/providers/github")
	>("@dokploy/server/utils/providers/github");
	return {
		githubClientError,
		findGithubById: mocks.findGithubById,
		assertGitProviderAccess: mocks.assertGitProviderAccess,
		assertCanUpdateGitProvider: vi.fn(),
		canViewGitProviderSecrets: vi.fn(),
		getAccessibleGitProviderIds: vi.fn(),
		getGithubBranches: mocks.getGithubBranches,
		getGithubPullRequests: mocks.getGithubPullRequests,
		getGithubRepositories: mocks.getGithubRepositories,
		haveGithubRequirements: vi.fn(),
		parseGithubAppUrl: vi.fn(),
		updateGithub: vi.fn(),
		updateGitProvider: vi.fn(),
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

const remoteFailure = () =>
	Object.assign(
		new Error(
			"connect ECONNREFUSED 10.0.0.5:443 - Dokploy internal admin panel: secret-banner",
		),
		{ name: "HttpError", status: 500, code: "ECONNREFUSED" },
	);

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	log = vi.spyOn(console, "error").mockImplementation(() => {});
	mocks.findGithubById.mockResolvedValue({
		githubId: "github-1",
		githubUrl: "https://github.corp.acme.com",
		gitProvider: { gitProviderId: "gp-1", organizationId: "org-a" },
	});
	mocks.assertGitProviderAccess.mockResolvedValue(undefined);
});

describe("github.testConnection", () => {
	it("reports the repositories it found", async () => {
		mocks.getGithubRepositories.mockResolvedValue([{}, {}]);

		await expect(caller.testConnection({ githubId: "github-1" })).resolves.toBe(
			"Found 2 repositories",
		);
	});

	it("returns a generic message and logs the detail without the address", async () => {
		mocks.getGithubRepositories.mockRejectedValue(remoteFailure());

		const error = await caller
			.testConnection({ githubId: "github-1" })
			.catch((e) => e);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toContain(
			"The request to the GitHub instance failed",
		);
		expect(error.message).not.toContain("10.0.0.5");
		expect(error.message).not.toContain("secret-banner");
		expect(error.message).not.toContain("ECONNREFUSED");

		const logged = String(log.mock.calls[0]?.[0]);
		expect(logged).toContain("testConnection");
		expect(logged).toContain("ECONNREFUSED");
		expect(logged).not.toContain("10.0.0.5");
	});

	it("keeps the host policy's message, which tells an administrator what to allow", async () => {
		mocks.getGithubRepositories.mockRejectedValue(
			Object.assign(
				new Error(
					'"github.corp.acme.com" does not resolve to a public address, which is not accepted for a GitHub Enterprise URL. Use the public host name of the instance, or ask an administrator to allow it with DOKPLOY_GITHUB_ENTERPRISE_ALLOWED_HOSTS.',
				),
				{ status: 400 },
			),
		);

		await expect(
			caller.testConnection({ githubId: "github-1" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining(
				"DOKPLOY_GITHUB_ENTERPRISE_ALLOWED_HOSTS",
			),
		});
	});

	it("does not call the host when the caller has no access to the provider", async () => {
		mocks.assertGitProviderAccess.mockRejectedValue(new Error("no access"));

		await expect(
			caller.testConnection({ githubId: "github-1" }),
		).rejects.toThrow();
		expect(mocks.getGithubRepositories).not.toHaveBeenCalled();
	});
});

describe("the other calls to the stored host", () => {
	it("do not pass the remote text on either", async () => {
		mocks.getGithubRepositories.mockRejectedValue(remoteFailure());
		mocks.getGithubBranches.mockRejectedValue(remoteFailure());
		mocks.getGithubPullRequests.mockRejectedValue(remoteFailure());

		const errors = await Promise.all([
			caller.getGithubRepositories({ githubId: "github-1" }).catch((e) => e),
			caller
				.getGithubBranches({ githubId: "github-1", owner: "a", repo: "b" })
				.catch((e) => e),
			caller
				.getGithubPullRequests({ githubId: "github-1", owner: "a", repo: "b" })
				.catch((e) => e),
		]);

		for (const error of errors) {
			expect(error.message).toContain(
				"The request to the GitHub instance failed",
			);
			expect(error.message).not.toContain("10.0.0.5");
			expect(error.message).not.toContain("secret-banner");
		}
	});
});
