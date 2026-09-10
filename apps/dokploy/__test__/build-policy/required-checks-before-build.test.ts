import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Round-2 review finding E. The required-checks wait sat in
 * `prepareBuildPolicyDeploy`, i.e. **after** the build, and it needed no policy
 * switch: a non-empty `requiredChecks` alone entered the branch. So a mistyped
 * check name on one unit built, tagged and pushed an image, then held the
 * instance's only deployment slot for the full timeout and failed. On a
 * self-hosted instance every job lands in `LOCAL_PARTITION` with concurrency
 * `buildsConcurrency ?? 1`, so that stalls every other deploy.
 *
 * Two fixes, both asserted here:
 *
 * 1. the gate is **policy-gated** — it does nothing unless the organization has
 *    `enforceRemoteBuilds` on, so a `requiredChecks` value alone can no longer
 *    change what a deploy does;
 * 2. the gate runs **between the clone and the build**, on the sha the clone
 *    just fetched, so a failing or never-arriving check costs no build at all.
 *
 * With the gate inactive the caller's command string must come back byte
 * identical and nothing must be executed, which is the default-off property.
 */

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	getGitCommitInfo: vi.fn(),
	waitForUnitRequiredChecks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/utils/providers/git", () => ({
	getGitCommitInfo: mocks.getGitCommitInfo,
}));

vi.mock("@dokploy/server/services/build-policy/github-checks", () => ({
	waitForUnitRequiredChecks: mocks.waitForUnitRequiredChecks,
}));

import { runBuildPolicyPreBuildGate } from "@dokploy/server/services/build-policy/apply";

const ENFORCING = {
	buildPolicySettingsId: "s-1",
	organizationId: "org-1",
	enforceRemoteBuilds: true,
	defaultBuildServerId: "srv-1",
	defaultRegistryId: "reg-1",
	requiredChecksTimeoutMinutes: 7,
	createdAt: "",
	updatedAt: "",
} as any;

const NOT_ENFORCING = { ...ENFORCING, enforceRemoteBuilds: false };

const APPLICATION = {
	applicationId: "app-1",
	appName: "sendly-web",
	name: "Sendly Web",
	requiredChecks: ["build"],
	sourceType: "github",
	githubId: "gh-1",
	owner: "DevinoSolutions",
	repository: "sendly",
	customGitUrl: null,
	environment: { project: { organizationId: "org-1" } },
} as any;

const PLAN = (settings: unknown, enforced = true) =>
	({
		enforced,
		buildServerId: "srv-1",
		registryId: "reg-1",
		repository: "ghcr.io/devino/sendly-web",
		settings,
	}) as any;

const DEPLOYMENT = { deploymentId: "dep-1", logPath: "/var/log/dep-1.log" };

const CLONE = "set -e;git clone ...;";

const run = (overrides: Record<string, unknown> = {}) =>
	runBuildPolicyPreBuildGate({
		application: APPLICATION,
		plan: PLAN(ENFORCING),
		deployment: DEPLOYMENT,
		serverId: null,
		command: CLONE,
		...overrides,
	} as any);

