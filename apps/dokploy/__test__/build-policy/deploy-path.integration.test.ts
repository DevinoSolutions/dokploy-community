import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration test for the build-policy deploy path, and the tripwire for
 * upstream merges (spec §11).
 *
 * It drives the real `deployApplication` with docker, ssh and git mocked at
 * their module boundaries, and the three build-policy modules that touch the
 * database stubbed. The decision, the generated build shell, the digest
 * read-back and the deploy-by-digest handoff are all the real code.
 *
 * If an upstream merge drops one of the hook points documented in
 * packages/server/src/services/build-policy/README.md, these tests fail loudly
 * instead of the policy silently reverting to local builds.
 */

const mocks = vi.hoisted(() => ({
	findBuildPolicySettings: vi.fn(),
	isUnitExcluded: vi.fn(),
	findPendingBreakGlass: vi.fn(),
	consumeBreakGlass: vi.fn(),
	recordBuildPolicyAudit: vi.fn(),
	listCheckRuns: vi.fn(),
	environmentsFindFirst: vi.fn(),
	applicationsFindFirst: vi.fn(),
	buildPolicySettingsFindFirst: vi.fn(),
	deploymentsFindFirst: vi.fn(),
	findPreviewDeploymentById: vi.fn(),
	updatePreviewDeployment: vi.fn(),
	createDeploymentPreview: vi.fn(),
}));

vi.mock("@dokploy/server/services/preview-deployment", () => ({
	findPreviewDeploymentById: mocks.findPreviewDeploymentById,
	updatePreviewDeployment: mocks.updatePreviewDeployment,
}));

vi.mock("@dokploy/server/services/preview-comment", () => ({
	ensurePreviewComment: vi.fn().mockResolvedValue({ created: false }),
	getPreviewCommentContext: vi.fn(() => null),
	updatePreviewComment: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const chain = (): any => {
		const self: any = {
			set: vi.fn(() => self),
			where: vi.fn(() => self),
			values: vi.fn(() => self),
			from: vi.fn(() => self),
			innerJoin: vi.fn(() => self),
			returning: vi.fn().mockResolvedValue([{}]),
			// biome-ignore lint/suspicious/noThenProperty: drizzle's query builder is itself a thenable, so the fake standing in for it must be one too
			then: (resolve: (value: unknown) => void) => resolve([]),
		};
		return self;
	};
	return {
		db: {
			select: vi.fn(() => chain()),
			insert: vi.fn(() => chain()),
			update: vi.fn(() => chain()),
			delete: vi.fn(() => chain()),
			query: {
				applications: { findFirst: mocks.applicationsFindFirst },
				deployHook: { findFirst: vi.fn() },
				patch: { findMany: vi.fn().mockResolvedValue([]) },
				member: { findMany: vi.fn().mockResolvedValue([]) },
				environments: { findFirst: mocks.environmentsFindFirst },
				buildPolicySettings: {
					findFirst: mocks.buildPolicySettingsFindFirst,
				},
				deployments: { findFirst: mocks.deploymentsFindFirst },
			},
		},
	};
});

vi.mock("@dokploy/server/services/build-policy/settings", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/build-policy/settings")
	>("@dokploy/server/services/build-policy/settings");
	return { ...actual, findBuildPolicySettings: mocks.findBuildPolicySettings };
});

vi.mock("@dokploy/server/services/build-policy/exclusions", () => ({
	isUnitExcluded: mocks.isUnitExcluded,
}));

vi.mock("@dokploy/server/services/build-policy/audit", () => ({
	recordBuildPolicyAudit: mocks.recordBuildPolicyAudit,
	findPendingBreakGlass: mocks.findPendingBreakGlass,
	consumeBreakGlass: mocks.consumeBreakGlass,
	grantBreakGlass: vi.fn(),
	listBuildPolicyAudit: vi.fn(),
}));

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

vi.mock("@dokploy/server/services/registry", () => ({
	findRegistryByIdWithCredentials: vi.fn(),
	findRegistryById: vi.fn(),
	findAllRegistryByOrganizationId: vi.fn(),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeploymentPreview: mocks.createDeploymentPreview,
	createDeployment: vi.fn(),
	updateDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	getDeploymentErrorMessage: vi.fn(),
}));

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: vi.fn(),
}));

vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	ExecError: class ExecError extends Error {},
}));

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

