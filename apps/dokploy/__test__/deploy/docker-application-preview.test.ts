import * as builders from "@dokploy/server/utils/builders";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import * as dockerProvider from "@dokploy/server/utils/providers/docker";
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
	createIssueComment: vi.fn(),
	createSecurityBlockedComment: vi.fn(),
	findGithubById: vi.fn(),
	getIssueComment: vi.fn(),
	getSecurityBlockedMessage: vi.fn(),
	issueCommentExists: vi.fn(),
	SECURITY_BLOCKED_COMMENT_MARKER: "blocked-marker",
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

vi.mock("@dokploy/server/utils/providers/docker", () => ({
	buildRemoteDocker: vi.fn(),
}));

vi.mock("@dokploy/server/utils/providers/github", () => ({
	checkUserRepositoryPermissions: vi.fn(),
	cloneGithubRepository: vi.fn(),
}));

vi.mock("@dokploy/server/utils/providers/gitea", () => ({
	checkGiteaUserRepositoryPermissions: vi.fn(),
	cloneGiteaRepository: vi.fn(),
	createGiteaIssueComment: vi.fn(),
	GITEA_WRITE_PERMISSIONS: ["write", "admin", "owner"],
	giteaIssueCommentExists: vi.fn(),
	listGiteaIssueComments: vi.fn(),
	updateGiteaIssueComment: vi.fn(),
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
import * as previewService from "@dokploy/server/services/preview-deployment";

const application = {
	applicationId: "application-id",
	name: "Application",
	appName: "base-app",
	sourceType: "docker" as const,
	dockerImage: "ghcr.io/acme/app:latest",
	previewDockerImage: "ghcr.io/acme/app:pr-${{preview.prNumber}}",
	registryUrl: null,
	username: null,
	password: null,
	serverId: null,
	buildServerId: null,
	previewEnv: "NODE_ENV=preview",
	previewBuildArgs: "",
	previewBuildSecrets: "",
	buildRegistry: null,
	rollbackRegistry: null,
	registry: { registryId: "registry-id", registryType: "cloud" },
};

const previewDeployment = {
	previewDeploymentId: "preview-id",
	appName: "preview-app",
	branch: "42",
	pullRequestId: "docker-42",
	pullRequestNumber: "42",
	pullRequestCommentId: "",
	domain: {
		host: "preview.example.com",
	},
};

const run = (
	fn: typeof deployPreviewApplication | typeof rebuildPreviewApplication,
) =>
	fn({
		applicationId: application.applicationId,
		previewDeploymentId: previewDeployment.previewDeploymentId,
		titleLog: "Preview Deployment",
		descriptionLog: "",
	});

describe("Docker image application previews", () => {
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
		vi.mocked(dockerProvider.buildRemoteDocker).mockResolvedValue(
			"pull-image;",
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
		"pulls the templated image during %s instead of cloning",
		async (_, fn) => {
			await run(fn);

			expect(dockerProvider.buildRemoteDocker).toHaveBeenCalledTimes(1);
			expect(dockerProvider.buildRemoteDocker).toHaveBeenCalledWith(
				expect.objectContaining({
					dockerImage: "ghcr.io/acme/app:pr-42",
					// The registry stays attached: it carries the pull credentials.
					registry: { registryId: "registry-id", registryType: "cloud" },
				}),
				null,
			);
			expect(githubProvider.cloneGithubRepository).not.toHaveBeenCalled();
			expect(gitlabProvider.cloneGitlabRepository).not.toHaveBeenCalled();
			// Nothing is built, and nothing is re-tagged and pushed to the registry.
			expect(builders.getBuildCommand).not.toHaveBeenCalled();
			expect(execProcess.execAsync).toHaveBeenCalledWith(
				expect.stringContaining("set -e;pull-image;"),
			);
			expect(builders.mechanizeDockerContainer).toHaveBeenCalledWith(
				expect.objectContaining({
					appName: "preview-app",
					dockerImage: "ghcr.io/acme/app:pr-42",
				}),
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

	it.each([
		["deploy", deployPreviewApplication],
		["rebuild", rebuildPreviewApplication],
	])(
		"fails %s with a clear error when no preview image template is set",
		async (_, fn) => {
			vi.mocked(db.query.applications.findFirst).mockResolvedValue({
				...structuredClone(application),
				previewDockerImage: null,
			} as never);

			await expect(run(fn)).rejects.toThrow(
				"Set a preview image template to enable previews for Docker-image apps",
			);

			expect(dockerProvider.buildRemoteDocker).not.toHaveBeenCalled();
			expect(builders.mechanizeDockerContainer).not.toHaveBeenCalled();
			const encodedError = Buffer.from(
				"Set a preview image template to enable previews for Docker-image apps",
			).toString("base64");
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
		},
	);

	it.each([
		["deploy", deployPreviewApplication],
		["rebuild", rebuildPreviewApplication],
	])(
		"refuses to pull a stored template that puts the placeholder in the registry during %s",
		async (_, fn) => {
			vi.mocked(db.query.applications.findFirst).mockResolvedValue({
				...structuredClone(application),
				previewDockerImage: "${{preview.prNumber}}/app:latest",
				registry: { registryId: "registry-id", registryType: "cloud" },
			} as never);
			vi.mocked(previewService.findPreviewDeploymentById).mockResolvedValue({
				...structuredClone(previewDeployment),
				pullRequestNumber: "evil.example.com",
			} as never);

			await expect(run(fn)).rejects.toThrow("Invalid preview image template");

			expect(dockerProvider.buildRemoteDocker).not.toHaveBeenCalled();
			expect(builders.mechanizeDockerContainer).not.toHaveBeenCalled();
			expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
				"deployment-id",
				"error",
			);
		},
	);

	it.each([
		["deploy", deployPreviewApplication],
		["rebuild", rebuildPreviewApplication],
	])(
		"refuses a stored template without a placeholder during %s",
		async (_, fn) => {
			vi.mocked(db.query.applications.findFirst).mockResolvedValue({
				...structuredClone(application),
				previewDockerImage: "ghcr.io/acme/app:latest",
			} as never);

			await expect(run(fn)).rejects.toThrow(
				"every preview would pull the same image",
			);
			expect(dockerProvider.buildRemoteDocker).not.toHaveBeenCalled();
		},
	);

	it.each([
		["deploy", deployPreviewApplication],
		["rebuild", rebuildPreviewApplication],
	])(
		"refuses a pull request preview row when the source is a Docker image during %s",
		async (_, fn) => {
			vi.mocked(previewService.findPreviewDeploymentById).mockResolvedValue({
				...structuredClone(previewDeployment),
				pullRequestId: "1001",
			} as never);

			await expect(run(fn)).rejects.toThrow("created from a pull request");

			expect(dockerProvider.buildRemoteDocker).not.toHaveBeenCalled();
		},
	);

	it.each([
		["deploy", deployPreviewApplication],
		["rebuild", rebuildPreviewApplication],
	])(
		"refuses to clone for a Docker preview row after the source type changed during %s",
		async (_, fn) => {
			vi.mocked(db.query.applications.findFirst).mockResolvedValue({
				...structuredClone(application),
				sourceType: "gitlab",
				registry: null,
			} as never);

			await expect(run(fn)).rejects.toThrow(
				"This preview was created for a Docker-image source; recreate it after changing the source type",
			);

			expect(gitlabProvider.cloneGitlabRepository).not.toHaveBeenCalled();
			expect(dockerProvider.buildRemoteDocker).not.toHaveBeenCalled();
		},
	);

	it("does not use the docker pull path for a git provider preview", async () => {
		vi.mocked(db.query.applications.findFirst).mockResolvedValue({
			...structuredClone(application),
			sourceType: "gitlab",
			registry: null,
		} as never);
		vi.mocked(previewService.findPreviewDeploymentById).mockResolvedValue({
			...structuredClone(previewDeployment),
			pullRequestId: "1001",
		} as never);
		vi.mocked(gitlabProvider.cloneGitlabRepository).mockResolvedValue(
			"clone-gitlab;",
		);

		await run(deployPreviewApplication);

		expect(dockerProvider.buildRemoteDocker).not.toHaveBeenCalled();
		expect(builders.getBuildCommand).toHaveBeenCalled();
	});
});