describe("runBuildPolicyPreBuildGate — default-off and the policy switch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// `clearAllMocks` clears calls, not implementations, and one test below
		// makes the wait reject. Re-establish every default explicitly.
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.waitForUnitRequiredChecks.mockResolvedValue(undefined);
		mocks.getGitCommitInfo.mockResolvedValue({ hash: "abc123", message: "" });
	});

	it("returns the command unchanged and runs nothing when the unit has no required checks", async () => {
		const result = await run({
			application: { ...APPLICATION, requiredChecks: null },
		});

		expect(result).toBe(CLONE);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.waitForUnitRequiredChecks).not.toHaveBeenCalled();
	});

	it("returns the command unchanged when there is no settings row at all", async () => {
		const result = await run({ plan: PLAN(null, false) });

		expect(result).toBe(CLONE);
		expect(mocks.waitForUnitRequiredChecks).not.toHaveBeenCalled();
	});

	it("ignores requiredChecks while the organization does not enforce — finding E", async () => {
		// This is the caveat the review named: before the fix a non-empty
		// requiredChecks alone was enough to take the SSH round trip and wait on
		// GitHub, with no policy switch involved.
		const result = await run({ plan: PLAN(NOT_ENFORCING, false) });

		expect(result).toBe(CLONE);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.getGitCommitInfo).not.toHaveBeenCalled();
		expect(mocks.waitForUnitRequiredChecks).not.toHaveBeenCalled();
	});

	it("ignores blank check names, which are not a real gate", async () => {
		const result = await run({
			application: { ...APPLICATION, requiredChecks: ["", "  "] },
		});

		expect(result).toBe(CLONE);
		expect(mocks.waitForUnitRequiredChecks).not.toHaveBeenCalled();
	});

	it("returns the command unchanged when the row carries no organization", async () => {
		const result = await run({
			application: { ...APPLICATION, environment: null },
		});

		expect(result).toBe(CLONE);
		expect(mocks.waitForUnitRequiredChecks).not.toHaveBeenCalled();
	});
});

describe("runBuildPolicyPreBuildGate — the gate runs before the build", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// `clearAllMocks` clears calls, not implementations, and one test below
		// makes the wait reject. Re-establish every default explicitly.
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.waitForUnitRequiredChecks.mockResolvedValue(undefined);
		mocks.getGitCommitInfo.mockResolvedValue({ hash: "abc123", message: "" });
	});

	it("runs the clone half, then waits, and hands back a fresh command prefix", async () => {
		const result = await run();

		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		expect(mocks.execAsync.mock.calls[0]?.[0]).toBe(
			`(${CLONE}) >> ${DEPLOYMENT.logPath} 2>&1`,
		);
		expect(mocks.waitForUnitRequiredChecks).toHaveBeenCalledTimes(1);
		// The caller continues building from here; the clone is already run.
		expect(result).toBe("set -e;");
	});

	it("clones on the build server when there is one", async () => {
		await run({ serverId: "srv-1" });

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"srv-1",
			`(${CLONE}) >> ${DEPLOYMENT.logPath} 2>&1`,
		);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("waits on the sha the clone just fetched", async () => {
		await run();

		expect(mocks.getGitCommitInfo).toHaveBeenCalledWith({
			appName: "sendly-web",
			type: "application",
			serverId: null,
		});
		expect(mocks.waitForUnitRequiredChecks.mock.calls[0]?.[0].sha).toBe(
			"abc123",
		);
	});

	it("passes the unit identity and the organization's configured timeout", async () => {
		await run();

		const call = mocks.waitForUnitRequiredChecks.mock.calls[0]?.[0];
		expect(call.unit).toMatchObject({
			unitType: "application",
			unitId: "app-1",
			unitName: "Sendly Web",
			organizationId: "org-1",
			requiredChecks: ["build"],
			sourceType: "github",
			githubId: "gh-1",
		});
		expect(call.timeoutMs).toBe(7 * 60_000);
	});

	it("passes a null sha through so the wait can fail closed", async () => {
		mocks.getGitCommitInfo.mockResolvedValue({ hash: "", message: "" });
		await run();

		expect(mocks.waitForUnitRequiredChecks.mock.calls[0]?.[0].sha).toBeNull();
	});

	it("does not swallow a failing check — no build is reached", async () => {
		mocks.waitForUnitRequiredChecks.mockRejectedValue(
			new Error("Required GitHub checks failed"),
		);

		await expect(run()).rejects.toThrow("Required GitHub checks failed");
		// The clone ran, the build command was never assembled or executed.
		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
	});

	it("still gates a unit the policy left local, such as an excluded one", async () => {
		// Exclusion decides where a unit BUILDS. It does not mean the team gave
		// up its CI gate, so the check still applies while the org enforces.
		await run({ plan: PLAN(ENFORCING, false) });

		expect(mocks.waitForUnitRequiredChecks).toHaveBeenCalledTimes(1);
	});
});