vi.mock("@dokploy/server/utils/docker/utils", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/docker/utils")
	>("@dokploy/server/utils/docker/utils");
	return { ...actual, waitForSwarmServiceStable: vi.fn() };
});

vi.mock("@dokploy/server/utils/docker/hooks", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/docker/hooks")
	>("@dokploy/server/utils/docker/hooks");
	return { ...actual, runDeployHook: vi.fn() };
});

vi.mock("@dokploy/server/utils/providers/git", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/providers/git")
	>("@dokploy/server/utils/providers/git");
	return { ...actual, getGitCommitInfo: vi.fn(), cloneGitRepository: vi.fn() };
});

vi.mock("@dokploy/server/utils/providers/github", async () => ({
	authGithub: vi.fn(() => ({
		rest: { checks: { listForRef: mocks.listCheckRuns } },
	})),
	cloneGithubRepository: vi.fn(async () => "echo clone;"),
}));

vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: vi.fn(async () => ""),
}));

import * as adminService from "@dokploy/server/services/admin";
import * as applicationService from "@dokploy/server/services/application";
import {
	deployApplication,
	rebuildApplication,
} from "@dokploy/server/services/application";
import { DIGEST_MARKER } from "@dokploy/server/services/build-policy/image";
import { deployPinnedApplicationImage } from "@dokploy/server/services/build-policy/pinned-deploy";
import { rollbackToDeploymentDigest } from "@dokploy/server/services/build-policy/rollback";
import { clearBuildPolicyEnforcementCache } from "@dokploy/server/services/build-policy/settings";
import {
	buildPolicyDeployGate,
	rejectComposeDeployHookImage,
} from "@dokploy/server/services/build-policy/webhook";
import * as deploymentService from "@dokploy/server/services/deployment";
import * as registryService from "@dokploy/server/services/registry";
import * as builders from "@dokploy/server/utils/builders";
import * as dockerUtils from "@dokploy/server/utils/docker/utils";
import * as buildErrorNotifications from "@dokploy/server/utils/notifications/build-error";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import * as gitProvider from "@dokploy/server/utils/providers/git";

const SHA = "9f1c0b3a5d2e4f6a8b0c1d2e3f4a5b6c7d8e9f01";
const DIGEST = `sha256:${"a".repeat(64)}`;
const REPOSITORY = "ghcr.io/devinosolutions/sendly-web";

const REGISTRY = {
	registryId: "registry-1",
	registryName: "GHCR",
	registryType: "cloud" as const,
	registryUrl: "ghcr.io",
	imagePrefix: "devinosolutions",
	username: "devinosolutions",
	password: "unused-in-test",
	awsAccessKeyId: null,
	awsSecretAccessKey: null,
	awsRegion: null,
	createdAt: "2026-09-01T00:00:00.000Z",
	organizationId: "org-1",
};

const SETTINGS = (overrides: Record<string, unknown> = {}) => ({
	buildPolicySettingsId: "bps-1",
	organizationId: "org-1",
	enforceRemoteBuilds: true,
	defaultBuildServerId: "build-server-1",
	defaultRegistryId: "registry-1",
	requiredChecksTimeoutMinutes: 30,
	createdAt: "2026-09-01T00:00:00.000Z",
	updatedAt: "2026-09-01T00:00:00.000Z",
	...overrides,
});

const APPLICATION = (overrides: Record<string, unknown> = {}) => ({
	applicationId: "app-1",
	name: "Sendly Web",
	appName: "sendly-web",
	sourceType: "github" as const,
	owner: "DevinoSolutions",
	repository: "sendly",
	branch: "main",
	githubId: "github-1",
	customGitUrl: null,
	buildType: "dockerfile" as const,
	buildPath: "/",
	dockerfile: "Dockerfile",
	dockerContextPath: null,
	requiredChecks: [] as string[],
	watchPaths: null,
	env: "",
	serverId: "deploy-server-1",
	buildServerId: null,
	buildRegistryId: null,
	registry: null,
	buildRegistry: null,
	rollbackRegistry: null,
	rollbackActive: false,
	enableSubmodules: false,
	environmentId: "env-1",
	deployHooks: null,
	domains: [],
	environment: {
		projectId: "project-1",
		env: "",
		name: "production",
		project: { name: "Sendly", organizationId: "org-1", env: "" },
	},
	...overrides,
});

