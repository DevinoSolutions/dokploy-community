import * as adminService from "@dokploy/server/services/admin";
import * as applicationService from "@dokploy/server/services/application";
import {
	deployApplication,
	rebuildApplication,
} from "@dokploy/server/services/application";
import * as deploymentService from "@dokploy/server/services/deployment";
import * as builders from "@dokploy/server/utils/builders";
import * as hooks from "@dokploy/server/utils/docker/hooks";
import * as dockerUtils from "@dokploy/server/utils/docker/utils";
import * as notifications from "@dokploy/server/utils/notifications/build-error";
import * as successNotifications from "@dokploy/server/utils/notifications/build-success";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import * as gitProvider from "@dokploy/server/utils/providers/git";
import { resolveVaultReferences } from "@dokploy/server/utils/vault";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A deploy that fails because a ${{vault.*}} reference cannot be resolved
// ends as `error` with the reason in the deploy log. The deployment row has to
// carry the same reason in `errorMessage` (T-11775), or the dashboard shows a
// failed deployment with no explanation. The reference is resolved for real
// (the HashiCorp client over a mocked fetch).
const sets = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("@dokploy/server/db", () => {
	const createChainableMock = (): any => {
		const chain = {
			set: vi.fn((values: Record<string, unknown>) => {
				sets.push(values);
				return chain;
			}),
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
				buildPolicySettings: {
					findFirst: vi.fn().mockResolvedValue(undefined),
				},
				applications: {
					findFirst: vi.fn(),
				},
				deployments: {
					findFirst: vi.fn().mockResolvedValue({ status: "running" }),
				},
				deployHook: {
					findFirst: vi.fn(),
				},
				patch: {
					findMany: vi.fn().mockResolvedValue([]),
				},
				member: {
					findMany: vi.fn().mockResolvedValue([]),
				},
				vaultProvider: {
					findMany: vi.fn(),
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

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updateDeployment: vi.fn(),
	getDeploymentErrorMessage: vi.fn(),
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

vi.mock("@dokploy/server/utils/docker/hooks", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/docker/hooks")
	>("@dokploy/server/utils/docker/hooks");
	return {
		...actual,
		runDeployHook: vi.fn(),
	};
});

vi.mock("@dokploy/server/utils/docker/utils", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/docker/utils")
	>("@dokploy/server/utils/docker/utils");
	return {
		...actual,
		waitForSwarmServiceStable: vi.fn(),
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

import { db } from "@dokploy/server/db";

const MISSING_FIELD =
	'HashiCorp Vault: field "NOPE" not found in secret "dokploy-test/app"';
const ENV = "APP_FOO=${{vault.prov.dokploy-test/app:NOPE}}";

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
	env: ENV,
	serverId: null,
	buildServerId: null,
	rollbackActive: false,
	enableSubmodules: false,
	environmentId: "env-id",
	deployHooks: null,
	environment: {
		environmentId: "env-id",
		projectId: "project-id",
		env: "",
		name: "production",
		project: {
			projectId: "project-id",
			name: "Test Project",
			organizationId: "org-id",
			env: "",
		},
	},
	domains: [],
	...overrides,
});

const errorMessagesWritten = () =>
	sets.flatMap((set) => ("errorMessage" in set ? [set.errorMessage] : []));

const useVault = (secretFields: Record<string, string>) => {
	vi.mocked(db.query.vaultProvider.findMany).mockResolvedValue([
		{
			name: "prov",
			providerType: "hashicorp",
			config: {
				providerType: "hashicorp",
				url: "https://vault.example.com",
				token: "hvs.token",
				mount: "secret",
			},
			assignments: [{ projectId: "project-id", environmentIds: [] }],
		},
	] as never);
	global.fetch = vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => ({ data: { data: secretFields } }),
	})) as unknown as typeof fetch;
};

const primeMocks = (app = createMockApplication()) => {
	vi.mocked(db.query.applications.findFirst).mockResolvedValue(app as any);
	vi.mocked(applicationService.findApplicationById).mockResolvedValue(
		app as any,
	);
	vi.mocked(db.query.deployHook.findFirst).mockResolvedValue(undefined as any);
	vi.mocked(adminService.getDokployUrl).mockResolvedValue(
		"http://localhost:3000",
	);
	vi.mocked(deploymentService.createDeployment).mockResolvedValue({
		deploymentId: "deployment-id",
		logPath: "/tmp/test-deployment.log",
	} as any);
	vi.mocked(execProcess.execAsync).mockResolvedValue({
		stdout: "",
		stderr: "",
	} as any);
	vi.mocked(execProcess.execAsyncRemote).mockResolvedValue({
		stdout: "",
		stderr: "",
	} as any);
	// The build resolves the env's vault references, as the real one does.
	vi.mocked(builders.getBuildCommand).mockImplementation(async () => {
		await resolveVaultReferences(ENV, {
			organizationId: "org-id",
			projectId: "project-id",
			environmentId: "env-id",
		});
		return "echo build";
	});
	vi.mocked(builders.mechanizeDockerContainer).mockResolvedValue(
		undefined as any,
	);
	vi.mocked(deploymentService.updateDeploymentStatus).mockResolvedValue(
		undefined as any,
	);
	vi.mocked(applicationService.updateApplicationStatus).mockResolvedValue(
		{} as any,
	);
	vi.mocked(
		successNotifications.sendBuildSuccessNotifications,
	).mockResolvedValue(undefined as any);
	vi.mocked(notifications.sendBuildErrorNotifications).mockResolvedValue(
		undefined as any,
	);
	vi.mocked(gitProvider.getGitCommitInfo).mockResolvedValue({
		message: "test commit",
		hash: "abc123",
	});
	vi.mocked(deploymentService.updateDeployment).mockResolvedValue({} as any);
	vi.mocked(deploymentService.getDeploymentErrorMessage).mockResolvedValue(
		"error message",
	);
	vi.mocked(hooks.runDeployHook).mockResolvedValue(undefined as any);
	vi.mocked(dockerUtils.waitForSwarmServiceStable).mockResolvedValue({
		stable: true,
	} as any);
};

describe.each([
	["deployApplication", deployApplication],
	["rebuildApplication", rebuildApplication],
])("%s with an unresolvable vault reference", (_name, run) => {
	const args = {
		applicationId: "test-app-id",
		titleLog: "t",
		descriptionLog: "",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		sets.length = 0;
	});

	it.each([
		["on this host", {}],
		[
			"with a build server",
			{ serverId: "app-server-id", buildServerId: "build-server-id" },
		],
	])("records the reason the log shows on the deployment (%s)", async (_host, overrides) => {
		primeMocks(createMockApplication(overrides));
		useVault({ OTHER: "value" });

		await expect(run(args)).rejects.toThrow(MISSING_FIELD);

		expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-id",
			"error",
		);
		expect(errorMessagesWritten()).toEqual([MISSING_FIELD]);
		expect(builders.mechanizeDockerContainer).not.toHaveBeenCalled();
	});

	it("leaves the message alone when the failure is not a vault reference", async () => {
		primeMocks();
		useVault({ NOPE: "value" });
		vi.mocked(builders.getBuildCommand).mockRejectedValue(new Error("boom"));

		await expect(run(args)).rejects.toThrow("boom");

		expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-id",
			"error",
		);
		expect(errorMessagesWritten()).toEqual([]);
	});
});
