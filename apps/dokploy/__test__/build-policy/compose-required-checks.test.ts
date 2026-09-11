import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Round-2 review finding A, the merge blocker.
 *
 * The README, the PR body and a comment in `policy.ts` all claimed that
 * exclusions, break-glass and `requiredChecks` applied to compose units in
 * full. None of the three did, and `compose.requiredChecks` was a writable API
 * field that silently did nothing: an operator who set it believed that compose
 * unit's deploys waited for CI, and they deployed immediately, every time.
 * Claiming a safety control that is not wired is the dangerous direction for a
 * document to be wrong in.
 *
 * The resolution, and what these tests pin:
 *
 * - **`requiredChecks` is wired for compose.** `runComposeBuild` already runs
 *   the deploy in discrete steps, so there is a clean hook between the clone
 *   and the build — the same position as the application path's hook 2a/4.
 * - **Exclusions and break-glass are not, and now say so.** They decide *where*
 *   a unit builds; a compose build is never relocated, so there is nothing to
 *   exclude it from. The router refuses a `composeId` on both rather than
 *   writing a row nothing will ever read.
 */

const mocks = vi.hoisted(() => ({
	isBuildPolicyEnforcedAnywhere: vi.fn(),
	findBuildPolicySettings: vi.fn(),
	getGitCommitInfo: vi.fn(),
	waitForUnitRequiredChecks: vi.fn().mockResolvedValue(undefined),
	isUnitExcluded: vi.fn(),
	findPendingBreakGlass: vi.fn(),
}));

vi.mock("@dokploy/server/services/build-policy/settings", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/build-policy/settings")
	>("@dokploy/server/services/build-policy/settings");
	return {
		...actual,
		isBuildPolicyEnforcedAnywhere: mocks.isBuildPolicyEnforcedAnywhere,
		findBuildPolicySettings: mocks.findBuildPolicySettings,
	};
});

vi.mock("@dokploy/server/utils/providers/git", () => ({
	getGitCommitInfo: mocks.getGitCommitInfo,
}));

vi.mock("@dokploy/server/services/build-policy/github-checks", () => ({
	waitForUnitRequiredChecks: mocks.waitForUnitRequiredChecks,
}));

vi.mock("@dokploy/server/services/build-policy/exclusions", () => ({
	isUnitExcluded: mocks.isUnitExcluded,
}));

import { waitForComposeRequiredChecks } from "@dokploy/server/services/build-policy/compose-checks";

const ENFORCING = {
	buildPolicySettingsId: "s-1",
	organizationId: "org-1",
	enforceRemoteBuilds: true,
	defaultBuildServerId: "srv-1",
	defaultRegistryId: "reg-1",
	requiredChecksTimeoutMinutes: 4,
	createdAt: "",
	updatedAt: "",
} as any;

const COMPOSE = {
	composeId: "compose-1",
	appName: "sendly-stack",
	name: "Sendly Stack",
	requiredChecks: ["build"],
	sourceType: "github",
	githubId: "gh-1",
	owner: "DevinoSolutions",
	repository: "sendly",
	customGitUrl: null,
	serverId: null,
	environment: { project: { organizationId: "org-1" } },
} as any;

const run = (compose: unknown = COMPOSE, serverId: string | null = null) =>
	waitForComposeRequiredChecks({ compose: compose as any, serverId });