const primeMocks = (app: Record<string, unknown> = APPLICATION()) => {
	// `deployApplication` calls `findApplicationById` inside its own module, so
	// the module mock does not intercept it; the db query mock is the real seam.
	mocks.applicationsFindFirst.mockResolvedValue(app);
	vi.mocked(applicationService.findApplicationById).mockResolvedValue(
		app as never,
	);
	vi.mocked(adminService.getDokployUrl).mockResolvedValue(
		"http://localhost:3000",
	);
	vi.mocked(deploymentService.createDeployment).mockResolvedValue({
		deploymentId: "deployment-1",
		logPath: "/var/log/deployment-1.log",
	} as never);
	vi.mocked(deploymentService.updateDeployment).mockResolvedValue({} as never);
	vi.mocked(deploymentService.updateDeploymentStatus).mockResolvedValue(
		{} as never,
	);
	vi.mocked(deploymentService.getDeploymentErrorMessage).mockResolvedValue(
		"error",
	);
	vi.mocked(builders.getBuildCommand).mockResolvedValue("echo build;");
	vi.mocked(builders.mechanizeDockerContainer).mockResolvedValue(
		undefined as never,
	);
	vi.mocked(dockerUtils.waitForSwarmServiceStable).mockResolvedValue({
		stable: true,
	} as never);
	vi.mocked(gitProvider.getGitCommitInfo).mockResolvedValue({
		hash: SHA,
		message: "feat: thing",
	} as never);
	vi.mocked(registryService.findRegistryByIdWithCredentials).mockResolvedValue(
		REGISTRY as never,
	);
	vi.mocked(registryService.findRegistryById).mockResolvedValue(
		REGISTRY as never,
	);
	vi.mocked(registryService.findAllRegistryByOrganizationId).mockResolvedValue([
		REGISTRY,
	] as never);

	// The build shell echoes the digest into the deployment log; the deploy step
	// greps it back off the build server.
	vi.mocked(execProcess.execAsyncRemote).mockImplementation((async (
		_serverId: string,
		command: string,
	) => {
		if (command.includes(DIGEST_MARKER) && command.startsWith("grep")) {
			return {
				stdout: `${DIGEST_MARKER} ${REPOSITORY}:${SHA} ${DIGEST}`,
				stderr: "",
			};
		}
		return { stdout: "", stderr: "" };
	}) as never);
	vi.mocked(execProcess.execAsync).mockResolvedValue({
		stdout: "",
		stderr: "",
	} as never);

	mocks.findBuildPolicySettings.mockResolvedValue(SETTINGS());
	mocks.isUnitExcluded.mockResolvedValue(false);
	mocks.findPendingBreakGlass.mockResolvedValue(null);
	mocks.recordBuildPolicyAudit.mockResolvedValue(null);
	mocks.consumeBreakGlass.mockResolvedValue(undefined);
	mocks.environmentsFindFirst.mockResolvedValue({
		environmentId: "env-1",
		project: { organizationId: "org-1" },
	});
	mocks.deploymentsFindFirst.mockResolvedValue({
		deploymentId: "deployment-9",
		applicationId: "app-1",
		imageTag: `${REPOSITORY}:${SHA}`,
		imageDigest: DIGEST,
	});
	// The cheap "does anybody enforce at all" probe the gate makes first.
	mocks.buildPolicySettingsFindFirst.mockResolvedValue({
		buildPolicySettingsId: "bps-1",
	});
};

/** The shell that was handed to the build host. */
const buildCommand = () => {
	const call = vi
		.mocked(execProcess.execAsyncRemote)
		.mock.calls.find(([, command]) => String(command).includes("echo build;"));
	return String(call?.[1] ?? "");
};

const buildHost = () => {
	const call = vi
		.mocked(execProcess.execAsyncRemote)
		.mock.calls.find(([, command]) => String(command).includes("echo build;"));
	return call?.[0];
};

const deployedApplication = () =>
	vi.mocked(builders.mechanizeDockerContainer).mock.calls[0]?.[0] as
		| Record<string, unknown>
		| undefined;

beforeEach(() => {
	vi.clearAllMocks();
	clearBuildPolicyEnforcementCache();
	primeMocks();
});

