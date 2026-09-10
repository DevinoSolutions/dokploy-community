import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * With `enforceRemoteBuilds` off — the state of every organization the moment
 * this merges — the deploy path and the enqueue gate must be behaviourally
 * identical to upstream: no derived watch paths, no skip marker, no coalescing,
 * no deploy-hook image body, no extra database reads and no extra remote execs.
 *
 * These tests exist because the first version of this module ran all four of
 * those unconditionally.
 */

const mocks = vi.hoisted(() => ({
	findBuildPolicySettings: vi.fn(),
	isUnitExcluded: vi.fn(),
	findPendingBreakGlass: vi.fn(),
	consumeBreakGlass: vi.fn(),
	recordBuildPolicyAudit: vi.fn(),
	environmentsFindFirst: vi.fn(),
	applicationsFindFirst: vi.fn(),
	registryFindMany: vi.fn(),
	buildPolicySettingsFindFirst: vi.fn(),
	listCheckRuns: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const chain = (): any => {
		const self: any = {
			set: vi.fn(() => self),
			where: vi.fn(() => self),
			values: vi.fn(() => self),
			from: vi.fn(() => self),
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
				registry: { findMany: mocks.registryFindMany },
				buildPolicySettings: {
					findFirst: mocks.buildPolicySettingsFindFirst,
				},
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
	findAllRegistryByOrganizationId: vi.fn().mockResolvedValue([]),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeployment: vi.fn(),
	updateDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	getDeploymentErrorMessage: vi.fn(),
}));

vi.mock("@dokploy/server/services/admin", () => ({ getDokployUrl: vi.fn() }));
vi.mock("@dokploy/server/services/github", () => ({ findGithubById: vi.fn() }));
vi.mock("@dokploy/server/utils/providers/github", () => ({
	authGithub: vi.fn(() => ({
		rest: {
			checks: { listForRef: mocks.listCheckRuns },
			repos: {
				listCommitStatusesForRef: vi.fn().mockResolvedValue({ data: [] }),
			},
		},
	})),
	cloneGithubRepository: vi.fn(async () => "echo clone;"),
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
import { deployApplication } from "@dokploy/server/services/application";
import { clearBuildPolicyEnforcementCache } from "@dokploy/server/services/build-policy/settings";
import {
	buildPolicyDeployGate,
	resolveDeployHookImage,
} from "@dokploy/server/services/build-policy/webhook";
import * as deploymentService from "@dokploy/server/services/deployment";
import * as builders from "@dokploy/server/utils/builders";
import * as dockerUtils from "@dokploy/server/utils/docker/utils";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import * as gitProvider from "@dokploy/server/utils/providers/git";

const APPLICATION = {
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
	buildPath: "/apps/web",
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
};

const GATE_UNIT = {
	unitId: "app-1",
	unitName: "Sendly Web",
	environmentId: "env-1",
	watchPaths: null,
	buildPath: "/apps/web",
	dockerfile: "Dockerfile",
};

beforeEach(() => {
	vi.clearAllMocks();
	clearBuildPolicyEnforcementCache();

	// No organization has enforcement on. This is the state on merge.
	mocks.buildPolicySettingsFindFirst.mockResolvedValue(undefined);
	mocks.findBuildPolicySettings.mockResolvedValue(null);
	mocks.applicationsFindFirst.mockResolvedValue(APPLICATION);
	mocks.environmentsFindFirst.mockResolvedValue({
		environmentId: "env-1",
		project: { organizationId: "org-1" },
	});
	mocks.registryFindMany.mockResolvedValue([]);

	vi.mocked(applicationService.findApplicationById).mockResolvedValue(
		APPLICATION as never,
	);
	vi.mocked(adminService.getDokployUrl).mockResolvedValue("http://localhost");
	vi.mocked(deploymentService.createDeployment).mockResolvedValue({
		deploymentId: "deployment-1",
		logPath: "/var/log/deployment-1.log",
	} as never);
	vi.mocked(builders.getBuildCommand).mockResolvedValue("echo build;");
	vi.mocked(builders.mechanizeDockerContainer).mockResolvedValue(
		undefined as never,
	);
	vi.mocked(dockerUtils.waitForSwarmServiceStable).mockResolvedValue({
		stable: true,
	} as never);
	vi.mocked(gitProvider.getGitCommitInfo).mockResolvedValue({
		hash: "abc",
		message: "m",
	} as never);
	vi.mocked(execProcess.execAsyncRemote).mockResolvedValue({
		stdout: "",
		stderr: "",
	} as never);
	vi.mocked(execProcess.execAsync).mockResolvedValue({
		stdout: "",
		stderr: "",
	} as never);
});

describe("the enqueue gate while the policy is off", () => {
	it("deploys a push that no derived watch path would have matched", async () => {
		const result = await buildPolicyDeployGate({
			unitType: "application",
			unit: GATE_UNIT,
			changedFiles: ["packages/shared/index.ts"],
			commitMessage: "chore: shared only",
			removeWaiting: vi.fn(),
		});
		expect(result).toEqual({ deploy: true, coalesced: 0 });
	});

	it("ignores a [skip deploy] marker, which upstream does not honour", async () => {
		const result = await buildPolicyDeployGate({
			unitType: "application",
			unit: GATE_UNIT,
			commitMessage: "docs: readme [skip deploy]",
			removeWaiting: vi.fn(),
		});
		expect(result).toEqual({ deploy: true, coalesced: 0 });
	});

	it("does not coalesce, so a queued deploy is left alone", async () => {
		const removeWaiting = vi.fn().mockResolvedValue(3);
		await buildPolicyDeployGate({
			unitType: "application",
			unit: GATE_UNIT,
			commitMessage: "feat: thing",
			removeWaiting,
		});
		expect(removeWaiting).not.toHaveBeenCalled();
	});

	it("writes no audit entry", async () => {
		await buildPolicyDeployGate({
			unitType: "application",
			unit: GATE_UNIT,
			changedFiles: ["packages/shared/index.ts"],
			commitMessage: "docs: readme [skip deploy]",
			removeWaiting: vi.fn().mockResolvedValue(2),
		});
		expect(mocks.recordBuildPolicyAudit).not.toHaveBeenCalled();
	});

	it("does not look the unit's environment up, because it needs nothing from it", async () => {
		await buildPolicyDeployGate({
			unitType: "application",
			unit: GATE_UNIT,
			commitMessage: "feat: thing",
			removeWaiting: vi.fn(),
		});
		expect(mocks.environmentsFindFirst).not.toHaveBeenCalled();
	});

	it("answers from a cached enforcement check on the second call", async () => {
		for (let i = 0; i < 5; i++) {
			await buildPolicyDeployGate({
				unitType: "application",
				unit: GATE_UNIT,
				commitMessage: "feat: thing",
				removeWaiting: vi.fn(),
			});
		}
		expect(mocks.buildPolicySettingsFindFirst).toHaveBeenCalledTimes(1);
	});
});

describe("the deploy-hook image body while the policy is off", () => {
	it("is ignored rather than deploying an unbuilt image", async () => {
		const result = await resolveDeployHookImage(
			{ organizationId: "org-1", appName: "sendly-web" },
			{
				image: "ghcr.io/devinosolutions/sendly-web",
				digest: `sha256:${"a".repeat(64)}`,
			},
		);
		expect(result).toEqual({ ok: true });
	});

	it("does not read the organization's registries", async () => {
		await resolveDeployHookImage(
			{ organizationId: "org-1", appName: "sendly-web" },
			{
				image: "ghcr.io/devinosolutions/sendly-web",
				digest: `sha256:${"a".repeat(64)}`,
			},
		);
		expect(mocks.registryFindMany).not.toHaveBeenCalled();
	});
});

describe("the deploy path while the policy is off", () => {
	it("reads the organization settings exactly once", async () => {
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(mocks.findBuildPolicySettings).toHaveBeenCalledTimes(1);
	});

	it("reads no exclusions and no break-glass grants", async () => {
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(mocks.isUnitExcluded).not.toHaveBeenCalled();
		expect(mocks.findPendingBreakGlass).not.toHaveBeenCalled();
	});

	it("adds no git round trip beyond the one upstream already makes", async () => {
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		// Upstream calls this once, in its own `finally`, to title the deployment.
		expect(gitProvider.getGitCommitInfo).toHaveBeenCalledTimes(1);
	});

	it("adds no remote exec beyond the build itself", async () => {
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		const commands = vi
			.mocked(execProcess.execAsyncRemote)
			.mock.calls.map(([, command]) => String(command));
		expect(commands).toHaveLength(1);
		expect(commands[0]).toContain("echo build;");
	});

	it("writes no audit entry", async () => {
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(mocks.recordBuildPolicyAudit).not.toHaveBeenCalled();
	});

	it("leaves the build on the deploy host and the image on its mutable tag", async () => {
		await deployApplication({
			applicationId: "app-1",
			titleLog: "t",
			descriptionLog: "",
		});
		expect(vi.mocked(execProcess.execAsyncRemote).mock.calls[0]?.[0]).toBe(
			"deploy-server-1",
		);
		const deployed = vi.mocked(builders.mechanizeDockerContainer).mock
			.calls[0]?.[0] as Record<string, unknown>;
		expect(deployed?.buildPolicyImage).toBeUndefined();
	});
});
