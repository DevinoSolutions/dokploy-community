import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// An application PR preview whose row still holds a git provider of another
// organization is refused before the first PR comment: posting "running" (or
// "error") would use that foreign token (T-6902). The check itself is covered
// in deploy-references.test.ts; here it is refused on purpose.
vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			applications: {
				findFirst: vi.fn(),
			},
		},
	},
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeployment: vi.fn(),
	createDeploymentPreview: vi.fn(),
	getDeploymentErrorMessage: vi.fn(),
	updateDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
}));

vi.mock("@dokploy/server/services/domain", () => ({
	getDomainHost: vi.fn(() => "https://preview.example.com"),
}));

vi.mock("@dokploy/server/services/github", () => ({
	getIssueComment: vi.fn(() => "comment"),
}));

vi.mock("@dokploy/server/services/preview-comment", () => ({
	ensurePreviewComment: vi.fn(async () => ({ created: false, commentId: "1" })),
	getPreviewCommentContext: vi.fn(() => ({
		provider: "github",
		providerId: "gh-foreign",
		owner: "me",
		repository: "repo",
	})),
	updatePreviewComment: vi.fn(),
}));

vi.mock("@dokploy/server/services/preview-deployment", () => ({
	findPreviewDeploymentById: vi.fn(),
	updatePreviewDeployment: vi.fn(),
}));

vi.mock("@dokploy/server/utils/builders", () => ({
	getBuildCommand: vi.fn(),
	mechanizeDockerContainer: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	ExecError: class ExecError extends Error {},
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/providers/github", () => ({
	checkUserRepositoryPermissions: vi.fn(),
	cloneGithubRepository: vi.fn(),
}));

vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: vi.fn(),
}));

import { db } from "@dokploy/server/db";
import {
	deployPreviewApplication,
	rebuildPreviewApplication,
} from "@dokploy/server/services/application";
import * as deploymentService from "@dokploy/server/services/deployment";
import * as previewComment from "@dokploy/server/services/preview-comment";
import * as previewService from "@dokploy/server/services/preview-deployment";
import { assertDeployReferencesInOrganization } from "@dokploy/server/services/service-reference-scope";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import * as githubProvider from "@dokploy/server/utils/providers/github";

const REFUSAL =
	"Deployment refused: the GitHub provider set on this service does not belong to its organization.";

const application = {
	applicationId: "application-id",
	name: "Application",
	appName: "base-app",
	sourceType: "github" as const,
	githubId: "gh-foreign",
	owner: "me",
	repository: "repo",
	serverId: null,
	buildServerId: null,
	previewEnv: "",
	previewBuildArgs: "",
	previewBuildSecrets: "",
	buildRegistry: null,
	rollbackRegistry: null,
	registry: null,
	environment: { project: { organizationId: "org-1" } },
};

const previewDeployment = {
	previewDeploymentId: "preview-id",
	appName: "preview-app",
	branch: "feature",
	pullRequestId: "pr-1",
	pullRequestNumber: "42",
	pullRequestCommentId: "",
	domain: { host: "preview.example.com" },
};

describe.each([
	["deployPreviewApplication", deployPreviewApplication],
	["rebuildPreviewApplication", rebuildPreviewApplication],
])("%s with a stored provider of another organization", (_name, run) => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(db.query.applications.findFirst).mockResolvedValue(
			structuredClone(application) as never,
		);
		vi.mocked(previewService.findPreviewDeploymentById).mockResolvedValue(
			structuredClone(previewDeployment) as never,
		);
		vi.mocked(deploymentService.createDeploymentPreview).mockResolvedValue({
			deploymentId: "deployment-id",
			logPath: "/tmp/preview.log",
		} as never);
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as never);
		vi.mocked(previewComment.ensurePreviewComment).mockResolvedValue({
			created: false,
			commentId: "1",
		} as never);
		vi.mocked(assertDeployReferencesInOrganization).mockResolvedValue(
			undefined,
		);
	});

	const go = () =>
		run({
			applicationId: "application-id",
			previewDeploymentId: "preview-id",
			titleLog: "Preview Deployment",
			descriptionLog: "",
		});

	it("posts no PR comment at all, not even the failure one, and clones nothing", async () => {
		vi.mocked(assertDeployReferencesInOrganization).mockRejectedValue(
			new TRPCError({ code: "FORBIDDEN", message: REFUSAL }),
		);

		await expect(go()).rejects.toThrow(REFUSAL);

		expect(assertDeployReferencesInOrganization).toHaveBeenCalledWith(
			expect.objectContaining({ applicationId: "application-id" }),
		);
		expect(previewComment.ensurePreviewComment).not.toHaveBeenCalled();
		expect(previewComment.updatePreviewComment).not.toHaveBeenCalled();
		expect(githubProvider.cloneGithubRepository).not.toHaveBeenCalled();
		expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-id",
			"error",
		);
		expect(previewService.updatePreviewDeployment).toHaveBeenCalledWith(
			"preview-id",
			{ previewStatus: "error" },
		);
	});

	it("still posts the running comment when the references are fine", async () => {
		await go().catch(() => undefined);

		expect(previewComment.ensurePreviewComment).toHaveBeenCalled();
	});
});
