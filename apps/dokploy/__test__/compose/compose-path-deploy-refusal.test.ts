import { beforeEach, describe, expect, it, vi } from "vitest";

// A compose path stored before the compose path rules (T-8238) is checked
// again when the compose is deployed, rebuilt or started: an unsafe one stops
// the run before anything is fetched, copied or started, with the reason in
// the deployment log.
const mocks = vi.hoisted(() => ({
	execAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	getBuildComposeCommand: vi.fn().mockResolvedValue("docker compose up -d;"),
	getBackupCurrentDeploymentCommand: vi.fn(() => "true;"),
	getRollbackMarkerProbeCommand: vi.fn(() => "true;"),
	generateApplyPatchesCommand: vi.fn().mockResolvedValue(""),
	createDeploymentCompose: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	markDeploymentDoneUnlessCancelled: vi.fn(),
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

const compose = (composePath: string, serverId: string | null = null) => ({
	composeId: "compose-1",
	appName: "stack",
	name: "Stack",
	sourceType: "github",
	composeType: "docker-compose",
	composePath,
	owner: "me",
	repository: "repo",
	customGitUrl: null,
	serverId,
	environment: { project: { organizationId: "org-1" } },
});

const UNSAFE = [
	["a semicolon", "deploy/x.yml;y.yml"],
	["a dollar sign", "$(x).yml"],
	["a line break", "x.yml\ny.yml"],
	["a parent directory", "../other-app/code/docker-compose.yml"],
	[
		"an absolute path",
		"/etc/dokploy/compose/other-app/code/docker-compose.yml",
	],
] as const;

const ran = () =>
	[...mocks.execAsync.mock.calls, ...mocks.execAsyncRemote.mock.calls].map(
		(call) => String(call[call.length - 1]),
	);

const loggedMessages = () =>
	ran().flatMap((command) => {
		const encoded = /echo "([^"]+)" \| base64 -d/.exec(command);
		return encoded
			? [Buffer.from(encoded[1] as string, "base64").toString()]
			: [];
	});

const useCompose = async (row: ReturnType<typeof compose>) => {
	const { db } = await import("@dokploy/server/db");
	vi.mocked(db.query.compose.findFirst).mockResolvedValue(row as never);
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.getBuildComposeCommand.mockResolvedValue("docker compose up -d;");
	mocks.generateApplyPatchesCommand.mockResolvedValue("");
	mocks.markDeploymentDoneUnlessCancelled.mockResolvedValue(true);
	mocks.createDeploymentCompose.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "/var/log/dep-1.log",
	});
});

describe.each([
	["deployCompose", deployCompose],
	["rebuildCompose", rebuildCompose],
])("%s", (_name, run) => {
	const deploy = () =>
		run({ composeId: "compose-1", titleLog: "Deploy", descriptionLog: "" });

	describe.each(UNSAFE)("a stored compose path with %s", (_what, path) => {
		it.each([
			["this host", null],
			["a remote server", "server-1"],
		])("is refused on %s before anything runs", async (_host, serverId) => {
			await useCompose(compose(path, serverId));

			await expect(deploy()).rejects.toThrow(/^Compose refused: /);

			// Nothing was snapshotted, fetched or built; the log says why.
			expect(mocks.getBackupCurrentDeploymentCommand).not.toHaveBeenCalled();
			expect(mocks.getBuildComposeCommand).not.toHaveBeenCalled();
			expect(mocks.generateApplyPatchesCommand).not.toHaveBeenCalled();
			expect(ran().join("\n")).not.toContain("clone");
			expect(ran().join("\n")).not.toContain(path);
			expect(
				loggedMessages().some((message) =>
					message.startsWith("Compose refused: the compose path"),
				),
			).toBe(true);
			expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
				"dep-1",
				"error",
			);
		});
	});

	it("goes on with an unusual but harmless stored path", async () => {
		await useCompose(compose("deploy/my stack [prod].yml"));

		await deploy().catch(() => undefined);

		// The snapshot comes right after the check.
		expect(mocks.getBackupCurrentDeploymentCommand).toHaveBeenCalled();
		expect(
			loggedMessages().some((message) =>
				message.startsWith("Compose refused: the compose path"),
			),
		).toBe(false);
	});
});

describe("startCompose", () => {
	it.each(UNSAFE)(
		"refuses a stored compose path with %s before anything runs",
		async (_what, path) => {
			await useCompose(compose(path, "server-1"));

			await expect(startCompose("compose-1")).rejects.toThrow(
				/^Compose refused: /,
			);
			expect(ran()).toEqual([]);
		},
	);
});
