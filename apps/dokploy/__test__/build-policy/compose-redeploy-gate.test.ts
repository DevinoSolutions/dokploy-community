import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Round-3 review finding H, the blocker.
 *
 * The compose `requiredChecks` gate added for round-2 finding A had exactly one
 * call site, inside `runComposeBuild`. `rebuildCompose` — the Redeploy button,
 * reached through `compose.redeploy` and the queue's `type: "redeploy"` arm —
 * has its own inlined pipeline and never called it, while the README table, the
 * `policy.ts` comment and the PR body all said compose gets `requiredChecks`
 * with no qualification.
 *
 * The two halves interact into a trap, which is why this is more than a stale
 * sentence. `runComposeBuild` clones **before** it gates, so a refused deploy
 * leaves the unchecked commit in the code directory. `rebuildCompose` does not
 * re-clone; it builds whatever is on disk. So: push a commit that fails the
 * check, the deploy is correctly refused, and then anyone clicking Redeploy
 * ships exactly the commit the gate just rejected — no check, no audit row, no
 * warning.
 *
 * The application path never had this hole: `rebuildApplication` calls the gate,
 * skips the clone because its command is still the bare prefix, re-reads the sha
 * from the existing checkout — the refused commit — and refuses again. These
 * tests pin the same property for compose.
 */

const mocks = vi.hoisted(() => ({
	waitForComposeRequiredChecks: vi.fn().mockResolvedValue(undefined),
	execAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	getBuildComposeCommand: vi.fn().mockResolvedValue("docker compose up -d;"),
	getBackupCurrentDeploymentCommand: vi.fn(() => "true;"),
	getRollbackMarkerProbeCommand: vi.fn(() => "true;"),
	generateApplyPatchesCommand: vi.fn().mockResolvedValue(""),
	createDeploymentCompose: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updateCompose: vi.fn(),
	composeFindFirst: vi.fn(),
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

import { rebuildCompose } from "@dokploy/server/services/compose";

const COMPOSE = {
	composeId: "compose-1",
	appName: "sendly-stack",
	name: "Sendly Stack",
	sourceType: "github",
	composeType: "docker-compose",
	composePath: "./docker-compose.yml",
	requiredChecks: ["build"],
	githubId: "gh-1",
	owner: "DevinoSolutions",
	repository: "sendly",
	customGitUrl: null,
	serverId: null,
	environment: { project: { organizationId: "org-1" } },
};

const rebuild = () =>
	rebuildCompose({
		composeId: "compose-1",
		titleLog: "Rebuild deployment",
		descriptionLog: "",
	});

describe("finding H — a compose redeploy is check-gated too", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		mocks.waitForComposeRequiredChecks.mockResolvedValue(undefined);
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.getBuildComposeCommand.mockResolvedValue("docker compose up -d;");
		mocks.generateApplyPatchesCommand.mockResolvedValue("");
		mocks.createDeploymentCompose.mockResolvedValue({
			deploymentId: "dep-1",
			logPath: "/var/log/dep-1.log",
		});
		const { db } = await import("@dokploy/server/db");
		vi.mocked(db.query.compose.findFirst).mockResolvedValue(COMPOSE as any);
	});

	it("consults the compose required-checks gate on a redeploy", async () => {
		await rebuild();

		expect(mocks.waitForComposeRequiredChecks).toHaveBeenCalledTimes(1);
		expect(mocks.waitForComposeRequiredChecks).toHaveBeenCalledWith(
			expect.objectContaining({
				compose: expect.objectContaining({ composeId: "compose-1" }),
				serverId: null,
			}),
		);
	});

	/**
	 * The trap the review described, end to end: the push was refused, the
	 * unchecked commit is sitting in the code directory, and Redeploy must not
	 * ship it.
	 */
	it("refuses the redeploy of a commit the push gate already rejected", async () => {
		mocks.waitForComposeRequiredChecks.mockRejectedValue(
			new Error("Required GitHub checks failed on org/repo@abc123: build"),
		);

		await expect(rebuild()).rejects.toThrow("Required GitHub checks failed");

		// The build command was never even assembled, let alone run.
		expect(mocks.getBuildComposeCommand).not.toHaveBeenCalled();
	});

	it("gates before the build step runs", async () => {
		const order: string[] = [];
		mocks.waitForComposeRequiredChecks.mockImplementation(async () => {
			order.push("gate");
		});
		mocks.getBuildComposeCommand.mockImplementation(async () => {
			order.push("build");
			return "docker compose up -d;";
		});

		await rebuild();

		expect(order).toEqual(["gate", "build"]);
	});

	/**
	 * Same placement rule as the deploy path: a refused check must not leave the
	 * stack torn down, so the gate runs ahead of `down --volumes`.
	 */
	it("gates before a freshVolumes teardown, so a refusal leaves the stack up", async () => {
		mocks.waitForComposeRequiredChecks.mockRejectedValue(
			new Error("Required GitHub checks failed"),
		);

		await expect(
			rebuildCompose({
				composeId: "compose-1",
				titleLog: "Rebuild deployment",
				descriptionLog: "",
				freshVolumes: true,
			}),
		).rejects.toThrow("Required GitHub checks failed");

		const ran = [
			...mocks.execAsync.mock.calls,
			...mocks.execAsyncRemote.mock.calls,
		]
			.map((call) => String(call[call.length - 1]))
			.join("\n");
		expect(ran).not.toContain("down --volumes");
	});

	it("runs the redeploy normally when the checks pass", async () => {
		await rebuild();

		expect(mocks.getBuildComposeCommand).toHaveBeenCalledTimes(1);
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "done");
	});
});
