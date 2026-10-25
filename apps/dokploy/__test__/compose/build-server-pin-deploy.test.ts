import { beforeEach, describe, expect, it, vi } from "vitest";

// T-7282: the deploy path reads the serving host's commit right after the
// fetch (a rebuild at its start), and hands the build server the very patch
// rows the serving host applied (and the guards checked), not a second read
// of the table.
// T-7960: a deploy that passed its checks records that commit, the build
// server and the patch rows on its deployment row, and a rebuild refuses
// unless the checkout on disk and those are still the same.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
const ROWS = [
	{
		patchId: "p1",
		filePath: "docker-compose.yml",
		content: "services: {}\n",
		type: "update",
		enabled: true,
	},
];

const mocks = vi.hoisted(() => ({
	order: [] as string[],
	prepareComposeBuildServerDeploy: vi.fn(),
	readServingHostCommitOutput: vi.fn(),
	generateApplyPatchesCommand: vi.fn(),
	assertComposeVolumesBound: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	createDeploymentCompose: vi.fn(),
	updateDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	findPatchesByEntityId: vi.fn(),
	waitForComposeRequiredChecks: vi.fn(),
	/** The compose's latest recording deployment row, as the db holds it. */
	recorded: null as Record<string, string | null> | null,
	/** What `updateCompose` wrote (`db.update(compose).set(...)`). */
	sets: [] as Record<string, unknown>[],
}));

vi.mock("@dokploy/server/services/compose-build-server", () => ({
	prepareComposeBuildServerDeploy: mocks.prepareComposeBuildServerDeploy,
	readServingHostCommitOutput: mocks.readServingHostCommitOutput,
}));
vi.mock("@dokploy/server/services/compose-registry-retention", () => ({
	pruneComposeBuildRegistry: vi.fn(),
}));
vi.mock("@dokploy/server/services/compose-policy-audit", () => ({
	runComposePolicyAudit: vi.fn(),
}));
vi.mock("@dokploy/server/services/compose-volume-binding", () => ({
	assertComposeVolumesBound: mocks.assertComposeVolumesBound,
	assertComposeFileOnDiskVolumesBound: vi.fn(),
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
vi.mock("@dokploy/server/utils/builders/compose", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/builders/compose")
	>("@dokploy/server/utils/builders/compose");
	return {
		...actual,
		getBuildComposeCommand: vi.fn().mockResolvedValue("echo up;"),
		getBackupCurrentDeploymentCommand: vi.fn(() => "true;"),
	};
});
vi.mock("@dokploy/server/utils/providers/git", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/providers/git")
	>("@dokploy/server/utils/providers/git");
	return { ...actual, cloneGitRepository: vi.fn(async () => "echo clone;") };
});
vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: mocks.generateApplyPatchesCommand,
	findPatchesByEntityId: mocks.findPatchesByEntityId,
}));
vi.mock("@dokploy/server/services/deployment", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/deployment")
	>("@dokploy/server/services/deployment");
	return {
		...actual,
		createDeploymentCompose: mocks.createDeploymentCompose,
		updateDeploymentStatus: mocks.updateDeploymentStatus,
		updateDeployment: mocks.updateDeployment,
	};
});

import {
	rebuildCompose,
	runComposeBuild,
} from "@dokploy/server/services/compose";
import { digestAppliedPatches } from "@dokploy/server/services/compose-rebuild-pin";

const COMPOSE = {
	composeId: "compose-1",
	appName: "stack",
	name: "Stack",
	sourceType: "git",
	customGitUrl: "https://git.example.com/acme/stack.git",
	customGitBranch: "main",
	composeFile: "",
	env: "",
	composeType: "docker-compose",
	composePath: "./docker-compose.yml",
	serverId: null,
	buildServerId: "build-1",
	buildRegistryId: "reg-1",
	rollingReplace: null,
	deployGuardrails: null,
	mounts: [],
	domains: [],
	environment: {
		name: "prod",
		env: "",
		project: { name: "P", env: "", organizationId: "org-1" },
	},
} as any;

