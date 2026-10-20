import * as adminService from "@dokploy/server/services/admin";
import * as applicationService from "@dokploy/server/services/application";
import {
	deployApplication,
	deployPreviewApplication,
	rebuildApplication,
	rebuildPreviewApplication,
} from "@dokploy/server/services/application";
import * as deploymentService from "@dokploy/server/services/deployment";
import * as previewDeploymentService from "@dokploy/server/services/preview-deployment";
import * as builders from "@dokploy/server/utils/builders";
import * as notifications from "@dokploy/server/utils/notifications/build-success";
import * as staging from "@dokploy/server/utils/docker/staging";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import * as gitProvider from "@dokploy/server/utils/providers/git";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/db", () => {
	const createChainableMock = (): any => {
		const chain = {
			set: vi.fn(() => chain),
			where: vi.fn(() => chain),
			returning: vi.fn().mockResolvedValue([{}] as any),
			from: vi.fn(() => chain),
			innerJoin: vi.fn(() => chain),
			then: (resolve: (v: any) => void) => {
				resolve([]);
			},
		} as any;
		return chain;
	};

	return {
		db: {
			select: vi.fn(() => createChainableMock()),
			insert: vi.fn(),
			update: vi.fn(() => createChainableMock()),
			delete: vi.fn(),
			query: {
				// build-policy: the deploy path resolves org policy settings first.
				// No row means the policy is off, which is the default.
				buildPolicySettings: {
					findFirst: vi.fn().mockResolvedValue(undefined),
				},
				applications: {
					findFirst: vi.fn(),
				},
				deployHook: {
					findFirst: vi.fn(),
				},
				domains: {
					findMany: vi.fn().mockResolvedValue([]),
				},
				patch: {
					findMany: vi.fn().mockResolvedValue([]),
				},
				member: {
					findMany: vi.fn().mockResolvedValue([]),
				},
			},
		},
	};
});

vi.mock("@dokploy/server/services/application", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/application")
	>("@dokploy/server/services/application");
	return {
		...actual,
		findApplicationById: vi.fn(),
		updateApplicationStatus: vi.fn(),
	};
});

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: vi.fn(),
}));

vi.mock("@dokploy/server/services/preview-deployment", () => ({
	findPreviewDeploymentById: vi.fn(),
	updatePreviewDeployment: vi.fn(),
}));

vi.mock("@dokploy/server/services/preview-comment", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/preview-comment")
	>("@dokploy/server/services/preview-comment");
	return { ...actual, upsertPreviewComment: vi.fn() };
});

vi.mock("@dokploy/server/utils/providers/github", () => ({
	cloneGithubRepository: vi.fn().mockResolvedValue("git clone;"),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeploymentPreview: vi.fn(),
	createDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updateDeployment: vi.fn(),
}));

vi.mock("@dokploy/server/utils/providers/git", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/providers/git")
	>("@dokploy/server/utils/providers/git");
	return {
		...actual,
		getGitCommitInfo: vi.fn(),
	};
});

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	ExecError: class ExecError extends Error {},
}));

vi.mock("@dokploy/server/utils/docker/staging", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/docker/staging")
	>("@dokploy/server/utils/docker/staging");
	return {
		...actual,
		removeStagedFiles: vi.fn().mockResolvedValue(undefined),
	};
});

vi.mock("@dokploy/server/utils/builders", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/builders")
	>("@dokploy/server/utils/builders");
	return {
		...actual,
		mechanizeDockerContainer: vi.fn(),
		getBuildCommand: vi.fn(),
	};
});

vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/services/rollbacks", () => ({
	createRollback: vi.fn(),
}));

// deployApplication now verifies post-deploy service stability by polling
// Docker Swarm for a 60s window (waitForSwarmServiceStable). These are
// command-generation tests with no real Docker service running, so stub it
// to report a stable service; keep the rest of docker/utils real.
vi.mock("@dokploy/server/utils/docker/utils", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/docker/utils")
	>("@dokploy/server/utils/docker/utils");
	return {
		...actual,
		waitForSwarmServiceStable: vi.fn().mockResolvedValue({ stable: true }),
	};
});

import { db } from "@dokploy/server/db";
import { cloneGitRepository } from "@dokploy/server/utils/providers/git";

const createMockApplication = (overrides = {}) => ({
	applicationId: "test-app-id",
	name: "Test App",
	appName: "test-app",
	sourceType: "git" as const,
	customGitUrl: "https://github.com/Dokploy/examples.git",
	customGitBranch: "main",
	customGitSSHKeyId: null,
	buildType: "nixpacks" as const,
	buildPath: "/astro",
	env: "NODE_ENV=production",
	serverId: null,
	rollbackActive: false,
	enableSubmodules: false,
	environmentId: "env-id",
	environment: {
		projectId: "project-id",
		env: "",
		name: "production",
		project: {
			name: "Test Project",
			organizationId: "org-id",
			env: "",
		},
	},
	domains: [],
	...overrides,
});

