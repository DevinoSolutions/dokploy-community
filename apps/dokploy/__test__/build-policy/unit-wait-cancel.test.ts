import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-2838: a cancel while the required checks are awaited leaves through the
 * cancel path. It is not a failed gate, so it writes no `required_checks_*`
 * audit row, and the error reaches the deploy untouched.
 */

const mocks = vi.hoisted(() => ({
	recordBuildPolicyAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@dokploy/server/services/build-policy/audit", () => ({
	recordBuildPolicyAudit: mocks.recordBuildPolicyAudit,
}));
vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: vi.fn(),
}));
vi.mock("@dokploy/server/utils/providers/github", () => ({
	authGithub: vi.fn(),
}));

import { waitForUnitRequiredChecks } from "@dokploy/server/services/build-policy/github-checks";

const UNIT = {
	unitType: "compose" as const,
	unitId: "compose-1",
	unitName: "Stack",
	organizationId: "org-1",
	requiredChecks: ["build"],
	sourceType: "github",
	githubId: "gh-1",
	owner: "DevinoSolutions",
	repository: "stack",
};

const pending = () =>
	vi
		.fn()
		.mockResolvedValue([{ name: "build", status: "queued", conclusion: null }]);

const cancelledError = () =>
	Object.assign(new Error("Deployment cancelled"), {
		deploymentCancelled: true,
	});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("waitForUnitRequiredChecks and a cancel", () => {
	it("hands the hook to the wait and rethrows the cancel without an audit row", async () => {
		const assertNotCancelled = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValue(cancelledError());
		const listCheckRunsOverride = pending();

		await expect(
			waitForUnitRequiredChecks({
				unit: UNIT,
				sha: "abc123",
				timeoutMs: 600_000,
				pollIntervalMs: 1,
				listCheckRunsOverride,
				sleepOverride: async () => {},
				assertNotCancelled,
			}),
		).rejects.toMatchObject({ deploymentCancelled: true });

		expect(listCheckRunsOverride).toHaveBeenCalledTimes(1);
		expect(mocks.recordBuildPolicyAudit).not.toHaveBeenCalled();
	});

	it("a restore that fails inside the hook is not audited as a failed gate either", async () => {
		const assertNotCancelled = vi
			.fn()
			.mockRejectedValue(new Error("Deployment cancelled, but not restored"));

		await expect(
			waitForUnitRequiredChecks({
				unit: UNIT,
				sha: "abc123",
				timeoutMs: 600_000,
				pollIntervalMs: 1,
				listCheckRunsOverride: pending(),
				sleepOverride: async () => {},
				assertNotCancelled,
			}),
		).rejects.toThrow("not restored");

		expect(mocks.recordBuildPolicyAudit).not.toHaveBeenCalled();
	});

	it("a timeout is still audited when nothing was cancelled", async () => {
		let clock = 0;
		await expect(
			waitForUnitRequiredChecks({
				unit: UNIT,
				sha: "abc123",
				timeoutMs: 1_000,
				pollIntervalMs: 1,
				listCheckRunsOverride: pending(),
				sleepOverride: async () => {
					clock += 5_000;
				},
				nowOverride: () => clock,
				assertNotCancelled: vi.fn().mockResolvedValue(undefined),
			}),
		).rejects.toMatchObject({ code: "REQUIRED_CHECKS_TIMEOUT" });

		expect(mocks.recordBuildPolicyAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "required_checks_timeout" }),
		);
	});
});
