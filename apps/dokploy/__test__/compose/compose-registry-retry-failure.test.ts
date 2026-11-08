import { beforeEach, describe, expect, it, vi } from "vitest";

// A GitHub Actions release whose image the registry does not serve yet is retried by the connection poll
// (T-15783). While retries are left the failed attempt still ends its deployment row as `error`, but the stack
// is not marked broken and nobody is notified; the attempt with no retry left fails the way it always did.
const mocks = vi.hoisted(() => ({
	execAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	getBuildComposeCommand: vi.fn(),
	getBackupCurrentDeploymentCommand: vi.fn(() => "true;"),
	getRollbackMarkerProbeCommand: vi.fn(() => "true;"),
	generateApplyPatchesCommand: vi.fn().mockResolvedValue(""),
	createDeploymentCompose: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	markDeploymentDoneUnlessCancelled: vi.fn(),
	prepareComposeBuildServerDeploy: vi.fn(),
	sets: [] as Record<string, unknown>[],
}));

vi.mock("@dokploy/server/utils/process/execAsync", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/process/execAsync")
	>("@dokploy/server/utils/process/execAsync");
	return {
		...actual,
		execAsync: mocks.execAsync,
		execAsyncRemote: mocks.execAsyncRemote,
	};
});

vi.mock("@dokploy/server/utils/builders/compose", () => ({
	getBuildComposeCommand: mocks.getBuildComposeCommand,
	getBackupCurrentDeploymentCommand: mocks.getBackupCurrentDeploymentCommand,
	getRollbackMarkerProbeCommand: mocks.getRollbackMarkerProbeCommand,
	getCreateEnvFileCommand: vi.fn(() => ""),
}));

vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: mocks.generateApplyPatchesCommand,
}));

vi.mock("@dokploy/server/services/deployment", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/deployment")
	>("@dokploy/server/services/deployment");
	return {
		...actual,
		createDeploymentCompose: mocks.createDeploymentCompose,
		updateDeploymentStatus: mocks.updateDeploymentStatus,
	};
});

vi.mock("@dokploy/server/services/compose-build-server", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/compose-build-server")
	>("@dokploy/server/services/compose-build-server");
	return {
		...actual,
		prepareComposeBuildServerDeploy: mocks.prepareComposeBuildServerDeploy,
	};
});

vi.mock("@dokploy/server/services/deployment-cancel", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/deployment-cancel")
	>("@dokploy/server/services/deployment-cancel");
	return {
		...actual,
		markDeploymentDoneUnlessCancelled: mocks.markDeploymentDoneUnlessCancelled,
	};
});

vi.mock("@dokploy/server/services/gha-connect/store", () => ({
	findRegistryRetriesDone: vi.fn(),
}));

vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: vi.fn(),
}));

import { db } from "@dokploy/server/db";
import { deployCompose } from "@dokploy/server/services/compose";
import * as ghaStore from "@dokploy/server/services/gha-connect/store";
import * as notifications from "@dokploy/server/utils/notifications/build-error";

const TITLE = "GHA production aaaaaaaa [deployment #77]";
const DENIED =
	'Task rejected: Get "https://ghcr.io/v2/o/r/landing/manifests/sha256:a": denied: denied';

const raw = {
	composeId: "compose-1",
	appName: "stack",
	name: "Stack",
	sourceType: "raw",
	composeType: "docker-compose",
	composeFile: "services: {}",
	composePath: "./docker-compose.yml",
	env: "",
	serverId: null,
	buildServerId: null,
	environmentId: "env-1",
	environment: {
		environmentId: "env-1",
		projectId: "proj-1",
		name: "production",
		project: { projectId: "proj-1", name: "P", organizationId: "org-1" },
	},
	domains: [],
};

const composeStatuses = () =>
	mocks.sets.flatMap((set) =>
		"composeStatus" in set ? [set.composeStatus] : [],
	);

const prime = (title: string) => {
	vi.clearAllMocks();
	mocks.sets.length = 0;
	const chain: Record<string, unknown> = {};
	chain.set = (values: Record<string, unknown>) => {
		mocks.sets.push(values);
		return chain;
	};
	chain.where = () => chain;
	chain.returning = () => Promise.resolve([{}]);
	chain.then = (resolve: (value: unknown) => void) => resolve([]);
	vi.mocked(db.update).mockImplementation((() => chain) as never);
	vi.mocked(db.query.compose.findFirst).mockResolvedValue(raw as never);
	// db.query.* share one findFirst here, so statusAfterCancelledDeploy finds a row: "done".
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.generateApplyPatchesCommand.mockResolvedValue("");
	mocks.markDeploymentDoneUnlessCancelled.mockResolvedValue(true);
	mocks.createDeploymentCompose.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "/var/log/dep-1.log",
		title,
	});
	mocks.prepareComposeBuildServerDeploy.mockResolvedValue(undefined);
	mocks.getBuildComposeCommand.mockRejectedValue(
		new Error(`Container did not stay running after deployment: ${DENIED}`),
	);
};

const deploy = () =>
	deployCompose({
		composeId: "compose-1",
		titleLog: TITLE,
		descriptionLog: "",
	});

describe("deployCompose: a registry that refuses the image of a GitHub Actions release", () => {
	it.each([0, 3])(
		"with %s retries used: the row ends as error, the stack is not marked broken and nobody is notified",
		async (used) => {
			prime(TITLE);
			vi.mocked(ghaStore.findRegistryRetriesDone).mockResolvedValue(used);

			await expect(deploy()).rejects.toThrow("denied: denied");

			expect(ghaStore.findRegistryRetriesDone).toHaveBeenCalledWith(
				"compose-1",
				77,
			);
			expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
				"dep-1",
				"error",
			);
			expect(composeStatuses()).not.toContain("error");
			expect(composeStatuses().at(-1)).toBe("done");
			expect(notifications.sendBuildErrorNotifications).not.toHaveBeenCalled();
		},
	);

	it("with no retry left: the stack is handled as before", async () => {
		prime(TITLE);
		vi.mocked(ghaStore.findRegistryRetriesDone).mockResolvedValue(4);

		await expect(deploy()).rejects.toThrow("denied: denied");

		expect(composeStatuses()).toContain("error");
		expect(notifications.sendBuildErrorNotifications).toHaveBeenCalledTimes(1);
	});

	it("another failure is notified at once", async () => {
		prime(TITLE);
		mocks.getBuildComposeCommand.mockRejectedValue(new Error("boom"));
		vi.mocked(ghaStore.findRegistryRetriesDone).mockResolvedValue(0);

		await expect(deploy()).rejects.toThrow("boom");

		expect(composeStatuses()).toContain("error");
		expect(notifications.sendBuildErrorNotifications).toHaveBeenCalledTimes(1);
	});

	it("a deploy that is not a GitHub Actions release is never held back", async () => {
		prime("Manual deploy");
		vi.mocked(ghaStore.findRegistryRetriesDone).mockResolvedValue(0);

		await expect(deploy()).rejects.toThrow("denied: denied");

		expect(ghaStore.findRegistryRetriesDone).not.toHaveBeenCalled();
		expect(notifications.sendBuildErrorNotifications).toHaveBeenCalledTimes(1);
	});
});
