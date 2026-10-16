import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which deploy script of a compose is run as a cancelable release step, and
 * how the deployment ends when a cancel stops it. Only the rolling replace is,
 * with or without a build server: it has a trap that removes the replica it had
 * not promoted. The single `up` of any other deploy is sent exactly as before.
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
	assertDeploymentNotCancelled: vi.fn(),
	getRestoreAfterFailedBuildCommand: vi.fn(),
	cloneGitRepository: vi.fn(),
	generateApplyPatchesCommand: vi.fn(),
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
	getRestoreAfterFailedBuildCommand: mocks.getRestoreAfterFailedBuildCommand,
	getRollbackMarkerProbeCommand: vi.fn(() => "true;"),
	getCreateEnvFileCommand: vi.fn(() => ""),
	getComposeBuildOverridePath: vi.fn(() => "/override.yml"),
}));
vi.mock("@dokploy/server/utils/providers/raw", () => ({
	getCreateComposeFileCommand: vi.fn().mockResolvedValue("true;"),
}));
vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: mocks.generateApplyPatchesCommand,
}));
vi.mock("@dokploy/server/utils/providers/git", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/providers/git")
	>("@dokploy/server/utils/providers/git");
	return {
		...actual,
		cloneGitRepository: mocks.cloneGitRepository,
		getGitCommitInfo: vi.fn().mockResolvedValue(null),
	};
});
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
		assertDeploymentNotCancelled: mocks.assertDeploymentNotCancelled,
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
	rollingReplace: null as unknown,
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
	mocks.assertDeploymentNotCancelled.mockReset().mockResolvedValue(undefined);
	mocks.getRestoreAfterFailedBuildCommand.mockResolvedValue(
		"RESTORE_PREVIOUS;",
	);
	mocks.cloneGitRepository.mockResolvedValue("true;");
	mocks.generateApplyPatchesCommand.mockResolvedValue("");
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

	it("a rolling replace on a compose that builds on its serving host is a cancelable release step too", async () => {
		await useCompose({
			buildServerId: null,
			buildRegistryId: null as any,
			serverId: "serving-1",
		});

		await deploy();

		expect(mocks.runReleaseScript).toHaveBeenCalledTimes(1);
		const [arg] = mocks.runReleaseScript.mock.calls[0] ?? [];
		expect(arg).toMatchObject({ serverId: "serving-1", deploymentId: "dep-1" });
		expect(arg.command).toBe(
			`(set -e;${ROLLING_SCRIPT}) >> /var/log/dep-1.log 2>&1`,
		);
		expect(
			mocks.execAsyncRemote.mock.calls.some((call) =>
				String(call[1]).includes("dokploy_roll_run"),
			),
		).toBe(false);
	});

	it("rebuildCompose does the same without a build server", async () => {
		await useCompose({ buildServerId: null, buildRegistryId: null as any });

		await rebuild();

		expect(mocks.runReleaseScript).toHaveBeenCalledTimes(1);
		expect(mocks.runReleaseScript.mock.calls[0]?.[0].serverId).toBeNull();
	});

	it("a plain up on a compose that builds on its serving host is sent exactly as before", async () => {
		await useCompose({ buildServerId: null, buildRegistryId: null as any });
		mocks.getBuildComposeCommand.mockResolvedValue(PLAIN_SCRIPT);

		await deploy();

		expect(mocks.runReleaseScript).not.toHaveBeenCalled();
		expect(
			mocks.execAsync.mock.calls.some((call) =>
				String(call[0]).includes("docker compose up -d"),
			),
		).toBe(true);
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

describe("the end of a deploy honours a cancel only where a cancel can happen", () => {
	const rollingSettings = {
		enabled: true,
		services: ["web"],
		healthTimeoutSeconds: 60,
		drainSeconds: 0,
	};

	it("a compose with a rolling replace and no build server does not overwrite a cancel with done", async () => {
		await useCompose({
			buildServerId: null,
			buildRegistryId: null as any,
			rollingReplace: rollingSettings as any,
		});

		await deploy();

		expect(statuses().deployment).not.toContain("done");
	});

	it("a compose that never rolls keeps the plain done update", async () => {
		await useCompose({ buildServerId: null, buildRegistryId: null as any });

		await deploy();

		expect(statuses().deployment).toContain("done");
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
			"services it had already updated stay on the new release",
		);
		expect(log).not.toContain("Nothing was pulled or started");
	});

	it("a compose without a build server ends the same way", async () => {
		await useCompose({ buildServerId: null, buildRegistryId: null as any });
		stopped();
		mocks.isDeploymentCancelled.mockResolvedValue(true);

		const outcome = await deploy().catch((error) => error);

		expect(outcome).toMatchObject({ deploymentCancelled: true });
		expect(statuses().deployment).not.toContain("error");
		expect(statuses().deployment).not.toContain("done");
		expect(statuses().compose).toContain("done");
		expect(mocks.sendBuildErrorNotifications).not.toHaveBeenCalled();
		expect(logged()).toContain("The release step was stopped");
	});

	it("does not say a step is let finish when the release step had to be killed", async () => {
		mocks.runReleaseScript.mockRejectedValue(
			new DeploymentCancelledError(undefined, {
				duringRelease: true,
				releaseKilled: true,
			}),
		);
		mocks.isDeploymentCancelled.mockResolvedValue(true);

		const outcome = await deploy().catch((error) => error);

		expect(outcome).toMatchObject({ deploymentCancelled: true });
		const log = logged();
		expect(log).toContain("did not finish its cancel cleanup within 20s");
		expect(log).toContain("was killed");
		expect(log).toContain("may still be running on its own");
		expect(log).not.toContain("is let finish");
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

describe("a cancel before the release step of a rolling compose without a build server (T-2721)", () => {
	const rollingSettings = {
		enabled: true,
		services: ["web"],
		healthTimeoutSeconds: 60,
		drainSeconds: 0,
	};
	const rollingNoBuildServer = (overrides: Partial<typeof COMPOSE> = {}) =>
		useCompose({
			buildServerId: null,
			buildRegistryId: null as any,
			rollingReplace: rollingSettings as any,
			...overrides,
		});

	/** The cancel lands during a step: the check after it (the nth) throws. */
	const cancelAtCheck = (nth: number) => {
		let calls = 0;
		mocks.assertDeploymentNotCancelled.mockImplementation(async () => {
			calls++;
			if (calls >= nth) {
				throw new DeploymentCancelledError(
					"Deployment cancelled: nothing more will be built, pushed or deployed.",
				);
			}
		});
	};

	const runBuild = (overrides: Record<string, unknown> = {}, options = {}) =>
		runComposeBuild(
			{ ...COMPOSE, type: "compose", ...overrides } as any,
			{ logPath: "/var/log/dep-1.log", deploymentId: "dep-1" },
			options,
		);

	const ranCommands = () => [
		...mocks.execAsync.mock.calls.map((call) => String(call[0])),
		...mocks.execAsyncRemote.mock.calls.map((call) => String(call[1])),
	];

	const rollingGit = {
		buildServerId: null,
		buildRegistryId: null,
		rollingReplace: rollingSettings,
		sourceType: "git",
	};

	it("a cancel during the clone stops the deploy before the patches and the release step", async () => {
		// Checks: before the backup (1), after the clone (2).
		cancelAtCheck(2);

		await expect(runBuild(rollingGit)).rejects.toMatchObject({
			deploymentCancelled: true,
		});

		expect(mocks.cloneGitRepository).toHaveBeenCalledTimes(1);
		// The clone replaced the compose file: the previous release's are put back.
		expect(mocks.getRestoreAfterFailedBuildCommand).toHaveBeenCalledTimes(1);
		expect(
			mocks.getRestoreAfterFailedBuildCommand.mock.calls[0]?.[1],
		).toMatchObject({
			deploymentId: "dep-1",
		});
		expect(
			ranCommands().filter((c) => c.includes("RESTORE_PREVIOUS;")),
		).toHaveLength(1);
		expect(mocks.generateApplyPatchesCommand).not.toHaveBeenCalled();
		expect(mocks.getBuildComposeCommand).not.toHaveBeenCalled();
		expect(mocks.runReleaseScript).not.toHaveBeenCalled();
	});

	it("a cancel during the patches stops the deploy before the release step", async () => {
		cancelAtCheck(3);

		await expect(runBuild(rollingGit)).rejects.toMatchObject({
			deploymentCancelled: true,
		});

		expect(mocks.generateApplyPatchesCommand).toHaveBeenCalledTimes(1);
		expect(mocks.getBuildComposeCommand).not.toHaveBeenCalled();
		expect(mocks.runReleaseScript).not.toHaveBeenCalled();
	});

	it("a cancel while the required checks are awaited stops it before the release step too", async () => {
		cancelAtCheck(4);

		await expect(runBuild(rollingGit)).rejects.toMatchObject({
			deploymentCancelled: true,
		});

		expect(mocks.waitForComposeRequiredChecks).toHaveBeenCalledTimes(1);
		expect(mocks.runReleaseScript).not.toHaveBeenCalled();
	});

	it("a cancel while the compose file of a raw compose is written stops it", async () => {
		cancelAtCheck(2);

		await expect(
			runBuild({
				buildServerId: null,
				buildRegistryId: null,
				rollingReplace: rollingSettings,
			}),
		).rejects.toMatchObject({ deploymentCancelled: true });

		expect(mocks.runReleaseScript).not.toHaveBeenCalled();
	});

	it("deployCompose ends a cancel during the clone as cancelled, not error, with no notification", async () => {
		await rollingNoBuildServer();
		cancelAtCheck(2);

		const outcome = await deploy().catch((error) => error);

		expect(outcome).toMatchObject({ deploymentCancelled: true });
		expect(statuses().deployment).not.toContain("error");
		expect(statuses().deployment).not.toContain("done");
		// The previous release keeps serving.
		expect(statuses().compose).toContain("done");
		expect(statuses().compose).not.toContain("error");
		expect(mocks.sendBuildErrorNotifications).not.toHaveBeenCalled();
		expect(mocks.sendBuildSuccessNotifications).not.toHaveBeenCalled();
		expect(mocks.runReleaseScript).not.toHaveBeenCalled();
		expect(logged()).toContain("Nothing was pulled or started from this build");
	});

	it("rebuildCompose ends a cancel during the patches the same way", async () => {
		await rollingNoBuildServer({ sourceType: "git" });
		// Checks: start (1), after the compose file (2), after the patches (3).
		cancelAtCheck(3);

		const outcome = await rebuild().catch((error) => error);

		expect(outcome).toMatchObject({ deploymentCancelled: true });
		expect(mocks.generateApplyPatchesCommand).toHaveBeenCalledTimes(1);
		expect(statuses().deployment).not.toContain("error");
		expect(statuses().deployment).not.toContain("done");
		expect(mocks.sendBuildErrorNotifications).not.toHaveBeenCalled();
		expect(mocks.runReleaseScript).not.toHaveBeenCalled();
	});

	it("a deploy nobody cancelled still reaches the release step", async () => {
		await rollingNoBuildServer();

		await deploy();

		expect(mocks.assertDeploymentNotCancelled).toHaveBeenCalled();
		expect(mocks.runReleaseScript).toHaveBeenCalledTimes(1);
		expect(statuses().deployment).not.toContain("error");
	});

	it("a cancel after the release started is the release launcher's, with its own wording (unchanged)", async () => {
		await rollingNoBuildServer();
		mocks.runReleaseScript.mockRejectedValue(
			new DeploymentCancelledError(undefined, { duringRelease: true }),
		);
		mocks.isDeploymentCancelled.mockResolvedValue(true);

		const outcome = await deploy().catch((error) => error);

		expect(outcome).toMatchObject({ deploymentCancelled: true });
		expect(logged()).toContain("The release step was stopped");
		expect(logged()).not.toContain("Nothing was pulled or started");
	});

	it("checks nothing for a build-server compose (its prepare step has its own checkpoints)", async () => {
		await useCompose({ rollingReplace: rollingSettings as any });

		await deploy();

		expect(mocks.assertDeploymentNotCancelled).not.toHaveBeenCalled();
		expect(mocks.prepareComposeBuildServerDeploy).toHaveBeenCalledTimes(1);
	});

	it("checks nothing for a compose without a rolling replace", async () => {
		await useCompose({ buildServerId: null, buildRegistryId: null as any });

		await deploy();

		expect(mocks.assertDeploymentNotCancelled).not.toHaveBeenCalled();
	});

	it("checks nothing for a deployment that cannot be cancelled (a preview)", async () => {
		await runBuild(rollingGit, { cancellable: false });

		expect(mocks.assertDeploymentNotCancelled).not.toHaveBeenCalled();
	});

	it("a cancel before anything was written restores nothing", async () => {
		cancelAtCheck(1);

		await expect(runBuild(rollingGit)).rejects.toMatchObject({
			deploymentCancelled: true,
		});

		expect(mocks.cloneGitRepository).not.toHaveBeenCalled();
		expect(mocks.getRestoreAfterFailedBuildCommand).not.toHaveBeenCalled();
	});

	it("a cancel during the patches restores the previous release too", async () => {
		cancelAtCheck(3);

		await expect(runBuild(rollingGit)).rejects.toMatchObject({
			deploymentCancelled: true,
		});

		expect(
			ranCommands().filter((c) => c.includes("RESTORE_PREVIOUS;")),
		).toHaveLength(1);
	});

	it("a restore that cannot run turns the cancel into an error that says so", async () => {
		cancelAtCheck(2);
		mocks.getRestoreAfterFailedBuildCommand.mockRejectedValue(
			new Error("vault unreachable"),
		);

		await expect(runBuild(rollingGit)).rejects.toThrow(
			/could not be restored \(vault unreachable\)/,
		);
	});

	it("a cancel just before the plain up stops it: the up is not run and the deploy ends as cancelled", async () => {
		await rollingNoBuildServer();
		mocks.getBuildComposeCommand.mockResolvedValue(PLAIN_SCRIPT);
		// Raw compose: start (1), after the write (2), required checks (3),
		// before the down (4), after the deploy command is built (5).
		cancelAtCheck(5);

		const outcome = await deploy().catch((error) => error);

		expect(outcome).toMatchObject({ deploymentCancelled: true });
		expect(ranCommands().some((c) => c.includes("docker compose up -d"))).toBe(
			false,
		);
		expect(mocks.runReleaseScript).not.toHaveBeenCalled();
		expect(
			ranCommands().filter((c) => c.includes("RESTORE_PREVIOUS;")),
		).toHaveLength(1);
		expect(statuses().deployment).not.toContain("error");
		expect(statuses().deployment).not.toContain("done");
		expect(statuses().compose).toContain("done");
		expect(mocks.sendBuildErrorNotifications).not.toHaveBeenCalled();
	});

	it("rebuildCompose does not run the plain up after a cancel either", async () => {
		await rollingNoBuildServer();
		mocks.getBuildComposeCommand.mockResolvedValue(PLAIN_SCRIPT);
		cancelAtCheck(5);

		const outcome = await rebuild().catch((error) => error);

		expect(outcome).toMatchObject({ deploymentCancelled: true });
		expect(ranCommands().some((c) => c.includes("docker compose up -d"))).toBe(
			false,
		);
		expect(statuses().deployment).not.toContain("error");
		expect(statuses().deployment).not.toContain("done");
		expect(mocks.sendBuildErrorNotifications).not.toHaveBeenCalled();
	});

	it("the build-server path restores through its own prepare step, not this one", async () => {
		await useCompose({ rollingReplace: rollingSettings as any });
		mocks.prepareComposeBuildServerDeploy.mockRejectedValue(
			new DeploymentCancelledError(),
		);
		mocks.isDeploymentCancelled.mockResolvedValue(true);

		const outcome = await deploy().catch((error) => error);

		expect(outcome).toMatchObject({ deploymentCancelled: true });
		expect(mocks.assertDeploymentNotCancelled).not.toHaveBeenCalled();
		expect(mocks.getRestoreAfterFailedBuildCommand).not.toHaveBeenCalled();
	});
});
