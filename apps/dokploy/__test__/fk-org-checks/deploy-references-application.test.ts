import * as adminService from "@dokploy/server/services/admin";
import * as applicationService from "@dokploy/server/services/application";
import {
	deployApplication,
	rebuildApplication,
} from "@dokploy/server/services/application";
import * as deploymentService from "@dokploy/server/services/deployment";
import { assertDeployReferencesInOrganization } from "@dokploy/server/services/service-reference-scope";
import * as builders from "@dokploy/server/utils/builders";
import * as notifications from "@dokploy/server/utils/notifications/build-error";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import * as gitProvider from "@dokploy/server/utils/providers/git";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// An application deploy and rebuild re-check the organization of every
// registry, git provider and SSH key the row points at, before the clone, the
// registry login and the build (T-6902). The check itself is covered in
// deploy-references.test.ts; here it is refused on purpose and the pipeline has
// to stop with the reason in the deployment log.
vi.mock("@dokploy/server/db", () => {
	const createChainableMock = (): any => {
		const chain = {
			set: vi.fn(() => chain),
			where: vi.fn(() => chain),
			returning: vi.fn().mockResolvedValue([{}] as any),
			from: vi.fn(() => chain),
			innerJoin: vi.fn(() => chain),
			// biome-ignore lint/suspicious/noThenProperty: drizzle's query builder is itself a thenable, so the fake standing in for it must be one too
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
				applications: { findFirst: vi.fn() },
				deployHook: { findFirst: vi.fn() },
				patch: { findMany: vi.fn().mockResolvedValue([]) },
				member: { findMany: vi.fn().mockResolvedValue([]) },
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
	return { ...actual, getGitCommitInfo: vi.fn() };
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

const LOG_PATH = "/tmp/test-deployment.log";
const REFUSAL =
	"Deployment refused: the Registry set on this service does not belong to its organization.";

const app = {
	applicationId: "test-app-id",
	name: "Test App",
	appName: "test-app",
	sourceType: "git" as const,
	buildType: "nixpacks" as const,
	env: "",
	serverId: null,
	buildServerId: null,
	rollbackActive: false,
	enableSubmodules: false,
	environmentId: "env-id",
	deployHooks: null,
	registryId: "registry-foreign",
	environment: {
		projectId: "project-id",
		env: "",
		name: "production",
		project: { name: "Test Project", organizationId: "org-id", env: "" },
	},
	domains: [],
};

const loggedMessages = () =>
	vi
		.mocked(execProcess.execAsync)
		.mock.calls.map(([command]) => command)
		.flatMap((command) => {
			const encoded = /echo "([^"]+)" \| base64 -d/.exec(command);
			return encoded
				? [Buffer.from(encoded[1] as string, "base64").toString()]
				: [];
		});

describe.each([
	["deployApplication", deployApplication],
	["rebuildApplication", rebuildApplication],
])("%s", (_name, run) => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(db.query.applications.findFirst).mockResolvedValue(app as any);
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			app as any,
		);
		vi.mocked(db.query.deployHook.findFirst).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(adminService.getDokployUrl).mockResolvedValue(
			"http://localhost:3000",
		);
		vi.mocked(deploymentService.createDeployment).mockResolvedValue({
			deploymentId: "deployment-id",
			logPath: LOG_PATH,
		} as any);
		vi.mocked(deploymentService.updateDeploymentStatus).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(deploymentService.updateDeployment).mockResolvedValue({} as any);
		vi.mocked(deploymentService.getDeploymentErrorMessage).mockResolvedValue(
			"error message",
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
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);
		vi.mocked(builders.getBuildCommand).mockResolvedValue("echo build");
		vi.mocked(assertDeployReferencesInOrganization).mockResolvedValue(
			undefined,
		);
	});

	const deploy = () =>
		run({ applicationId: "test-app-id", titleLog: "t", descriptionLog: "" });

	it("checks the row and fails closed: no build, the reason in the log, the deployment ends as error", async () => {
		vi.mocked(assertDeployReferencesInOrganization).mockRejectedValue(
			new TRPCError({ code: "FORBIDDEN", message: REFUSAL }),
		);

		await expect(deploy()).rejects.toThrow(REFUSAL);

		expect(assertDeployReferencesInOrganization).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "test-app-id",
				registryId: "registry-foreign",
			}),
		);
		expect(builders.getBuildCommand).not.toHaveBeenCalled();
		expect(loggedMessages()).toContain(REFUSAL);
		expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-id",
			"error",
		);
	});
});