const deployment = { logPath: "/var/log/dep-1.log", deploymentId: "dep-1" };
const prepareArgs = () =>
	mocks.prepareComposeBuildServerDeploy.mock.calls[0]?.[0] as Record<
		string,
		unknown
	>;
const step = (label: string) => mocks.order.indexOf(label);
const pinnedWrites = () =>
	mocks.updateDeployment.mock.calls.filter(
		([, data]) => (data as { pinnedCommit?: string })?.pinnedCommit,
	);
/** The messages the failure path wrote to the deployment log. */
const loggedErrors = () =>
	mocks.execAsync.mock.calls
		.map(([command]) => /echo "([A-Za-z0-9+/=]+)" \| base64 -d/.exec(command))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => Buffer.from(match[1] as string, "base64").toString("utf8"));
const rebuild = () =>
	rebuildCompose({
		composeId: "compose-1",
		titleLog: "Rebuild deployment",
		descriptionLog: "",
	});
/** What a deploy of `commit` that passed its checks records. */
const recordOf = (commit: string, rows: unknown[] = ROWS) => ({
	pinnedCommit: commit,
	pinnedBuildServerId: "build-1",
	pinnedPatchDigest: digestAppliedPatches(rows as never),
});
const composeStatuses = () =>
	mocks.sets.map((set) => set.composeStatus).filter(Boolean);
// The test db answers every table from one mock; the deployment lookup is the
// one that asks for `pinnedCommit`.
const answerQueries = async (composeRow: Record<string, unknown>) => {
	const { db } = await import("@dokploy/server/db");
	vi.mocked(db.query.compose.findFirst).mockImplementation((async (args?: {
		columns?: Record<string, boolean>;
	}) => {
		if (args?.columns?.pinnedCommit) {
			mocks.order.push("lookup");
			return mocks.recorded ?? undefined;
		}
		return composeRow;
	}) as never);
};

beforeEach(async () => {
	vi.clearAllMocks();
	mocks.order.length = 0;
	const record = async (command: string) => {
		if (command.includes("echo clone;")) mocks.order.push("clone");
		if (command.includes("echo patch;")) mocks.order.push("patch-step");
		return { stdout: "", stderr: "" };
	};
	mocks.execAsync.mockImplementation(record);
	mocks.execAsyncRemote.mockImplementation((_id: string, c: string) =>
		record(c),
	);
	mocks.readServingHostCommitOutput.mockImplementation(async () => {
		mocks.order.push("read");
		return `${SHA}\n`;
	});
	mocks.generateApplyPatchesCommand.mockImplementation(
		async (options: { onLoaded?: (rows: unknown[]) => void }) => {
			mocks.order.push("patches");
			options.onLoaded?.(ROWS);
			return "echo patch;";
		},
	);
	mocks.assertComposeVolumesBound.mockImplementation(async () => {
		mocks.order.push("guard");
	});
	mocks.prepareComposeBuildServerDeploy.mockImplementation(async () => {
		mocks.order.push("prepare");
		return undefined;
	});
	mocks.createDeploymentCompose.mockResolvedValue(deployment);
	mocks.findPatchesByEntityId.mockImplementation(async () => {
		mocks.order.push("patch-rows");
		return ROWS;
	});
	mocks.waitForComposeRequiredChecks.mockImplementation(async () => {
		mocks.order.push("required-checks");
	});
	// The db keeps what a deploy records, so a later rebuild reads it.
	mocks.updateDeployment.mockImplementation(
		async (_id: string, data: Record<string, string | null>) => {
			if (data.pinnedCommit) {
				mocks.order.push("record");
				mocks.recorded = { ...data };
			}
			return [];
		},
	);
	mocks.recorded = recordOf(SHA);
	mocks.sets.length = 0;
	const { db } = await import("@dokploy/server/db");
	vi.mocked(db.update).mockImplementation((() => {
		const chain = {
			set: (values: Record<string, unknown>) => {
				mocks.sets.push(values);
				return chain;
			},
			where: () => chain,
			returning: async () => [{}],
		};
		return chain;
	}) as never);
	await answerQueries(COMPOSE);
});