describe("enforced remote build for a GitHub-sourced application", () => {
	it("runs the build on the organization build server, not the deploy host", async () => {
		await deployApplication({
			applicationId: "app-1",
			titleLog: "Manual deployment",
			descriptionLog: "",
		});
		expect(buildHost()).toBe("build-server-1");
	});

	it("appends a tag-and-push of <repository>:<sha> to the build command", async () => {
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		const command = buildCommand();
		expect(command).toContain("git -C");
		expect(command).toContain("rev-parse HEAD");
		expect(command).toContain(`DOKPLOY_BP_TAG=${REPOSITORY}:"$DOKPLOY_BP_SHA"`);
		expect(command).toContain('docker push "$DOKPLOY_BP_TAG"');
		expect(command).toContain(DIGEST_MARKER);
	});

	it("deploys the image by digest rather than by the mutable tag", async () => {
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(deployedApplication()?.buildPolicyImage).toBe(
			`${REPOSITORY}@${DIGEST}`,
		);
	});

	it("stores the image tag and digest on the deployment record", async () => {
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(deploymentService.updateDeployment).toHaveBeenCalledWith(
			"deployment-1",
			expect.objectContaining({
				imageTag: `${REPOSITORY}:${SHA}`,
				imageDigest: DIGEST,
			}),
		);
	});

	it("gives the deploy host registry credentials so it can pull the digest", async () => {
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(
			(deployedApplication()?.buildRegistry as { registryId: string })
				?.registryId,
		).toBe("registry-1");
	});

	it("audits the enforcement and the digest pin", async () => {
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		const actions = mocks.recordBuildPolicyAudit.mock.calls.map(
			([entry]) => entry.action,
		);
		expect(actions).toContain("remote_build_enforced");
		expect(actions).toContain("deploy_by_digest");
	});

	it("fails the deploy when the build published no digest", async () => {
		vi.mocked(execProcess.execAsyncRemote).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as never);
		await expect(
			deployApplication({
				applicationId: "app-1",
				titleLog: "t",
				descriptionLog: "",
			}),
		).rejects.toMatchObject({ code: "DIGEST_NOT_PUBLISHED" });
	});

	it("enforces on a rebuild too, not just a first deploy", async () => {
		await rebuildApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(buildHost()).toBe("build-server-1");
		expect(deployedApplication()?.buildPolicyImage).toBe(
			`${REPOSITORY}@${DIGEST}`,
		);
	});

	it("enforces a git source hosted on github.com", async () => {
		primeMocks(
			APPLICATION({
				sourceType: "git",
				customGitUrl: "https://github.com/DevinoSolutions/sendly.git",
			}),
		);
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(buildHost()).toBe("build-server-1");
	});
});

describe("units that keep a local build", () => {
	const expectLocalBuild = () => {
		expect(buildHost()).toBe("deploy-server-1");
		expect(buildCommand()).not.toContain(DIGEST_MARKER);
		expect(deployedApplication()?.buildPolicyImage).toBeUndefined();
	};

	it("builds locally when enforcement is off", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue(null);
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expectLocalBuild();
	});

	it("builds locally for an excluded unit", async () => {
		mocks.isUnitExcluded.mockResolvedValue(true);
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expectLocalBuild();
	});

	it("does not spend a break-glass grant on an excluded unit", async () => {
		mocks.isUnitExcluded.mockResolvedValue(true);
		mocks.findPendingBreakGlass.mockResolvedValue({
			buildPolicyAuditId: "grant-1",
			actorEmail: "ops@example.com",
			reason: "registry outage",
			actorId: "user-1",
		});
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(mocks.consumeBreakGlass).not.toHaveBeenCalled();
	});

	it("builds locally for a non-github source", async () => {
		primeMocks(
			APPLICATION({
				sourceType: "git",
				customGitUrl: "https://gitlab.com/acme/thing.git",
			}),
		);
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expectLocalBuild();
	});
});