const createMockDeployment = () => ({
	deploymentId: "deployment-id",
	logPath: "/tmp/test-deployment.log",
});

describe("deployApplication - Command Generation Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(db.query.applications.findFirst).mockResolvedValue(
			createMockApplication() as any,
		);
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			createMockApplication() as any,
		);
		vi.mocked(adminService.getDokployUrl).mockResolvedValue(
			"http://localhost:3000",
		);
		vi.mocked(deploymentService.createDeployment).mockResolvedValue(
			createMockDeployment() as any,
		);
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);
		vi.mocked(builders.mechanizeDockerContainer).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(deploymentService.updateDeploymentStatus).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(applicationService.updateApplicationStatus).mockResolvedValue(
			{} as any,
		);
		vi.mocked(notifications.sendBuildSuccessNotifications).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(gitProvider.getGitCommitInfo).mockResolvedValue({
			message: "test commit",
			hash: "abc123",
		});
		vi.mocked(deploymentService.updateDeployment).mockResolvedValue({} as any);
	});

	it("should generate correct git clone command for astro example", async () => {
		const app = createMockApplication();
		const command = await cloneGitRepository(app);
		console.log(command);

		expect(command).toContain("https://github.com/Dokploy/examples.git");
		expect(command).not.toContain("--recurse-submodules");
		expect(command).toContain("--branch main");
		expect(command).toContain("--depth 1");
		expect(command).toContain("git clone");
	});

	it("should generate git clone with submodules when enabled", async () => {
		const app = createMockApplication({ enableSubmodules: true });
		const command = await cloneGitRepository(app);

		expect(command).toContain("--recurse-submodules");
		expect(command).toContain("https://github.com/Dokploy/examples.git");
	});

	it("should verify nixpacks command is called with correct app", async () => {
		const mockNixpacksCommand = "nixpacks build /path/to/app --name test-app";
		vi.mocked(builders.getBuildCommand).mockResolvedValue(mockNixpacksCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test deployment",
			descriptionLog: "",
		});

		expect(builders.getBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				buildType: "nixpacks",
				customGitUrl: "https://github.com/Dokploy/examples.git",
				buildPath: "/astro",
			}),
			null,
			{ deploymentId: "deployment-id", onStaged: expect.any(Function) },
		);

		expect(execProcess.execAsync).toHaveBeenCalledWith(
			expect.stringContaining("nixpacks build"),
		);
	});

	it("should verify railpack command includes correct parameters", async () => {
		const mockApp = createMockApplication({ buildType: "railpack" });
		vi.mocked(db.query.applications.findFirst).mockResolvedValue(
			mockApp as any,
		);
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			mockApp as any,
		);

		const mockRailpackCommand = "railpack prepare /path/to/app";
		vi.mocked(builders.getBuildCommand).mockResolvedValue(mockRailpackCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Railpack test",
			descriptionLog: "",
		});

		expect(builders.getBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				buildType: "railpack",
			}),
			null,
			{ deploymentId: "deployment-id", onStaged: expect.any(Function) },
		);

		expect(execProcess.execAsync).toHaveBeenCalledWith(
			expect.stringContaining("railpack prepare"),
		);
	});

	it("should execute commands in correct order", async () => {
		const mockNixpacksCommand = "nixpacks build";
		vi.mocked(builders.getBuildCommand).mockResolvedValue(mockNixpacksCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test",
			descriptionLog: "",
		});

		const execCalls = vi.mocked(execProcess.execAsync).mock.calls;
		expect(execCalls.length).toBeGreaterThan(0);

		const fullCommand = execCalls[0]?.[0];
		expect(fullCommand).toContain("set -e");
		expect(fullCommand).toContain("git clone");
		expect(fullCommand).toContain("nixpacks build");
	});

	it("should include log redirection in command", async () => {
		const mockCommand = "nixpacks build";
		vi.mocked(builders.getBuildCommand).mockResolvedValue(mockCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test",
			descriptionLog: "",
		});

		const execCalls = vi.mocked(execProcess.execAsync).mock.calls;
		const fullCommand = execCalls[0]?.[0];

		expect(fullCommand).toContain(">> /tmp/test-deployment.log 2>&1");
	});

	it("removes the staged build files when the script fails before the build", async () => {
		vi.mocked(builders.getBuildCommand).mockImplementation(
			async (_application, _serverId, options) => {
				options?.onStaged?.(["/apps/test-app/.dokploy-stage-build-env-one"]);
				return "nixpacks build";
			},
		);
		// The clone, patch or build step fails under `set -e`.
		vi.mocked(execProcess.execAsync).mockRejectedValueOnce(
			new Error("clone failed"),
		);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test",
			descriptionLog: "",
		}).catch(() => undefined);

		expect(staging.removeStagedFiles).toHaveBeenCalledWith(null, [
			"/apps/test-app/.dokploy-stage-build-env-one",
		]);
	});

	it("removes them on the build server the files were staged on", async () => {
		const app = createMockApplication({ buildServerId: "build-1" });
		vi.mocked(db.query.applications.findFirst).mockResolvedValue(app as any);
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			app as any,
		);
		vi.mocked(builders.getBuildCommand).mockImplementation(
			async (_application, _serverId, options) => {
				options?.onStaged?.(["/etc/dokploy/applications/a/.dokploy-stage-x"]);
				return "nixpacks build";
			},
		);
		vi.mocked(execProcess.execAsyncRemote).mockRejectedValue(
			new Error("ssh dropped"),
		);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test",
			descriptionLog: "",
		}).catch(() => undefined);

		expect(builders.getBuildCommand).toHaveBeenCalledWith(
			expect.anything(),
			"build-1",
			expect.anything(),
		);
		expect(staging.removeStagedFiles).toHaveBeenCalledWith("build-1", [
			"/etc/dokploy/applications/a/.dokploy-stage-x",
		]);
	});
});

