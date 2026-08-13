import * as builders from "@dokploy/server/utils/builders";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import * as githubProvider from "@dokploy/server/utils/providers/github";
import * as gitlabProvider from "@dokploy/server/utils/providers/gitlab";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
	createPreviewDeploymentComment: vi.fn(),
	getIssueComment: vi.fn(),
	issueCommentExists: vi.fn(),
	updateIssueComment: vi.fn(),
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
	cloneGithubRepository: vi.fn(),
}));

vi.mock("@dokploy/server/utils/providers/gitlab", () => ({
	cloneGitlabRepository: vi.fn(),
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
import * as githubService from "@dokploy/server/services/github";
import * as previewService from "@dokploy/server/services/preview-deployment";

const application = {
	applicationId: "application-id",
	name: "Application",
	appName: "base-app",
	sourceType: "gitlab" as const,
	gitlabId: "gitlab-id",
	gitlabBranch: "main",
	gitlabPathNamespace: "group/repository",
	enableSubmodules: false,
	serverId: null,
	buildServerId: null,
	previewEnv: "NODE_ENV=preview",
	previewBuildArgs: "",
	previewBuildSecrets: "",
	buildRegistry: null,
	rollbackRegistry: null,
	registry: null,
};

const previewDeployment = {
	previewDeploymentId: "preview-id",
	appName: "preview-app",
	branch: "feature/gitlab-preview",
	pullRequestNumber: "42",
	pullRequestCommentId: "",
	domain: {
		host: "preview.example.com",
	},
};

describe("GitLab application previews", () => {
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
		vi.mocked(gitlabProvider.cloneGitlabRepository).mockResolvedValue(
			"clone-gitlab;",
		);
		vi.mocked(builders.getBuildCommand).mockResolvedValue("build-application;");
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as never);
		vi.mocked(builders.mechanizeDockerContainer).mockResolvedValue(
			undefined as never,
		);
	});

	it.each([
		["deploy", deployPreviewApplication],
		["rebuild", rebuildPreviewApplication],
	])(
		"clones the MR branch during %s without calling GitHub",
		async (_, run) => {
			await run({
				applicationId: application.applicationId,
				previewDeploymentId: previewDeployment.previewDeploymentId,
				titleLog: "Preview Deployment",
				descriptionLog: "",
			});

			expect(gitlabProvider.cloneGitlabRepository).toHaveBeenCalledWith(
				expect.objectContaining({
					appName: previewDeployment.appName,
					gitlabBranch: previewDeployment.branch,
				}),
			);
			expect(githubProvider.cloneGithubRepository).not.toHaveBeenCalled();
			expect(githubService.issueCommentExists).not.toHaveBeenCalled();
			expect(githubService.updateIssueComment).not.toHaveBeenCalled();
			expect(execProcess.execAsync).toHaveBeenCalledWith(
				expect.stringContaining("clone-gitlab;build-application;"),
			);
			expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
				"deployment-id",
				"done",
			);
			expect(previewService.updatePreviewDeployment).toHaveBeenCalledWith(
				"preview-id",
				{ previewStatus: "done" },
			);
		},
	);

	it("writes an early GitLab failure to the deployment log", async () => {
		vi.mocked(gitlabProvider.cloneGitlabRepository).mockRejectedValue(
			new Error("GitLab token refresh failed"),
		);

		await expect(
			deployPreviewApplication({
				applicationId: application.applicationId,
				previewDeploymentId: previewDeployment.previewDeploymentId,
				titleLog: "Preview Deployment",
				descriptionLog: "",
			}),
		).rejects.toThrow("GitLab token refresh failed");

		const encodedError = Buffer.from("GitLab token refresh failed").toString(
			"base64",
		);
		expect(execProcess.execAsync).toHaveBeenCalledWith(
			expect.stringContaining(encodedError),
		);
		expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-id",
			"error",
		);
		expect(previewService.updatePreviewDeployment).toHaveBeenCalledWith(
			"preview-id",
			{ previewStatus: "error" },
		);
		expect(githubService.updateIssueComment).not.toHaveBeenCalled();
	});
});