describe("break glass", () => {
	it("builds locally once and spends the grant", async () => {
		mocks.findPendingBreakGlass.mockResolvedValue({
			buildPolicyAuditId: "grant-1",
			actorEmail: "ops@example.com",
			reason: "registry outage",
			actorId: "user-1",
		});
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(buildHost()).toBe("deploy-server-1");
		expect(mocks.consumeBreakGlass).toHaveBeenCalledWith(
			expect.objectContaining({
				unitType: "application",
				unitId: "app-1",
				grant: expect.objectContaining({ buildPolicyAuditId: "grant-1" }),
			}),
		);
	});

	it("is enforced again on the next deploy once the grant is spent", async () => {
		mocks.findPendingBreakGlass
			.mockResolvedValueOnce({
				buildPolicyAuditId: "grant-1",
				actorEmail: "ops@example.com",
				reason: "registry outage",
				actorId: "user-1",
			})
			.mockResolvedValue(null);

		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(buildHost()).toBe("deploy-server-1");

		vi.mocked(execProcess.execAsyncRemote).mockClear();
		vi.mocked(builders.mechanizeDockerContainer).mockClear();

		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(buildHost()).toBe("build-server-1");
		expect(deployedApplication()?.buildPolicyImage).toBe(
			`${REPOSITORY}@${DIGEST}`,
		);
	});
});

describe("no silent local fallback", () => {
	it("fails the deploy with a named error when no build server is configured", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue(
			SETTINGS({ defaultBuildServerId: null }),
		);
		await expect(
			deployApplication({
				applicationId: "app-1",
				titleLog: "t",
				descriptionLog: "",
			}),
		).rejects.toMatchObject({ code: "NO_BUILD_SERVER" });
	});

	it("never starts a build when the build server is missing", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue(
			SETTINGS({ defaultBuildServerId: null }),
		);
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		}).catch(() => {});
		expect(builders.getBuildCommand).not.toHaveBeenCalled();
		expect(builders.mechanizeDockerContainer).not.toHaveBeenCalled();
	});

	it("fails when no registry is configured", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue(
			SETTINGS({ defaultRegistryId: null }),
		);
		await expect(
			deployApplication({
				applicationId: "app-1",
				titleLog: "t",
				descriptionLog: "",
			}),
		).rejects.toMatchObject({ code: "NO_REGISTRY" });
	});

	/**
	 * Finding 3 of the PR #209 review: the plan used to throw before
	 * `createDeployment`, so a refused deploy left no deployment row, no error
	 * status and no notification — the team saw nothing at all.
	 */
	it("still records a deployment for the refused deploy", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue(
			SETTINGS({ defaultBuildServerId: null }),
		);
		await deployApplication({
			applicationId: "app-1",
			titleLog: "Manual deployment",
			descriptionLog: "",
		}).catch(() => {});
		expect(deploymentService.createDeployment).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "app-1",
				title: "Manual deployment",
			}),
		);
	});

	it("marks that deployment as errored", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue(
			SETTINGS({ defaultBuildServerId: null }),
		);
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		}).catch(() => {});
		expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-1",
			"error",
		);
	});

	it("sends exactly one build-error notification naming the reason", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue(
			SETTINGS({ defaultBuildServerId: null }),
		);
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		}).catch(() => {});
		const send = vi.mocked(buildErrorNotifications.sendBuildErrorNotifications);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0]).toMatchObject({
			applicationType: "application",
			organizationId: "org-1",
		});
		expect(String(send.mock.calls[0]?.[0]?.errorMessage)).toMatch(
			/build server/i,
		);
	});

	it("writes the reason into the deployment log", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue(
			SETTINGS({ defaultRegistryId: null }),
		);
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		}).catch(() => {});
		const wrote = vi
			.mocked(execProcess.execAsyncRemote)
			.mock.calls.some(([, command]) =>
				String(command).includes("/var/log/deployment-1.log"),
			);
		expect(wrote).toBe(true);
	});

	it("audits the refusal so the reason is recoverable", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue(
			SETTINGS({ defaultBuildServerId: null }),
		);
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		}).catch(() => {});
		expect(mocks.recordBuildPolicyAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "build_server_missing" }),
		);
	});
});