describe("waitForComposeRequiredChecks — default-off", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isBuildPolicyEnforcedAnywhere.mockResolvedValue(true);
		mocks.findBuildPolicySettings.mockResolvedValue(ENFORCING);
		mocks.getGitCommitInfo.mockResolvedValue({ hash: "abc123", message: "" });
		mocks.waitForUnitRequiredChecks.mockResolvedValue(undefined);
	});

	it("reads nothing at all when the unit has no required checks", async () => {
		await run({ ...COMPOSE, requiredChecks: null });

		expect(mocks.isBuildPolicyEnforcedAnywhere).not.toHaveBeenCalled();
		expect(mocks.findBuildPolicySettings).not.toHaveBeenCalled();
		expect(mocks.getGitCommitInfo).not.toHaveBeenCalled();
		expect(mocks.waitForUnitRequiredChecks).not.toHaveBeenCalled();
	});

	it("ignores blank names, which are not a real gate", async () => {
		await run({ ...COMPOSE, requiredChecks: ["", "   "] });

		expect(mocks.isBuildPolicyEnforcedAnywhere).not.toHaveBeenCalled();
		expect(mocks.waitForUnitRequiredChecks).not.toHaveBeenCalled();
	});

	it("stops at the cached probe when nobody on the instance enforces", async () => {
		mocks.isBuildPolicyEnforcedAnywhere.mockResolvedValue(false);
		await run();

		expect(mocks.findBuildPolicySettings).not.toHaveBeenCalled();
		expect(mocks.getGitCommitInfo).not.toHaveBeenCalled();
		expect(mocks.waitForUnitRequiredChecks).not.toHaveBeenCalled();
	});

	it("does nothing when this organization has no settings row", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue(null);
		await run();

		expect(mocks.waitForUnitRequiredChecks).not.toHaveBeenCalled();
	});

	it("does nothing when this organization does not enforce", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue({
			...ENFORCING,
			enforceRemoteBuilds: false,
		});
		await run();

		expect(mocks.waitForUnitRequiredChecks).not.toHaveBeenCalled();
	});

	it("does nothing, and does not throw, when the row carries no organization", async () => {
		await expect(
			run({ ...COMPOSE, environment: null }),
		).resolves.toBeUndefined();

		expect(mocks.waitForUnitRequiredChecks).not.toHaveBeenCalled();
	});
});

describe("waitForComposeRequiredChecks — the gate itself", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isBuildPolicyEnforcedAnywhere.mockResolvedValue(true);
		mocks.findBuildPolicySettings.mockResolvedValue(ENFORCING);
		mocks.getGitCommitInfo.mockResolvedValue({ hash: "abc123", message: "" });
		mocks.waitForUnitRequiredChecks.mockResolvedValue(undefined);
	});

	it("waits on the compose unit's own checkout and identity", async () => {
		await run();

		expect(mocks.getGitCommitInfo).toHaveBeenCalledWith({
			appName: "sendly-stack",
			type: "compose",
			serverId: null,
		});
		const call = mocks.waitForUnitRequiredChecks.mock.calls[0]?.[0];
		expect(call.unit).toMatchObject({
			unitType: "compose",
			unitId: "compose-1",
			unitName: "Sendly Stack",
			organizationId: "org-1",
			requiredChecks: ["build"],
			sourceType: "github",
			githubId: "gh-1",
			owner: "DevinoSolutions",
			repository: "sendly",
		});
		expect(call.sha).toBe("abc123");
		expect(call.timeoutMs).toBe(4 * 60_000);
	});

	it("reads the checkout on the compose unit's own server", async () => {
		await run(COMPOSE, "srv-9");

		expect(mocks.getGitCommitInfo).toHaveBeenCalledWith({
			appName: "sendly-stack",
			type: "compose",
			serverId: "srv-9",
		});
	});

	it("passes a null sha through so the wait fails closed", async () => {
		mocks.getGitCommitInfo.mockResolvedValue({ hash: "", message: "" });
		await run();

		expect(mocks.waitForUnitRequiredChecks.mock.calls[0]?.[0].sha).toBeNull();
	});

	it("propagates a failing check so the build never runs", async () => {
		mocks.waitForUnitRequiredChecks.mockRejectedValue(
			new Error("Required GitHub checks failed"),
		);

		await expect(run()).rejects.toThrow("Required GitHub checks failed");
	});

	/**
	 * The test the review asked for: one that asserts what a compose deploy does
	 * NOT do. Exclusions and break-glass decide where a unit builds, and a
	 * compose build is never relocated, so the checks gate must not consult
	 * either — otherwise an exclusion would silently disable a team's CI gate.
	 */
	it("never consults exclusions or break-glass", async () => {
		await run();

		expect(mocks.isUnitExcluded).not.toHaveBeenCalled();
		expect(mocks.findPendingBreakGlass).not.toHaveBeenCalled();
	});

	it("still gates an excluded compose unit, because exclusion is about the build host", async () => {
		mocks.isUnitExcluded.mockResolvedValue(true);
		await run();

		expect(mocks.waitForUnitRequiredChecks).toHaveBeenCalledTimes(1);
	});
});