describe("staged build file cleanup on every deploy path", () => {
	const stagedPath = "/apps/test-app/.dokploy-stage-build-env-one";
	const previewDeployment = {
		previewDeploymentId: "preview-id",
		appName: "test-app-preview",
		branch: "feature",
		pullRequestId: "7",
		pullRequestNumber: "7",
		domain: { host: "pr-7.example.com" },
	};

	// The build command stages a file, then the deploy fails before the script runs.
	const stageThenFail = () => {
		vi.mocked(builders.getBuildCommand).mockImplementation(
			async (_application, _serverId, options) => {
				options?.onStaged?.([stagedPath]);
				throw new Error("build failed");
			},
		);
	};

	const useApplication = (overrides = {}) => {
		const app = createMockApplication({ sourceType: "github", ...overrides });
		vi.mocked(db.query.applications.findFirst).mockResolvedValue(app as any);
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			app as any,
		);
	};

	const runners = {
		rebuildApplication: () =>
			rebuildApplication({
				applicationId: "test-app-id",
				titleLog: "Rebuild",
				descriptionLog: "",
			}),
		deployPreviewApplication: () =>
			deployPreviewApplication({
				applicationId: "test-app-id",
				titleLog: "Preview",
				descriptionLog: "",
				previewDeploymentId: "preview-id",
			}),
		rebuildPreviewApplication: () =>
			rebuildPreviewApplication({
				applicationId: "test-app-id",
				titleLog: "Rebuild preview",
				descriptionLog: "",
				previewDeploymentId: "preview-id",
			}),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		useApplication();
		vi.mocked(adminService.getDokployUrl).mockResolvedValue(
			"http://localhost:3000",
		);
		for (const create of [
			deploymentService.createDeployment,
			deploymentService.createDeploymentPreview,
		]) {
			vi.mocked(create).mockResolvedValue(createMockDeployment() as any);
		}
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);
		vi.mocked(execProcess.execAsyncRemote).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);
		vi.mocked(deploymentService.updateDeploymentStatus).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(deploymentService.updateDeployment).mockResolvedValue({} as any);
		vi.mocked(applicationService.updateApplicationStatus).mockResolvedValue(
			{} as any,
		);
		vi.mocked(
			previewDeploymentService.findPreviewDeploymentById,
		).mockResolvedValue(previewDeployment as any);
		vi.mocked(
			previewDeploymentService.updatePreviewDeployment,
		).mockResolvedValue({} as any);
		vi.mocked(gitProvider.getGitCommitInfo).mockResolvedValue(null as any);
		vi.mocked(staging.removeStagedFiles).mockResolvedValue(undefined);
	});

	it.each(Object.entries(runners))(
		"%s removes the staged files on the local host",
		async (_name, run) => {
			stageThenFail();

			await run().catch(() => undefined);

			expect(staging.removeStagedFiles).toHaveBeenCalledWith(null, [
				stagedPath,
			]);
		},
	);

	it.each(Object.entries(runners))(
		"%s removes them on the build server the files were staged on",
		async (_name, run) => {
			useApplication({ buildServerId: "build-1" });
			stageThenFail();

			await run().catch(() => undefined);

			expect(builders.getBuildCommand).toHaveBeenCalledWith(
				expect.anything(),
				"build-1",
				expect.anything(),
			);
			expect(staging.removeStagedFiles).toHaveBeenCalledWith("build-1", [
				stagedPath,
			]);
		},
	);

	it.each([
		["deployApplication", () =>
			deployApplication({
				applicationId: "test-app-id",
				titleLog: "Deploy",
				descriptionLog: "",
			})],
		...Object.entries(runners),
	])(
		"%s marks the deployment failed without waiting for the removal",
		async (_name, run) => {
			useApplication({ buildServerId: "build-1" });
			stageThenFail();
			// An unreachable build server: the removal never settles.
			vi.mocked(staging.removeStagedFiles).mockReturnValue(
				new Promise(() => {}),
			);

			await run().catch(() => undefined);

			expect(staging.removeStagedFiles).toHaveBeenCalled();
			expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
				"deployment-id",
				"error",
			);
		},
	);
});
