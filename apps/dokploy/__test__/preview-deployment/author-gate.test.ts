import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findGithubById: vi.fn(),
	checkUserRepositoryPermissions: vi.fn(),
	checkGitlabMemberPermissions: vi.fn(),
	checkGitlabMemberPermissionsByUserId: vi.fn(),
	checkGiteaUserRepositoryPermissions: vi.fn(),
	getGithubPullRequests: vi.fn(),
	getGitlabMergeRequests: vi.fn(),
	getGiteaPullRequests: vi.fn(),
}));

// Only the provider helpers the gate uses — keeps the server barrel (and
// its DB/auth imports) out of this test.
vi.mock("@dokploy/server", () => mocks);

import {
	assertPreviewAuthorAllowed,
	type PreviewAuthorGateResource,
	resolveVerifiedPreviewAuthor,
} from "@/server/utils/preview-author-gate";

const GITHUB_RESOURCE: PreviewAuthorGateResource = {
	name: "my-app",
	sourceType: "github",
	previewRequireCollaboratorPermissions: true,
	owner: "dokploy",
	repository: "dokploy",
	githubId: "github-provider-1",
	gitlabId: null,
	gitlabProjectId: null,
	giteaId: null,
	giteaOwner: null,
	giteaRepository: null,
};

const GITLAB_RESOURCE: PreviewAuthorGateResource = {
	name: "my-app",
	sourceType: "gitlab",
	previewRequireCollaboratorPermissions: true,
	owner: null,
	repository: null,
	githubId: null,
	gitlabId: "gitlab-provider-1",
	gitlabProjectId: 42,
	giteaId: null,
	giteaOwner: null,
	giteaRepository: null,
};

const GITEA_RESOURCE: PreviewAuthorGateResource = {
	name: "my-app",
	sourceType: "gitea",
	previewRequireCollaboratorPermissions: true,
	owner: null,
	repository: null,
	githubId: null,
	gitlabId: null,
	gitlabProjectId: null,
	giteaId: "gitea-provider-1",
	giteaOwner: "dokploy",
	giteaRepository: "dokploy",
};

const expectTRPCError = async (promise: Promise<unknown>, code: string) => {
	const error = await promise.then(
		() => null,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(TRPCError);
	expect((error as TRPCError).code).toBe(code);
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	mocks.findGithubById.mockResolvedValue({ githubId: "github-provider-1" });
});

describe("assertPreviewAuthorAllowed - github", () => {
	it("allows an author with write access", async () => {
		mocks.checkUserRepositoryPermissions.mockResolvedValue({
			hasWriteAccess: true,
			permission: "write",
		});

		await expect(
			assertPreviewAuthorAllowed(GITHUB_RESOURCE, {
				pullRequestAuthor: "trusted-dev",
			}),
		).resolves.toBeUndefined();

		expect(mocks.checkUserRepositoryPermissions).toHaveBeenCalledWith(
			{ githubId: "github-provider-1" },
			"dokploy",
			"dokploy",
			"trusted-dev",
		);
	});

	it("blocks an author without write access", async () => {
		mocks.checkUserRepositoryPermissions.mockResolvedValue({
			hasWriteAccess: false,
			permission: "read",
		});

		await expectTRPCError(
			assertPreviewAuthorAllowed(GITHUB_RESOURCE, {
				pullRequestAuthor: "drive-by",
			}),
			"FORBIDDEN",
		);
	});

	it("blocks when the author is missing entirely", async () => {
		await expectTRPCError(
			assertPreviewAuthorAllowed(GITHUB_RESOURCE, {}),
			"BAD_REQUEST",
		);
		expect(mocks.checkUserRepositoryPermissions).not.toHaveBeenCalled();
	});

	it("fails closed when the permission lookup throws", async () => {
		mocks.checkUserRepositoryPermissions.mockRejectedValue(
			new Error("GitHub API is down"),
		);

		await expectTRPCError(
			assertPreviewAuthorAllowed(GITHUB_RESOURCE, {
				pullRequestAuthor: "trusted-dev",
			}),
			"FORBIDDEN",
		);
	});

	it("skips the check when previewRequireCollaboratorPermissions is false", async () => {
		await expect(
			assertPreviewAuthorAllowed(
				{ ...GITHUB_RESOURCE, previewRequireCollaboratorPermissions: false },
				{},
			),
		).resolves.toBeUndefined();

		expect(mocks.checkUserRepositoryPermissions).not.toHaveBeenCalled();
	});

	it("still enforces the check when the flag is null (column default)", async () => {
		mocks.checkUserRepositoryPermissions.mockResolvedValue({
			hasWriteAccess: false,
			permission: null,
		});

		await expectTRPCError(
			assertPreviewAuthorAllowed(
				{ ...GITHUB_RESOURCE, previewRequireCollaboratorPermissions: null },
				{ pullRequestAuthor: "drive-by" },
			),
			"FORBIDDEN",
		);
		expect(mocks.checkUserRepositoryPermissions).toHaveBeenCalled();
	});
});

