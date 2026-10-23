import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Reading a repository with the provider or SSH key stored on a service happens
// outside deploys too: the services list, the source-type fetch, the
// rolling-replace preflight, the collision rewrite (all through cloneCompose)
// and patch editing (ensurePatchRepo). A stored id of another organization is
// refused with FORBIDDEN before anything is cloned (T-6902). The check itself is
// covered in deploy-references.test.ts; here it is refused on purpose.
const mocks = vi.hoisted(() => ({
	cloneGithubRepository: vi.fn(),
	cloneGitRepository: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/providers/github", () => ({
	cloneGithubRepository: mocks.cloneGithubRepository,
}));
vi.mock("@dokploy/server/utils/providers/bitbucket", () => ({
	cloneBitbucketRepository: vi.fn(),
}));
vi.mock("@dokploy/server/utils/providers/gitea", () => ({
	cloneGiteaRepository: vi.fn(),
}));
vi.mock("@dokploy/server/utils/providers/gitlab", () => ({
	cloneGitlabRepository: vi.fn(),
}));
vi.mock("@dokploy/server/utils/providers/git", () => ({
	cloneGitRepository: mocks.cloneGitRepository,
}));
vi.mock("@dokploy/server/utils/providers/raw", () => ({
	getCreateComposeFileCommand: vi.fn(async () => "write-file;"),
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));
vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: mocks.findApplicationById,
}));
vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: mocks.findComposeById,
}));

import { ensurePatchRepo } from "@dokploy/server/services/patch-repo";
import { assertDeployReferencesInOrganization } from "@dokploy/server/services/service-reference-scope";
import { cloneCompose } from "@dokploy/server/utils/docker/domain";

const REFUSAL =
	"Deployment refused: the GitHub provider set on this service does not belong to its organization.";

const compose = {
	composeId: "compose-1",
	appName: "stack",
	sourceType: "github",
	githubId: "gh-foreign",
	serverId: null,
	environment: { project: { organizationId: "org-1" } },
} as never;

const application = {
	applicationId: "app-1",
	appName: "web",
	sourceType: "github",
	githubId: "gh-foreign",
	serverId: null,
	buildServerId: null,
	environment: { project: { organizationId: "org-1" } },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.cloneGithubRepository.mockResolvedValue("clone-github;");
	mocks.cloneGitRepository.mockResolvedValue("clone-git;");
	mocks.findApplicationById.mockResolvedValue(application);
	mocks.findComposeById.mockResolvedValue(compose);
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	vi.mocked(assertDeployReferencesInOrganization).mockResolvedValue(undefined);
});

const refuse = () =>
	vi
		.mocked(assertDeployReferencesInOrganization)
		.mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: REFUSAL }));

describe("cloneCompose", () => {
	it("checks the source credential of the compose before cloning", async () => {
		await expect(cloneCompose(compose)).resolves.toContain("clone-github;");

		// the source scope: registries are irrelevant to reading the repository
		expect(assertDeployReferencesInOrganization).toHaveBeenCalledWith(
			compose,
			"source",
		);
	});

	it("refuses, and clones nothing, when the stored provider is another organization's", async () => {
		refuse();

		await expect(cloneCompose(compose)).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: REFUSAL,
		});
		expect(mocks.cloneGithubRepository).not.toHaveBeenCalled();
		expect(mocks.cloneGitRepository).not.toHaveBeenCalled();
	});
});

describe("ensurePatchRepo", () => {
	it.each([
		["application", application],
		["compose", compose],
	] as const)(
		"refuses a %s whose stored provider is another organization's, before any clone or exec",
		async (type, row) => {
			refuse();
			const id = type === "application" ? "app-1" : "compose-1";
			mocks.findApplicationById.mockResolvedValue(row);
			mocks.findComposeById.mockResolvedValue(row);

			await expect(ensurePatchRepo({ type, id })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(mocks.cloneGithubRepository).not.toHaveBeenCalled();
			expect(mocks.execAsync).not.toHaveBeenCalled();
			expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		},
	);

	it("clones as before when the references are fine", async () => {
		await ensurePatchRepo({ type: "application", id: "app-1" });

		expect(assertDeployReferencesInOrganization).toHaveBeenCalledWith(
			application,
			"source",
		);
		expect(mocks.cloneGithubRepository).toHaveBeenCalledTimes(1);
		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
	});
});
