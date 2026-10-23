import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A compose deploy and a compose redeploy re-check the organization of every
// registry, git provider and SSH key the row points at, before anything is
// cloned, torn down or built (T-6902). The check itself is covered in
// deploy-references.test.ts; here it is refused on purpose and the pipeline has
// to stop with the reason in the deployment log.
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
} from "@dokploy/server/services/compose";
import { assertDeployReferencesInOrganization } from "@dokploy/server/services/service-reference-scope";

const COMPOSE = {
	composeId: "compose-1",
	appName: "stack",
	name: "Stack",
	sourceType: "github",
	composeType: "docker-compose",
	composePath: "./docker-compose.yml",
	githubId: "gh-foreign",
	buildRegistryId: "reg-1",
	owner: "me",
	repository: "repo",
	customGitUrl: null,
	serverId: null,
	environment: { project: { organizationId: "org-1" } },
};

const REFUSAL =
	"Deployment refused: the GitHub provider set on this service does not belong to its organization.";

const loggedMessages = () =>
	[...mocks.execAsync.mock.calls, ...mocks.execAsyncRemote.mock.calls]
		.map((call) => String(call[call.length - 1]))
		.flatMap((command) => {
			const encoded = /echo "([^"]+)" \| base64 -d/.exec(command);
			return encoded
				? [Buffer.from(encoded[1] as string, "base64").toString()]
				: [];
		});

describe.each([
	["deployCompose", deployCompose],
	["rebuildCompose", rebuildCompose],
])("%s", (_name, run) => {
	beforeEach(async () => {
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
		const { db } = await import("@dokploy/server/db");
		vi.mocked(db.query.compose.findFirst).mockResolvedValue(COMPOSE as never);
		vi.mocked(assertDeployReferencesInOrganization).mockResolvedValue(
			undefined,
		);
	});

	const deploy = () =>
		run({ composeId: "compose-1", titleLog: "Deploy", descriptionLog: "" });

	it("checks the compose row it is about to deploy", async () => {
		await deploy().catch(() => undefined);

		expect(assertDeployReferencesInOrganization).toHaveBeenCalledWith(
			expect.objectContaining({
				composeId: "compose-1",
				githubId: "gh-foreign",
				buildRegistryId: "reg-1",
			}),
		);
	});

	it("fails closed: nothing is built, the reason is in the log and the deployment errors", async () => {
		vi.mocked(assertDeployReferencesInOrganization).mockRejectedValue(
			new TRPCError({ code: "FORBIDDEN", message: REFUSAL }),
		);

		await expect(deploy()).rejects.toThrow(REFUSAL);

		expect(mocks.getBuildComposeCommand).not.toHaveBeenCalled();
		expect(loggedMessages()).toContain(REFUSAL);
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		const ran = [
			...mocks.execAsync.mock.calls,
			...mocks.execAsyncRemote.mock.calls,
		]
			.map((call) => String(call[call.length - 1]))
			.join("\n");
		expect(ran).not.toContain("clone");
		expect(ran).not.toContain("down --volumes");
	});
});