describe("assertPreviewAuthorAllowed - gitlab", () => {
	it("authorizes by numeric author id, like the merge request webhook", async () => {
		mocks.checkGitlabMemberPermissionsByUserId.mockResolvedValue({
			hasWriteAccess: true,
			accessLevel: 30,
		});

		await expect(
			assertPreviewAuthorAllowed(GITLAB_RESOURCE, {
				pullRequestAuthor: "trusted-dev",
				pullRequestAuthorId: 7,
			}),
		).resolves.toBeUndefined();

		expect(mocks.checkGitlabMemberPermissionsByUserId).toHaveBeenCalledWith(
			"gitlab-provider-1",
			42,
			7,
		);
		expect(mocks.checkGitlabMemberPermissions).not.toHaveBeenCalled();
	});

	it("blocks an author below Developer access", async () => {
		mocks.checkGitlabMemberPermissionsByUserId.mockResolvedValue({
			hasWriteAccess: false,
			accessLevel: 20,
		});

		await expectTRPCError(
			assertPreviewAuthorAllowed(GITLAB_RESOURCE, {
				pullRequestAuthorId: 7,
			}),
			"FORBIDDEN",
		);
	});

	it("falls back to the username lookup when no author id is supplied", async () => {
		mocks.checkGitlabMemberPermissions.mockResolvedValue({
			hasWriteAccess: true,
			accessLevel: 40,
		});

		await expect(
			assertPreviewAuthorAllowed(GITLAB_RESOURCE, {
				pullRequestAuthor: "trusted-dev",
			}),
		).resolves.toBeUndefined();

		expect(mocks.checkGitlabMemberPermissions).toHaveBeenCalledWith(
			"gitlab-provider-1",
			42,
			"trusted-dev",
		);
	});

	it("blocks when neither author id nor username is supplied", async () => {
		await expectTRPCError(
			assertPreviewAuthorAllowed(GITLAB_RESOURCE, {}),
			"BAD_REQUEST",
		);
		expect(mocks.checkGitlabMemberPermissionsByUserId).not.toHaveBeenCalled();
		expect(mocks.checkGitlabMemberPermissions).not.toHaveBeenCalled();
	});

	it("fails closed when the member lookup throws", async () => {
		mocks.checkGitlabMemberPermissionsByUserId.mockRejectedValue(
			new Error("401 Unauthorized"),
		);

		await expectTRPCError(
			assertPreviewAuthorAllowed(GITLAB_RESOURCE, { pullRequestAuthorId: 7 }),
			"FORBIDDEN",
		);
	});

	it("skips the check when previewRequireCollaboratorPermissions is false", async () => {
		await expect(
			assertPreviewAuthorAllowed(
				{ ...GITLAB_RESOURCE, previewRequireCollaboratorPermissions: false },
				{},
			),
		).resolves.toBeUndefined();

		expect(mocks.checkGitlabMemberPermissionsByUserId).not.toHaveBeenCalled();
	});
});

