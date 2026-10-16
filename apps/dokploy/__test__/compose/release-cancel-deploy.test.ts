import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which deploy script of a build-server compose is run as a cancelable release
 * step, and how the deployment ends when a cancel stops it. Only the rolling
 * replace is: it has a trap that removes the replica it had not promoted. The
 * single `up` of any other deploy is sent exactly as before.
 */

const ROLLING_SCRIPT = "dokploy_roll_run() {\n  true;\n};\ndokploy_roll_run";
const PLAIN_SCRIPT = "docker compose up -d;";

const mocks = vi.hoisted(() => ({
	prepareComposeBuildServerDeploy: vi.fn(),
	waitForComposeRequiredChecks: vi.fn().mockResolvedValue(undefined),
	execAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	getBuildComposeCommand: vi.fn(),
	createDeploymentCompose: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updateCompose: vi.fn(),
	sendBuildErrorNotifications: vi.fn(),
	sendBuildSuccessNotifications: vi.fn(),
	isDeploymentCancelled: vi.fn(),
	statusAfterCancelledDeploy: vi.fn(),
	runReleaseScript: vi.fn(),
}));

vi.mock("@dokploy/server/services/compose-build-server", () => ({
	prepareComposeBuildServerDeploy: mocks.prepareComposeBuildServerDeploy,
}));
vi.mock("@dokploy/server/services/compose-registry-retention", () => ({
	pruneComposeBuildRegistry: vi.fn(),
}));
vi.mock("@dokploy/server/services/build-policy/compose-checks", () => ({
	waitForComposeRequiredChecks: mocks.waitForComposeRequiredChecks,
}));
vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: mocks.sendBuildErrorNotifications,
}));
vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: mocks.sendBuildSuccessNotifications,
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
	getBackupCurrentDeploymentCommand: vi.fn(() => "true;"),
	getRollbackMarkerProbeCommand: vi.fn(() => "true;"),
	getCreateEnvFileCommand: vi.fn(() => ""),
	getComposeBuildOverridePath: vi.fn(() => "/override.yml"),
}));
vi.mock("@dokploy/server/utils/providers/raw", () => ({
	getCreateComposeFileCommand: vi.fn().mockResolvedValue("true;"),
}));
vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: vi.fn().mockResolvedValue(""),
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
vi.mock("@dokploy/server/services/deployment-cancel", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/deployment-cancel")
	>("@dokploy/server/services/deployment-cancel");
	return {
		...actual,
		isDeploymentCancelled: mocks.isDeploymentCancelled,
		statusAfterCancelledDeploy: mocks.statusAfterCancelledDeploy,
		runReleaseScript: mocks.runReleaseScript,
	};
});

import {
	deployCompose,
	rebuildCompose,
	runComposeBuild,
} from "@dokploy/server/services/compose";
import { DeploymentCancelledError } from "@dokploy/server/services/deployment-cancel";

const COMPOSE = {
	composeId: "compose-1",
	appName: "stack",
	name: "Stack",
	sourceType: "raw",
	composeFile: "services: {}",
	env: "",
	composeType: "docker-compose",
	composePath: "./docker-compose.yml",
	serverId: null as string | null,
	buildServerId: "build-1" as string | null,
	buildRegistryId: "reg-1",
	domains: [],
	environment: {
		name: "prod",
		project: { name: "P", organizationId: "org-1" },
	},
};

const useCompose = async (overrides: Partial<typeof COMPOSE> = {}) => {
	const { db } = await import("@dokploy/server/db");
	vi.mocked(db.query.compose.findFirst).mockResolvedValue({
		...COMPOSE,
		...overrides,
	} as any);
};

const deploy = () =>
	deployCompose({
		composeId: "compose-1",
		titleLog: "Manual deployment",
		descriptionLog: "",
	});

const rebuild = () =>
	rebuildCompose({
		composeId: "compose-1",
		titleLog: "Rebuild deployment",
		descriptionLog: "",
	});

const statuses = () => ({
	deployment: mocks.updateDeploymentStatus.mock.calls.map((call) => call[1]),
	compose: mocks.updateCompose.mock.calls
		.map((call) => (call[1] as { composeStatus?: string }).composeStatus)
		.filter(Boolean),
});

const logged = () =>
	[
		...mocks.execAsync.mock.calls.map((call) => String(call[0])),
		...mocks.execAsyncRemote.mock.calls.map((call) => String(call[1])),
	].join("\n");

beforeEach(async () => {
	vi.clearAllMocks();
	mocks.execAsync.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote
		.mockReset()
		.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.getBuildComposeCommand.mockResolvedValue(ROLLING_SCRIPT);
	mocks.runReleaseScript.mockResolvedValue(undefined);
	mocks.prepareComposeBuildServerDeploy.mockResolvedValue({
		images: [],
		servingHostLabel: "the Dokploy host",
	});
	mocks.isDeploymentCancelled.mockResolvedValue(false);
	mocks.statusAfterCancelledDeploy.mockResolvedValue("done");
	mocks.createDeploymentCompose.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "/var/log/dep-1.log",
	});
	await useCompose();
	const { db } = await import("@dokploy/server/db");
	vi.mocked(db.update).mockImplementation((() => {
		const chain: any = {
			set: (values: unknown) => {
				mocks.updateCompose("compose", values);
				return chain;
			},
			where: () => chain,
			returning: () => Promise.resolve([{}]),
		};
		return chain;
	}) as any);
});

