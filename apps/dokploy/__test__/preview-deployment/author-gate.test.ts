import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findGithubById: vi.fn(),
	checkUserRepositoryPermissions: vi.fn(),
	checkGitlabMemberPermissions: vi.fn(),
	checkGitlabMemberPermissionsByUserId: vi.fn(),
}));

// Only the four provider helpers the gate uses — keeps the server barrel (and
// its DB/auth imports) out of this test.
vi.mock("@dokploy/server", () => mocks);

import {
	assertPreviewAuthorAllowed,
	type PreviewAuthorGateResource,
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