describe("required checks", () => {
	const checkRun = (
		name: string,
		status: string,
		conclusion: string | null = null,
	) => ({ name, status, conclusion });

	beforeEach(() => {
		primeMocks(APPLICATION({ requiredChecks: ["build", "e2e"] }));
	});

	it("deploys once every required check has succeeded", async () => {
		mocks.listCheckRuns.mockResolvedValue({
			data: {
				check_runs: [
					checkRun("build", "completed", "success"),
					checkRun("e2e", "completed", "success"),
				],
			},
		});
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(builders.mechanizeDockerContainer).toHaveBeenCalled();
	});

	it("checks the commit the image was built from", async () => {
		mocks.listCheckRuns.mockResolvedValue({
			data: {
				check_runs: [
					checkRun("build", "completed", "success"),
					checkRun("e2e", "completed", "success"),
				],
			},
		});
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(mocks.listCheckRuns).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: "DevinoSolutions",
				repo: "sendly",
				ref: SHA,
			}),
		);
	});

	it("fails the deploy before the deploy step when a required check fails", async () => {
		mocks.listCheckRuns.mockResolvedValue({
			data: {
				check_runs: [
					checkRun("build", "completed", "success"),
					checkRun("e2e", "completed", "failure"),
				],
			},
		});
		await expect(
			deployApplication({
				applicationId: "app-1",
				titleLog: "t",
				descriptionLog: "",
			}),
		).rejects.toMatchObject({ code: "REQUIRED_CHECKS_FAILED" });
		expect(builders.mechanizeDockerContainer).not.toHaveBeenCalled();
	});

	it("fails the deploy when the required checks never conclude", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue(
			SETTINGS({ requiredChecksTimeoutMinutes: 0 }),
		);
		mocks.listCheckRuns.mockResolvedValue({
			data: { check_runs: [checkRun("build", "in_progress")] },
		});
		await expect(
			deployApplication({
				applicationId: "app-1",
				titleLog: "t",
				descriptionLog: "",
			}),
		).rejects.toMatchObject({ code: "REQUIRED_CHECKS_TIMEOUT" });
		expect(builders.mechanizeDockerContainer).not.toHaveBeenCalled();
	});

	it("audits a failed gate", async () => {
		mocks.listCheckRuns.mockResolvedValue({
			data: {
				data: [],
				check_runs: [checkRun("build", "completed", "failure")],
			},
		});
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		}).catch(() => {});
		expect(mocks.recordBuildPolicyAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "required_checks_failed" }),
		);
	});

	it("does not call GitHub at all when the list is empty", async () => {
		primeMocks(APPLICATION({ requiredChecks: [] }));
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(mocks.listCheckRuns).not.toHaveBeenCalled();
	});
});

describe("rollback to a stored digest", () => {
	it("redeploys the digest a past deployment stored, with no build", async () => {
		await rollbackToDeploymentDigest({
			deploymentId: "deployment-9",
			organizationId: "org-1",
		});
		expect(builders.getBuildCommand).not.toHaveBeenCalled();
		expect(gitProvider.cloneGitRepository).not.toHaveBeenCalled();
		expect(deployedApplication()?.buildPolicyImage).toBe(
			`${REPOSITORY}@${DIGEST}`,
		);
	});

	it("does not wait on required checks for an image that already shipped", async () => {
		primeMocks(APPLICATION({ requiredChecks: ["build"] }));
		mocks.listCheckRuns.mockResolvedValue({
			data: {
				check_runs: [
					{ name: "build", status: "completed", conclusion: "failure" },
				],
			},
		});
		await expect(
			rollbackToDeploymentDigest({
				deploymentId: "deployment-9",
				organizationId: "org-1",
			}),
		).resolves.toBe(true);
		expect(mocks.listCheckRuns).not.toHaveBeenCalled();
	});

	it("refuses a deployment that stored no digest, and deploys nothing", async () => {
		mocks.deploymentsFindFirst.mockResolvedValue({
			deploymentId: "deployment-9",
			applicationId: "app-1",
			imageTag: null,
			imageDigest: null,
		});
		await expect(
			rollbackToDeploymentDigest({
				deploymentId: "deployment-9",
				organizationId: "org-1",
			}),
		).rejects.toMatchObject({ code: "DIGEST_NOT_PUBLISHED" });
		expect(builders.mechanizeDockerContainer).not.toHaveBeenCalled();
	});
});

