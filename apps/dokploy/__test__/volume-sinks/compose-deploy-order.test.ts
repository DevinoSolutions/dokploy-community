import { beforeEach, describe, expect, it, vi } from "vitest";

// A refused compose volume (T-6822) must stop every compose path before
// anything is built, torn down (`down --volumes` removes a non-external volume
// that carries `name:`) or started. The decision itself is in
// compose-volume-sink.test.ts; this pins where it is asked.
const mocks = vi.hoisted(() => ({
	assertComposeVolumesBound: vi.fn(),
	assertComposeFileOnDiskVolumesBound: vi.fn(),
	waitForComposeRequiredChecks: vi.fn().mockResolvedValue(undefined),
	execAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	getBuildComposeCommand: vi.fn().mockResolvedValue("docker compose up -d;"),
	getRestoreAfterFailedBuildCommand: vi.fn().mockResolvedValue("restore-files;"),
	getBackupCurrentDeploymentCommand: vi.fn(() => "backup-files;"),
	getRollbackMarkerProbeCommand: vi.fn(() => "true;"),
	getCreateComposeFileCommand: vi.fn().mockResolvedValue("write-raw-file;"),
	generateApplyPatchesCommand: vi.fn().mockResolvedValue(""),
	createDeploymentCompose: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	markDeploymentDoneUnlessCancelled: vi.fn(),
	existsSync: vi.fn(() => true),
}));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	existsSync: mocks.existsSync,
}));

vi.mock("@dokploy/server/services/compose-volume-binding", () => ({
	assertComposeVolumesBound: mocks.assertComposeVolumesBound,
	assertComposeFileOnDiskVolumesBound: mocks.assertComposeFileOnDiskVolumesBound,
}));

vi.mock("@dokploy/server/services/build-policy/compose-checks", () => ({
	waitForComposeRequiredChecks: mocks.waitForComposeRequiredChecks,
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
	getRestoreAfterFailedBuildCommand: mocks.getRestoreAfterFailedBuildCommand,
	getBackupCurrentDeploymentCommand: mocks.getBackupCurrentDeploymentCommand,
	getRollbackMarkerProbeCommand: mocks.getRollbackMarkerProbeCommand,
	getCreateEnvFileCommand: vi.fn(() => ""),
}));

vi.mock("@dokploy/server/utils/providers/raw", () => ({
	getCreateComposeFileCommand: mocks.getCreateComposeFileCommand,
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

vi.mock("@dokploy/server/services/deployment-cancel", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/deployment-cancel")
	>("@dokploy/server/services/deployment-cancel");
	return {
		...actual,
		markDeploymentDoneUnlessCancelled: mocks.markDeploymentDoneUnlessCancelled,
	};
});

import {
	deployCompose,
	rebuildCompose,
	startCompose,
} from "@dokploy/server/services/compose";

const COMPOSE = {
	composeId: "compose-1",
	appName: "sendly-stack",
	name: "Sendly Stack",
	sourceType: "github",
	composeType: "docker-compose",
	composePath: "./docker-compose.yml",
	githubId: "gh-1",
	owner: "DevinoSolutions",
	repository: "sendly",
	customGitUrl: null,
	serverId: null,
	domains: [],
	mounts: [],
	environment: { project: { organizationId: "org-1" } },
};

const REFUSAL = "Compose volume \"victim\" is refused: not yours";

const ran = () =>
	[...mocks.execAsync.mock.calls, ...mocks.execAsyncRemote.mock.calls]
		.map((call) => String(call[call.length - 1]))
		.join("\n");

const setCompose = async (overrides: Record<string, unknown> = {}) => {
	const { db } = await import("@dokploy/server/db");
	vi.mocked(db.query.compose.findFirst).mockResolvedValue({
		...COMPOSE,
		...overrides,
	} as any);
};

beforeEach(async () => {
	vi.clearAllMocks();
	mocks.assertComposeVolumesBound.mockResolvedValue(undefined);
	mocks.assertComposeFileOnDiskVolumesBound.mockResolvedValue(undefined);
	mocks.waitForComposeRequiredChecks.mockResolvedValue(undefined);
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.getBuildComposeCommand.mockResolvedValue("docker compose up -d;");
	mocks.getRestoreAfterFailedBuildCommand.mockResolvedValue("restore-files;");
	mocks.getCreateComposeFileCommand.mockResolvedValue("write-raw-file;");
	mocks.generateApplyPatchesCommand.mockResolvedValue("");
	mocks.markDeploymentDoneUnlessCancelled.mockResolvedValue(true);
	mocks.createDeploymentCompose.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "/var/log/dep-1.log",
	});
	await setCompose();
});