describe("deploy (runComposeBuild)", () => {
	it("reads the commit right after the fetch, and passes the applied rows", async () => {
		await runComposeBuild(COMPOSE, deployment);

		expect(step("clone")).toBeGreaterThanOrEqual(0);
		expect(step("clone")).toBeLessThan(step("read"));
		expect(step("read")).toBeLessThan(step("patches"));
		expect(step("patches")).toBeLessThan(step("patch-step"));
		expect(step("patch-step")).toBeLessThan(step("guard"));
		expect(step("guard")).toBeLessThan(step("prepare"));
		expect(mocks.readServingHostCommitOutput).toHaveBeenCalledTimes(1);
		expect(mocks.readServingHostCommitOutput).toHaveBeenCalledWith(
			expect.objectContaining({ appName: "stack", serverId: null }),
		);

		expect(prepareArgs()).toMatchObject({
			servingCommitOutput: `${SHA}\n`,
			patches: ROWS,
			applyPatches: true,
		});
		// The very array the serving host applied.
		expect(prepareArgs().patches).toBe(ROWS);
	});

	it("records the commit read before the patches, only once the checks passed", async () => {
		mocks.recorded = null;
		await runComposeBuild(COMPOSE, deployment);
		expect(pinnedWrites()).toEqual([["dep-1", recordOf(SHA)]]);
		expect(step("read")).toBeLessThan(step("patches"));
		expect(step("guard")).toBeLessThan(step("record"));
		expect(step("required-checks")).toBeLessThan(step("record"));
		expect(step("record")).toBeLessThan(step("prepare"));
	});

	it("records the commit of a compose served from a remote host", async () => {
		await runComposeBuild({ ...COMPOSE, serverId: "srv-1" }, deployment);
		expect(mocks.readServingHostCommitOutput).toHaveBeenCalledWith(
			expect.objectContaining({ appName: "stack", serverId: "srv-1" }),
		);
		expect(pinnedWrites()).toEqual([["dep-1", recordOf(SHA)]]);
	});

	it.each([
		["the compose guard", "guard"],
		["the required checks", "required-checks"],
	])(
		"records nothing when %s refuses the deploy, so the next rebuild is refused",
		async (_label, refuser) => {
			// An earlier deploy recorded OTHER; this one fetched SHA and is refused.
			mocks.recorded = recordOf(OTHER);
			const refusal = async () => {
				mocks.order.push(refuser);
				throw new Error("refused by the check");
			};
			if (refuser === "guard") {
				mocks.assertComposeVolumesBound.mockImplementation(refusal);
			} else {
				mocks.waitForComposeRequiredChecks.mockImplementation(refusal);
			}
			await expect(runComposeBuild(COMPOSE, deployment)).rejects.toThrow(
				"refused by the check",
			);
			expect(pinnedWrites()).toEqual([]);
			expect(mocks.recorded).toEqual(recordOf(OTHER));
			expect(mocks.prepareComposeBuildServerDeploy).not.toHaveBeenCalled();

			// SHA stays on disk; the rebuild must not build it.
			mocks.assertComposeVolumesBound.mockImplementation(async () => {});
			mocks.waitForComposeRequiredChecks.mockImplementation(async () => {});
			await expect(rebuild()).rejects.toThrow(
				`The code on the serving host is commit ${SHA}, not commit ${OTHER} that the last deploy checked out.`,
			);
			expect(mocks.prepareComposeBuildServerDeploy).not.toHaveBeenCalled();
		},
	);

	it("a deploy that passed lets the next rebuild through", async () => {
		mocks.recorded = recordOf(OTHER);
		await runComposeBuild(COMPOSE, deployment);
		expect(mocks.recorded).toEqual(recordOf(SHA));
		mocks.prepareComposeBuildServerDeploy.mockClear();
		await rebuild();
		expect(mocks.prepareComposeBuildServerDeploy).toHaveBeenCalledTimes(1);
	});

	it("records nothing when the read is not a commit (prepare refuses that deploy)", async () => {
		mocks.readServingHostCommitOutput.mockResolvedValue("");
		await runComposeBuild(COMPOSE, deployment);
		expect(pinnedWrites()).toEqual([]);
		expect(prepareArgs()).toMatchObject({ servingCommitOutput: "" });
	});

	it("a preview (no patches, not cancellable) is pinned too", async () => {
		await runComposeBuild(
			{ ...COMPOSE, appName: "preview-stack-abc", headRef: "refs/pull/7/head" },
			deployment,
			{ applyPatches: false, cancellable: false },
		);
		expect(mocks.readServingHostCommitOutput).toHaveBeenCalledWith(
			expect.objectContaining({ appName: "preview-stack-abc" }),
		);
		expect(mocks.generateApplyPatchesCommand).not.toHaveBeenCalled();
		expect(prepareArgs()).toMatchObject({
			servingCommitOutput: `${SHA}\n`,
			patches: undefined,
			applyPatches: false,
			cancellable: false,
		});
	});

	it("reads nothing for a raw compose or a compose without a build server", async () => {
		await runComposeBuild(
			{ ...COMPOSE, sourceType: "raw", composeFile: "services: {}" },
			deployment,
		);
		await runComposeBuild(
			{ ...COMPOSE, buildServerId: null, buildRegistryId: null },
			deployment,
		);
		expect(mocks.readServingHostCommitOutput).not.toHaveBeenCalled();
		for (const [args] of mocks.prepareComposeBuildServerDeploy.mock.calls) {
			expect(args.servingCommitOutput).toBeUndefined();
		}
		expect(pinnedWrites()).toEqual([]);
	});
});

