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
import { beforeEach, describe, expect, it, vi } from "vitest";

// A GitHub Actions release whose image the registry does not serve yet is retried by the connection poll
// (T-15783). While retries are left the failed attempt still ends its deployment row as `error`, but the service
// is not marked broken and nobody is notified; the attempt with no retry left fails the way it always did.
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
	writeDeploymentErrorLog: async (...args: unknown[]) =>
		(
			await import(
				"@/__test__/deploy/fixtures/actual-write-deployment-error-log"
			)
		).actualWriteDeploymentErrorLog(...(args as [any, any, any, any?])),
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

vi.mock("@dokploy/server/services/gha-connect/store", () => ({
	findRegistryRetriesDone: vi.fn(),
}));

vi.mock("@dokploy/server/services/rollbacks", () => ({
	createRollback: vi.fn(),
}));

import { db } from "@dokploy/server/db";
import * as ghaStore from "@dokploy/server/services/gha-connect/store";

const TITLE = "GHA production aaaaaaaa [deployment #77]";
const DENIED =
	'Task rejected: Get "https://ghcr.io/v2/o/r/landing/manifests/sha256:a": denied: denied';

const createMockApplication = (overrides = {}) => ({
	applicationId: "test-app-id",
	name: "Test App",
	appName: "test-app",
	sourceType: "docker" as const,
	dockerImage: "ghcr.io/o/r/landing@sha256:a",
	buildType: "nixpacks" as const,
	env: "",
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

const primeMocks = (title: string) => {
	const app = createMockApplication();
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
		title,
	} as any);
	vi.mocked(execProcess.execAsync).mockResolvedValue({
		stdout: "",
		stderr: "",
	} as any);
	vi.mocked(execProcess.execAsyncRemote).mockResolvedValue({
		stdout: "",
		stderr: "",
	} as any);
	vi.mocked(builders.getBuildCommand).mockResolvedValue("echo build");
	vi.mocked(builders.mechanizeDockerContainer).mockResolvedValue(
		undefined as any,
	);
	vi.mocked(deploymentService.updateDeploymentStatus).mockResolvedValue(
		undefined as any,
	);
	vi.mocked(applicationService.updateApplicationStatus).mockResolvedValue(
		{} as any,
	);
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
		stable: false,
		reason: DENIED,
	} as any);
};

/** The statuses written on the application, in order (updateApplicationStatus writes through the database). */
const statuses = () =>
	sets.flatMap((set) =>
		"applicationStatus" in set ? [set.applicationStatus] : [],
	);

const run = () =>
	deployApplication({
		applicationId: "test-app-id",
		titleLog: TITLE,
		descriptionLog: "",
	});

beforeEach(() => {
	vi.clearAllMocks();
	sets.length = 0;
});

describe("deployApplication: a registry that refuses the image of a GitHub Actions release", () => {
	it.each([0, 1, 2, 3])(
		"with %s retries used: the row ends as error, the service is not marked broken and nobody is notified",
		async (used) => {
			primeMocks(TITLE);
			vi.mocked(ghaStore.findRegistryRetriesDone).mockResolvedValue(used);

			// The queue reads this to put back the status the service had when the job started.
			await expect(run()).rejects.toMatchObject({
				registryRetryPending: true,
				settledStatus: "done",
				message: expect.stringContaining("denied: denied"),
			});

			expect(ghaStore.findRegistryRetriesDone).toHaveBeenCalledWith(
				"test-app-id",
				77,
			);
			expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
				"deployment-id",
				"error",
			);
			// The reason is kept on the row for the poll.
			expect(sets.some((set) => "errorMessage" in set)).toBe(true);
			expect(statuses()).not.toContain("error");
			expect(statuses().at(-1)).toBe("done");
			expect(notifications.sendBuildErrorNotifications).not.toHaveBeenCalled();
		},
	);

	it("with no retry left: the service is marked broken and the failure is notified, as before", async () => {
		primeMocks(TITLE);
		vi.mocked(ghaStore.findRegistryRetriesDone).mockResolvedValue(4);

		await expect(run()).rejects.toThrow("denied: denied");

		expect(statuses()).toContain("error");
		expect(notifications.sendBuildErrorNotifications).toHaveBeenCalledTimes(1);
	});

	it("another failure of the same release is notified at once", async () => {
		primeMocks(TITLE);
		vi.mocked(dockerUtils.waitForSwarmServiceStable).mockResolvedValue({
			stable: false,
			reason: "Task failed: non-zero exit (1)",
		} as any);
		vi.mocked(ghaStore.findRegistryRetriesDone).mockResolvedValue(0);

		await expect(run()).rejects.toThrow("non-zero exit");

		expect(statuses()).toContain("error");
		expect(notifications.sendBuildErrorNotifications).toHaveBeenCalledTimes(1);
	});

	it("a deploy that is not a GitHub Actions release is never held back", async () => {
		primeMocks("Manual deploy");
		vi.mocked(ghaStore.findRegistryRetriesDone).mockResolvedValue(0);

		await expect(run()).rejects.toThrow("denied: denied");

		expect(ghaStore.findRegistryRetriesDone).not.toHaveBeenCalled();
		expect(statuses()).toContain("error");
		expect(notifications.sendBuildErrorNotifications).toHaveBeenCalledTimes(1);
	});

	it("a release the store does not know is not held back either", async () => {
		primeMocks(TITLE);
		vi.mocked(ghaStore.findRegistryRetriesDone).mockResolvedValue(null);

		await expect(run()).rejects.toThrow("denied: denied");

		expect(notifications.sendBuildErrorNotifications).toHaveBeenCalledTimes(1);
	});
});