describe("a compose volume refusal stops the deploy before docker", () => {
	it("deploy of a fetched compose: refuses after the fetch, restores the previous files, never builds", async () => {
		mocks.assertComposeVolumesBound.mockRejectedValue(new Error(REFUSAL));

		await expect(
			deployCompose({ composeId: "compose-1", titleLog: "", descriptionLog: "" }),
		).rejects.toThrow(REFUSAL);

		expect(mocks.getBuildComposeCommand).not.toHaveBeenCalled();
		expect(mocks.waitForComposeRequiredChecks).not.toHaveBeenCalled();
		expect(mocks.getRestoreAfterFailedBuildCommand).toHaveBeenCalledTimes(1);
		expect(ran()).toContain("restore-files;");
		expect(ran()).not.toContain("down --volumes");
		// The refusal reaches the deployment log, like any other deploy error.
		expect(ran()).toContain("base64 -d >> \"/var/log/dep-1.log\"");
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
	});

	it("deploy of a raw compose: refuses before the file is written or backed up", async () => {
		await setCompose({ sourceType: "raw" });
		mocks.assertComposeVolumesBound.mockRejectedValue(new Error(REFUSAL));

		await expect(
			deployCompose({ composeId: "compose-1", titleLog: "", descriptionLog: "" }),
		).rejects.toThrow(REFUSAL);

		expect(mocks.getCreateComposeFileCommand).not.toHaveBeenCalled();
		expect(mocks.getBuildComposeCommand).not.toHaveBeenCalled();
		expect(ran()).not.toContain("backup-files;");
		expect(ran()).not.toContain("write-raw-file;");
		expect(mocks.getRestoreAfterFailedBuildCommand).not.toHaveBeenCalled();
	});

	it("freshVolumes deploy: refuses before `down --volumes`", async () => {
		mocks.assertComposeVolumesBound.mockRejectedValue(new Error(REFUSAL));

		await expect(
			deployCompose({
				composeId: "compose-1",
				titleLog: "",
				descriptionLog: "",
				freshVolumes: true,
			}),
		).rejects.toThrow(REFUSAL);

		expect(ran()).not.toContain("down --volumes");
	});

	it("redeploy of a fetched compose: refuses before the build and restores the files", async () => {
		mocks.assertComposeVolumesBound.mockRejectedValue(new Error(REFUSAL));

		await expect(
			rebuildCompose({ composeId: "compose-1", titleLog: "", descriptionLog: "" }),
		).rejects.toThrow(REFUSAL);

		expect(mocks.getBuildComposeCommand).not.toHaveBeenCalled();
		expect(mocks.waitForComposeRequiredChecks).not.toHaveBeenCalled();
		expect(ran()).toContain("restore-files;");
	});

	it("redeploy of a raw compose: refuses before the raw file is rewritten", async () => {
		await setCompose({ sourceType: "raw" });
		mocks.assertComposeVolumesBound.mockRejectedValue(new Error(REFUSAL));

		await expect(
			rebuildCompose({
				composeId: "compose-1",
				titleLog: "",
				descriptionLog: "",
				freshVolumes: true,
			}),
		).rejects.toThrow(REFUSAL);

		expect(mocks.getCreateComposeFileCommand).not.toHaveBeenCalled();
		expect(mocks.getBuildComposeCommand).not.toHaveBeenCalled();
		expect(ran()).not.toContain("down --volumes");
	});

	it("deploys normally when the volumes are the compose's own", async () => {
		await deployCompose({
			composeId: "compose-1",
			titleLog: "",
			descriptionLog: "",
		});

		expect(mocks.assertComposeVolumesBound).toHaveBeenCalledTimes(1);
		expect(mocks.getBuildComposeCommand).toHaveBeenCalledTimes(1);
		expect(mocks.getRestoreAfterFailedBuildCommand).not.toHaveBeenCalled();
	});
});

describe("Start runs the same check on the files on disk", () => {
	it("refuses a compose whose on-disk file mounts a foreign volume", async () => {
		mocks.assertComposeFileOnDiskVolumesBound.mockRejectedValue(
			new Error(REFUSAL),
		);
		await expect(startCompose("compose-1")).rejects.toThrow(REFUSAL);

		expect(ran()).not.toContain("up -d");
	});
});