describe("rebuild (rebuildCompose)", () => {
	it("reads the commit on disk at the start of the rebuild, and passes the applied rows", async () => {
		await rebuild();
		expect(step("read")).toBeGreaterThanOrEqual(0);
		expect(step("read")).toBeLessThan(step("patches"));
		expect(step("patches")).toBeLessThan(step("guard"));
		expect(step("guard")).toBeLessThan(step("prepare"));
		expect(prepareArgs()).toMatchObject({
			reuseClone: true,
			servingCommitOutput: `${SHA}\n`,
			patches: ROWS,
		});
	});

	it("proceeds when the checkout, build server and patches are what the last deploy recorded, and carries them forward", async () => {
		await rebuild();
		expect(step("read")).toBeLessThan(step("patch-rows"));
		expect(step("patch-rows")).toBeLessThan(step("lookup"));
		expect(step("lookup")).toBeLessThan(step("record"));
		expect(step("record")).toBeLessThan(step("patches"));
		expect(pinnedWrites()).toEqual([["dep-1", recordOf(SHA)]]);
		expect(mocks.prepareComposeBuildServerDeploy).toHaveBeenCalledTimes(1);
		// One read of the patch rows: the ones compared are the ones applied.
		expect(mocks.findPatchesByEntityId).toHaveBeenCalledTimes(1);
		expect(mocks.generateApplyPatchesCommand.mock.calls[0]?.[0]).toMatchObject({
			patches: ROWS,
		});
		expect(prepareArgs().patches).toBe(ROWS);
	});

	it("refuses patch rows that changed since the deploy, and logs why", async () => {
		mocks.findPatchesByEntityId.mockResolvedValue([
			{ ...ROWS[0], enabled: false },
		]);
		await expect(rebuild()).rejects.toThrow(
			"The compose's patches changed since its last deploy.",
		);
		expect(mocks.generateApplyPatchesCommand).not.toHaveBeenCalled();
		expect(mocks.prepareComposeBuildServerDeploy).not.toHaveBeenCalled();
		expect(loggedErrors()).toEqual([
			expect.stringContaining(
				"Deploy it once; rebuilds work again after that.",
			),
		]);
	});

	it("refuses another build server than the deploy built on", async () => {
		await answerQueries({ ...COMPOSE, buildServerId: "build-2" });
		await expect(rebuild()).rejects.toThrow(
			"The compose builds on another build server than at its last deploy.",
		);
		expect(mocks.prepareComposeBuildServerDeploy).not.toHaveBeenCalled();
	});

	it("a refused rebuild puts the compose back to the serving release's status, not error", async () => {
		mocks.readServingHostCommitOutput.mockResolvedValue(`${OTHER}\n`);
		const error = await rebuild().catch((e: unknown) => e);
		expect(error).toMatchObject({
			rebuildRefused: true,
			settledStatus: "done",
		});
		expect(composeStatuses()).toEqual(["done"]);
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
	});

	it("any other rebuild failure still marks the compose error", async () => {
		mocks.prepareComposeBuildServerDeploy.mockRejectedValue(new Error("boom"));
		await expect(rebuild()).rejects.toThrow("boom");
		expect(composeStatuses()).toEqual(["error"]);
	});

	it("refuses another commit before anything is patched or built, and logs why", async () => {
		mocks.readServingHostCommitOutput.mockResolvedValue(`${OTHER}\n`);
		await expect(rebuild()).rejects.toThrow(
			`The code on the serving host is commit ${OTHER}, not commit ${SHA} that the last deploy checked out.`,
		);
		expect(mocks.generateApplyPatchesCommand).not.toHaveBeenCalled();
		expect(mocks.assertComposeVolumesBound).not.toHaveBeenCalled();
		expect(mocks.prepareComposeBuildServerDeploy).not.toHaveBeenCalled();
		expect(pinnedWrites()).toEqual([]);
		expect(loggedErrors()).toEqual([
			expect.stringContaining(
				`The code on the serving host is commit ${OTHER}, not commit ${SHA}`,
			),
		]);
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
	});

	it("refuses a compose no deploy recorded a commit for (deployed before this check), and logs why", async () => {
		mocks.recorded = null;
		await expect(rebuild()).rejects.toThrow(
			"No deploy of this compose recorded the commit it checked out",
		);
		expect(mocks.generateApplyPatchesCommand).not.toHaveBeenCalled();
		expect(mocks.prepareComposeBuildServerDeploy).not.toHaveBeenCalled();
		expect(loggedErrors()).toEqual([
			expect.stringContaining(
				"Deploy it once; rebuilds work again after that.",
			),
		]);
	});

	it("refuses a recorded value that is not a full commit id", async () => {
		mocks.recorded = { ...recordOf(SHA), pinnedCommit: "$(reboot)" };
		await expect(rebuild()).rejects.toThrow(
			"The commit recorded by the last deploy is not a full commit id",
		);
		expect(mocks.prepareComposeBuildServerDeploy).not.toHaveBeenCalled();
	});

	it("checks nothing for a raw compose or a compose without a build server", async () => {
		mocks.recorded = null;
		await answerQueries({
			...COMPOSE,
			buildServerId: null,
			buildRegistryId: null,
		});
		await rebuild();
		await answerQueries({
			...COMPOSE,
			sourceType: "raw",
			composeFile: "services: {}",
		});
		await rebuild();
		expect(mocks.readServingHostCommitOutput).not.toHaveBeenCalled();
		expect(step("lookup")).toBe(-1);
		expect(pinnedWrites()).toEqual([]);
		expect(mocks.prepareComposeBuildServerDeploy).toHaveBeenCalledTimes(2);
	});
});