describe("assertPreviewAuthorAllowed - gitea", () => {
	it("allows an author with write access", async () => {
		mocks.checkGiteaUserRepositoryPermissions.mockResolvedValue({
			hasWriteAccess: true,
			permission: "write",
			verified: true,
		});

		await expect(
			assertPreviewAuthorAllowed(GITEA_RESOURCE, {
				pullRequestAuthor: "trusted-dev",
			}),
		).resolves.toBeUndefined();

		expect(mocks.checkGiteaUserRepositoryPermissions).toHaveBeenCalledWith(
			"gitea-provider-1",
			"dokploy",
			"dokploy",
			"trusted-dev",
		);
	});

	it("blocks an author without write access", async () => {
		mocks.checkGiteaUserRepositoryPermissions.mockResolvedValue({
			hasWriteAccess: false,
			permission: "read",
			verified: true,
		});

		await expectTRPCError(
			assertPreviewAuthorAllowed(GITEA_RESOURCE, {
				pullRequestAuthor: "drive-by",
			}),
			"FORBIDDEN",
		);
	});

	it("blocks when Gitea refuses to answer the permission lookup", async () => {
		mocks.checkGiteaUserRepositoryPermissions.mockResolvedValue({
			hasWriteAccess: false,
			permission: null,
			verified: false,
		});

		await expectTRPCError(
			assertPreviewAuthorAllowed(GITEA_RESOURCE, {
				pullRequestAuthor: "trusted-dev",
			}),
			"FORBIDDEN",
		);
	});

	it("short circuits for the repository owner", async () => {
		await expect(
			assertPreviewAuthorAllowed(GITEA_RESOURCE, {
				pullRequestAuthor: "DokPloy",
			}),
		).resolves.toBeUndefined();

		expect(mocks.checkGiteaUserRepositoryPermissions).not.toHaveBeenCalled();
	});

	it("blocks when the author is missing entirely", async () => {
		await expectTRPCError(
			assertPreviewAuthorAllowed(GITEA_RESOURCE, {}),
			"BAD_REQUEST",
		);
		expect(mocks.checkGiteaUserRepositoryPermissions).not.toHaveBeenCalled();
	});

	it("blocks when the provider is not fully configured", async () => {
		await expectTRPCError(
			assertPreviewAuthorAllowed(
				{ ...GITEA_RESOURCE, giteaRepository: null },
				{ pullRequestAuthor: "trusted-dev" },
			),
			"BAD_REQUEST",
		);
		expect(mocks.checkGiteaUserRepositoryPermissions).not.toHaveBeenCalled();
	});

	it("fails closed when the permission lookup throws", async () => {
		mocks.checkGiteaUserRepositoryPermissions.mockRejectedValue(
			new Error("Gitea API is down"),
		);

		await expectTRPCError(
			assertPreviewAuthorAllowed(GITEA_RESOURCE, {
				pullRequestAuthor: "trusted-dev",
			}),
			"FORBIDDEN",
		);
	});

	it("skips the check when previewRequireCollaboratorPermissions is false", async () => {
		await expect(
			assertPreviewAuthorAllowed(
				{ ...GITEA_RESOURCE, previewRequireCollaboratorPermissions: false },
				{},
			),
		).resolves.toBeUndefined();

		expect(mocks.checkGiteaUserRepositoryPermissions).not.toHaveBeenCalled();
	});
});