describe("deploy-hook body with an image", () => {
	it("deploys the supplied image by digest and never builds", async () => {
		await deployPinnedApplicationImage({
			applicationId: "app-1",
			pinnedImage: {
				ref: `${REPOSITORY}@${DIGEST}`,
				tag: SHA,
				digest: DIGEST,
			},
		});
		expect(builders.getBuildCommand).not.toHaveBeenCalled();
		expect(deployedApplication()?.buildPolicyImage).toBe(
			`${REPOSITORY}@${DIGEST}`,
		);
	});

	it("records the image on the deployment", async () => {
		await deployPinnedApplicationImage({
			applicationId: "app-1",
			pinnedImage: {
				ref: `${REPOSITORY}@${DIGEST}`,
				tag: SHA,
				digest: DIGEST,
			},
		});
		expect(deploymentService.updateDeployment).toHaveBeenCalledWith(
			"deployment-1",
			expect.objectContaining({ imageTag: SHA, imageDigest: DIGEST }),
		);
	});

	it("still honours required checks", async () => {
		primeMocks(APPLICATION({ requiredChecks: ["build"] }));
		mocks.listCheckRuns.mockResolvedValue({
			data: {
				check_runs: [
					{ name: "build", status: "completed", conclusion: "failure" },
				],
			},
		});
		await expect(
			deployPinnedApplicationImage({
				applicationId: "app-1",
				pinnedImage: {
					ref: `${REPOSITORY}@${DIGEST}`,
					tag: SHA,
					digest: DIGEST,
				},
			}),
		).rejects.toMatchObject({ code: "REQUIRED_CHECKS_FAILED" });
		expect(builders.mechanizeDockerContainer).not.toHaveBeenCalled();
	});

	it("tells a compose unit the capability does not exist, rather than ignoring the body", async () => {
		// The compose build is not relocatable, so there is no digest to deploy.
		// An enforcing organization gets a 400 body back; see README § Known gap.
		await expect(
			rejectComposeDeployHookImage("env-1", {
				image: `${REPOSITORY}`,
				digest: DIGEST,
			}),
		).resolves.toMatchObject({ ok: false });
	});

	it("leaves a compose deploy hook with no image alone", async () => {
		await expect(
			rejectComposeDeployHookImage("env-1", { branch: "main" }),
		).resolves.toEqual({ ok: true });
	});
});

describe("enqueue-time gate", () => {
	const unit = {
		unitId: "app-1",
		unitName: "Sendly Web",
		environmentId: "env-1",
		watchPaths: null,
		buildPath: "/apps/web",
		dockerfile: "Dockerfile",
	};

	it("drops the older queued deploy and reports how many", async () => {
		const removeWaiting = vi.fn().mockResolvedValue(1);
		const result = await buildPolicyDeployGate({
			unitType: "application",
			unit,
			commitMessage: "feat: thing",
			removeWaiting,
		});
		expect(result).toEqual({ deploy: true, coalesced: 1 });
		expect(removeWaiting).toHaveBeenCalledTimes(1);
		expect(mocks.recordBuildPolicyAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "deploy_coalesced" }),
		);
	});

	it("skips the deploy on a [skip deploy] commit and records why", async () => {
		const removeWaiting = vi.fn().mockResolvedValue(0);
		const result = await buildPolicyDeployGate({
			unitType: "application",
			unit,
			commitMessage: "chore: docs only [skip deploy]",
			removeWaiting,
		});
		expect(result).toMatchObject({
			deploy: false,
			reason: "skip_deploy_marker",
		});
		expect(removeWaiting).not.toHaveBeenCalled();
		expect(mocks.recordBuildPolicyAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "deploy_skipped" }),
		);
	});

	it("applies the derived default watch paths when the unit has none", async () => {
		const result = await buildPolicyDeployGate({
			unitType: "application",
			unit,
			changedFiles: ["docs/readme.md"],
			commitMessage: "docs: tweak",
			removeWaiting: vi.fn().mockResolvedValue(0),
		});
		expect(result).toMatchObject({ deploy: false, reason: "watch_paths" });
	});

	it("deploys when a changed file is inside the derived watch paths", async () => {
		const result = await buildPolicyDeployGate({
			unitType: "application",
			unit,
			changedFiles: ["apps/web/src/index.ts"],
			commitMessage: "feat: thing",
			removeWaiting: vi.fn().mockResolvedValue(0),
		});
		expect(result).toMatchObject({ deploy: true });
	});

	it("leaves a unit with its own watch paths to upstream's own check", async () => {
		const result = await buildPolicyDeployGate({
			unitType: "application",
			unit: { ...unit, watchPaths: ["services/**"] },
			changedFiles: ["docs/readme.md"],
			commitMessage: "docs: tweak",
			removeWaiting: vi.fn().mockResolvedValue(0),
		});
		expect(result).toMatchObject({ deploy: true });
	});
});
