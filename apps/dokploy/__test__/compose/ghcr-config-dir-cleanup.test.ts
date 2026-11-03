import { beforeEach, describe, expect, it, vi } from "vitest";

// A stack that follows GitHub Deployments logs in to ghcr.io in a docker config
// dir of its own (the dir holds the GitHub token). The dir is deleted as soon
// as the pull / up that used it has ended, whether it worked or not, and not
// only when the watch or the connection is removed (T-12166).
const mocks = vi.hoisted(() => ({
	order: [] as string[],
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	getBuildComposeCommand: vi.fn(),
	getBackupCurrentDeploymentCommand: vi.fn(() => "true;"),
	getRollbackMarkerProbeCommand: vi.fn(() => "true;"),
	generateApplyPatchesCommand: vi.fn().mockResolvedValue(""),
	createDeploymentCompose: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	markDeploymentDoneUnlessCancelled: vi.fn(),
	prepareComposeBuildServerDeploy: vi.fn(),
	loginGhcrForCompose: vi.fn(),
	removeGhcrConfigDir: vi.fn(),
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

vi.mock("@dokploy/server/services/github-deployments/registry-auth", () => ({
	loginGhcrForCompose: mocks.loginGhcrForCompose,
	removeGhcrConfigDir: mocks.removeGhcrConfigDir,
}));

import { db } from "@dokploy/server/db";
import {
	deployCompose,
	rebuildCompose,
} from "@dokploy/server/services/compose";

const DIR = "/etc/dokploy/docker-config/ghcr-w1";

const raw = {
	composeId: "compose-1",
	appName: "stack",
	name: "Stack",
	sourceType: "raw",
	composeType: "docker-compose",
	composeFile: "services:\n  web:\n    image: ghcr.io/acme/web@sha256:abc\n",
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

beforeEach(() => {
	vi.clearAllMocks();
	mocks.order.length = 0;
	const chain: Record<string, unknown> = {};
	chain.set = () => chain;
	chain.where = () => chain;
	chain.returning = () => Promise.resolve([{}]);
	// biome-ignore lint/suspicious/noThenProperty: a thenable stands in for the awaited query
	chain.then = (resolve: (value: unknown) => void) => resolve([]);
	vi.mocked(db.update).mockImplementation((() => chain) as never);
	vi.mocked(db.query.compose.findFirst).mockResolvedValue(raw as never);
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsync.mockImplementation(async (command) => {
		if (String(command).includes("docker compose up")) {
			mocks.order.push("up");
		}
		return { stdout: "", stderr: "" };
	});
	mocks.generateApplyPatchesCommand.mockResolvedValue("");
	mocks.markDeploymentDoneUnlessCancelled.mockResolvedValue(true);
	mocks.createDeploymentCompose.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "/var/log/dep-1.log",
	});
	mocks.prepareComposeBuildServerDeploy.mockResolvedValue(undefined);
	mocks.getBuildComposeCommand.mockResolvedValue("docker compose up -d;");
	mocks.loginGhcrForCompose.mockImplementation(async () => {
		mocks.order.push("login");
		return DIR;
	});
	mocks.removeGhcrConfigDir.mockImplementation(async () => {
		mocks.order.push("remove");
	});
});

describe.each([
	["deployCompose", deployCompose],
	["rebuildCompose", rebuildCompose],
])("%s with a GitHub Deployments login", (_name, run) => {
	const deploy = () =>
		run({ composeId: "compose-1", titleLog: "Deploy", descriptionLog: "" });

	it("logs in, uses the dir for the build command, then deletes it on the serving host", async () => {
		await deploy();

		expect(mocks.loginGhcrForCompose).toHaveBeenCalledWith(
			"compose-1",
			null,
			raw.composeFile,
		);
		expect(mocks.getBuildComposeCommand).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ dockerConfigDir: DIR }),
		);
		expect(mocks.removeGhcrConfigDir).toHaveBeenCalledTimes(1);
		expect(mocks.removeGhcrConfigDir).toHaveBeenCalledWith(DIR, null);
		// Deleted after the login, and after the command that used it ran.
		expect(mocks.order[0]).toBe("login");
		expect(mocks.order).toContain("up");
		expect(mocks.order.indexOf("up")).toBeLessThan(
			mocks.order.indexOf("remove"),
		);
		expect(mocks.order[mocks.order.length - 1]).toBe("remove");
	});

	it("deletes it when the deploy fails too", async () => {
		mocks.getBuildComposeCommand.mockRejectedValue(new Error("pull failed"));

		await expect(deploy()).rejects.toThrow("pull failed");

		expect(mocks.removeGhcrConfigDir).toHaveBeenCalledTimes(1);
		expect(mocks.removeGhcrConfigDir).toHaveBeenCalledWith(DIR, null);
	});

	it("deletes it when the pull / up itself fails", async () => {
		mocks.execAsync.mockImplementation(async (command) => {
			if (String(command).includes("docker compose up")) {
				throw new Error("up failed");
			}
			return { stdout: "", stderr: "" };
		});

		await expect(deploy()).rejects.toThrow();

		expect(mocks.removeGhcrConfigDir).toHaveBeenCalledWith(DIR, null);
	});

	it("has nothing to delete for a stack without a login", async () => {
		mocks.loginGhcrForCompose.mockResolvedValue(undefined);

		await deploy();

		expect(mocks.getBuildComposeCommand).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ dockerConfigDir: undefined }),
		);
		// The helper is told, and does nothing for an undefined dir.
		for (const call of mocks.removeGhcrConfigDir.mock.calls) {
			expect(call[0]).toBeUndefined();
		}
	});
});