describe("the deploy script of a build-server compose", () => {
	it("deployCompose runs a rolling replace as a cancelable release step on the serving host", async () => {
		await useCompose({ serverId: "serving-1" });

		await deploy();

		expect(mocks.runReleaseScript).toHaveBeenCalledTimes(1);
		const [arg] = mocks.runReleaseScript.mock.calls[0] ?? [];
		expect(arg.serverId).toBe("serving-1");
		expect(arg.deploymentId).toBe("dep-1");
		expect(arg.command).toBe(
			`(set -e;${ROLLING_SCRIPT}) >> /var/log/dep-1.log 2>&1`,
		);
		// It is not also sent as an ordinary command.
		expect(
			mocks.execAsyncRemote.mock.calls.some((call) =>
				String(call[1]).includes("dokploy_roll_run"),
			),
		).toBe(false);
	});

	it("a compose without a server runs it on the Dokploy host (serverId null)", async () => {
		await deploy();

		expect(mocks.runReleaseScript).toHaveBeenCalledTimes(1);
		expect(mocks.runReleaseScript.mock.calls[0]?.[0].serverId).toBeNull();
	});

	it("rebuildCompose does the same", async () => {
		await rebuild();

		expect(mocks.runReleaseScript).toHaveBeenCalledTimes(1);
		expect(mocks.runReleaseScript.mock.calls[0]?.[0]).toMatchObject({
			serverId: null,
			deploymentId: "dep-1",
		});
	});

	it("a plain up (no rolled service) is sent exactly as before", async () => {
		mocks.getBuildComposeCommand.mockResolvedValue(PLAIN_SCRIPT);

		await deploy();

		expect(mocks.runReleaseScript).not.toHaveBeenCalled();
		expect(
			mocks.execAsync.mock.calls.some((call) =>
				String(call[0]).includes("docker compose up -d"),
			),
		).toBe(true);
	});

	it("a compose that builds on its serving host is not touched", async () => {
		await useCompose({ buildServerId: null, buildRegistryId: null as any });

		await deploy();

		expect(mocks.runReleaseScript).not.toHaveBeenCalled();
	});

	it("a deployment that cannot be cancelled (a preview) runs it as before", async () => {
		await runComposeBuild(
			{ ...COMPOSE, type: "compose" } as any,
			{ logPath: "/var/log/dep-1.log", deploymentId: "dep-1" },
			{ cancellable: false },
		);

		expect(mocks.runReleaseScript).not.toHaveBeenCalled();
		expect(
			mocks.execAsync.mock.calls.some((call) =>
				String(call[0]).includes("dokploy_roll_run"),
			),
		).toBe(true);
	});
});

describe("a cancel that stops the rolling replace", () => {
	const stopped = () =>
		mocks.runReleaseScript.mockRejectedValue(
			new DeploymentCancelledError(undefined, { duringRelease: true }),
		);

	it("ends as cancelled, not error, with no notification, and the service settles", async () => {
		stopped();
		mocks.isDeploymentCancelled.mockResolvedValue(true);

		const outcome = await deploy().catch((error) => error);

		expect(outcome).toMatchObject({ deploymentCancelled: true });
		expect(statuses().deployment).not.toContain("error");
		expect(statuses().deployment).not.toContain("done");
		expect(statuses().compose).toContain("done");
		expect(statuses().compose).not.toContain("error");
		expect(mocks.sendBuildErrorNotifications).not.toHaveBeenCalled();
		expect(mocks.sendBuildSuccessNotifications).not.toHaveBeenCalled();
	});

	it("rebuildCompose ends the same way", async () => {
		stopped();
		mocks.isDeploymentCancelled.mockResolvedValue(true);

		const outcome = await rebuild().catch((error) => error);

		expect(outcome).toMatchObject({ deploymentCancelled: true });
		expect(statuses().deployment).not.toContain("error");
		expect(mocks.sendBuildErrorNotifications).not.toHaveBeenCalled();
	});

	it("the log does not claim nothing was started: a release was in progress", async () => {
		stopped();
		mocks.isDeploymentCancelled.mockResolvedValue(true);

		await deploy().catch(() => {});

		const log = logged();
		expect(log).toContain("The release step was stopped");
		expect(log).toContain(
			"services it had already replaced stay on the new release",
		);
		expect(log).not.toContain("Nothing was pulled or started");
	});

	it("a cancel during the build keeps its own wording", async () => {
		mocks.prepareComposeBuildServerDeploy.mockRejectedValue(
			new DeploymentCancelledError(),
		);
		mocks.isDeploymentCancelled.mockResolvedValue(true);

		await deploy().catch(() => {});

		const log = logged();
		expect(log).toContain("Nothing was pulled or started from this build");
		expect(log).not.toContain("The release step was stopped");
	});

	it("a rolling replace that failed on its own is still an error with a notification", async () => {
		mocks.runReleaseScript.mockRejectedValue(
			new Error("Rolling replace failed"),
		);

		await expect(deploy()).rejects.toThrow("Rolling replace failed");

		expect(statuses().deployment).toContain("error");
		expect(mocks.sendBuildErrorNotifications).toHaveBeenCalledTimes(1);
	});
});