describe("resolveVerifiedPreviewAuthor", () => {
	const changeRequest = (overrides: Record<string, unknown> = {}) => ({
		id: 9001,
		number: 7,
		title: "Add a thing",
		url: "https://example.com/pull/7",
		branch: "feature/thing",
		baseBranch: "main",
		draft: false,
		authorUsername: "drive-by",
		authorId: null,
		...overrides,
	});

	const request = (overrides: Record<string, unknown> = {}) => ({
		branch: "feature/thing",
		pullRequestId: "9001",
		pullRequestNumber: "7",
		pullRequestAuthor: "trusted-dev",
		...overrides,
	});

	// Only `trusted-dev` has write access, like a real repository.
	const permissionsByLogin = async (
		_provider: unknown,
		_owner: string,
		_repo: string,
		login: string,
	) => ({
		hasWriteAccess: login === "trusted-dev",
		permission: login === "trusted-dev" ? "write" : "read",
	});

	// The router's sequence: verify the author, then authorize the verified input.
	const gate = async (
		resource: PreviewAuthorGateResource,
		input: ReturnType<typeof request>,
	) =>
		assertPreviewAuthorAllowed(
			resource,
			await resolveVerifiedPreviewAuthor(resource, input),
		);

	beforeEach(() => {
		mocks.checkUserRepositoryPermissions.mockImplementation(permissionsByLogin);
	});

	it("rejects a client-claimed collaborator author on a non-collaborator's pull request", async () => {
		mocks.getGithubPullRequests.mockResolvedValue([changeRequest()]);

		await expectTRPCError(gate(GITHUB_RESOURCE, request()), "FORBIDDEN");

		// The gate authorized the provider's author, never the claimed one.
		expect(mocks.checkUserRepositoryPermissions).toHaveBeenCalledTimes(1);
		expect(mocks.checkUserRepositoryPermissions).toHaveBeenCalledWith(
			expect.anything(),
			"dokploy",
			"dokploy",
			"drive-by",
		);
	});

	it("allows a real collaborator's pull request and returns the provider's identity", async () => {
		mocks.getGithubPullRequests.mockResolvedValue([
			changeRequest({ authorUsername: "trusted-dev", branch: "real-branch" }),
		]);

		await expect(
			gate(GITHUB_RESOURCE, request({ pullRequestAuthor: "someone-else" })),
		).resolves.toBeUndefined();

		const verified = await resolveVerifiedPreviewAuthor(
			GITHUB_RESOURCE,
			request({ pullRequestAuthor: "someone-else" }),
		);
		expect(verified.pullRequestAuthor).toBe("trusted-dev");
		expect(verified.branch).toBe("real-branch");
		expect(mocks.getGithubPullRequests).toHaveBeenCalledWith({
			githubId: "github-provider-1",
			owner: "dokploy",
			repo: "dokploy",
		});
	});

	it("rejects an unknown or closed pull request number", async () => {
		mocks.getGithubPullRequests.mockResolvedValue([
			changeRequest({ number: 8, id: 9002 }),
		]);

		await expectTRPCError(gate(GITHUB_RESOURCE, request()), "BAD_REQUEST");
		expect(mocks.checkUserRepositoryPermissions).not.toHaveBeenCalled();
	});

	it("rejects a pull request id that does not belong to the number", async () => {
		mocks.getGithubPullRequests.mockResolvedValue([changeRequest()]);

		await expectTRPCError(
			gate(GITHUB_RESOURCE, request({ pullRequestId: "1" })),
			"BAD_REQUEST",
		);
	});

	it("fails closed when the pull request lookup throws", async () => {
		mocks.getGithubPullRequests.mockRejectedValue(new Error("GitHub is down"));

		await expectTRPCError(gate(GITHUB_RESOURCE, request()), "FORBIDDEN");
	});

	it("does not look anything up when previewRequireCollaboratorPermissions is false", async () => {
		const resource = {
			...GITHUB_RESOURCE,
			previewRequireCollaboratorPermissions: false,
		};
		const input = request();

		await expect(resolveVerifiedPreviewAuthor(resource, input)).resolves.toBe(
			input,
		);
		expect(mocks.getGithubPullRequests).not.toHaveBeenCalled();
	});

	it("takes the GitLab author id from the merge request, using the project id", async () => {
		mocks.getGitlabMergeRequests.mockResolvedValue([
			changeRequest({ authorUsername: "mr-author", authorId: 555 }),
		]);
		mocks.checkGitlabMemberPermissionsByUserId.mockResolvedValue({
			hasWriteAccess: false,
			accessLevel: 10,
		});

		await expectTRPCError(
			gate(
				GITLAB_RESOURCE,
				request({ pullRequestAuthor: "maintainer", pullRequestAuthorId: 1 }),
			),
			"FORBIDDEN",
		);

		expect(mocks.getGitlabMergeRequests).toHaveBeenCalledWith({
			gitlabId: "gitlab-provider-1",
			id: 42,
			owner: "",
			repo: "",
		});
		expect(mocks.checkGitlabMemberPermissionsByUserId).toHaveBeenCalledWith(
			"gitlab-provider-1",
			42,
			555,
		);
	});

	it("verifies Gitea pull requests the same way", async () => {
		mocks.getGiteaPullRequests.mockResolvedValue([changeRequest()]);
		mocks.checkGiteaUserRepositoryPermissions.mockResolvedValue({
			hasWriteAccess: false,
			permission: "read",
			verified: true,
		});

		await expectTRPCError(gate(GITEA_RESOURCE, request()), "FORBIDDEN");
		expect(mocks.checkGiteaUserRepositoryPermissions).toHaveBeenCalledWith(
			"gitea-provider-1",
			"dokploy",
			"dokploy",
			"drive-by",
		);
	});
});
