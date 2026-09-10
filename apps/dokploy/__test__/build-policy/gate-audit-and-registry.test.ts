import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Round-2 review findings B, C and D.
 *
 * B — a watch-path skip left no trace. The skip-marker branch audits; the
 *     derived-watch-path branch, the one that fires without anybody asking for
 *     it, returned a 301 on a webhook delivery nobody reads and wrote nothing.
 * C — coalescing ran before the deploy-hook body was validated, so a malformed
 *     or foreign-repository body dropped every waiting deploy for the unit and
 *     then enqueued nothing.
 *
 * D's allowlist half lived here too, until round-3 finding I showed the fix had
 * inverted the divergence rather than removed it. It now resolves through
 * `previewBuildPolicyDecision`, and all of its coverage moved to
 * `hook-allowlist-follows-plan.test.ts`, which has the mocks that decision path
 * needs. What stays here is B, plus D's other half — the pull credentials — in
 * `deploy-path.integration.test.ts`.
 */

const mocks = vi.hoisted(() => ({
	isBuildPolicyEnforcedAnywhere: vi.fn(),
	findBuildPolicySettings: vi.fn(),
	recordBuildPolicyAudit: vi.fn().mockResolvedValue(undefined),
	environmentsFindFirst: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			environments: { findFirst: mocks.environmentsFindFirst },
		},
	},
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

vi.mock("@dokploy/server/services/build-policy/audit", () => ({
	recordBuildPolicyAudit: mocks.recordBuildPolicyAudit,
	findPendingBreakGlass: vi.fn(),
	consumeBreakGlass: vi.fn(),
	grantBreakGlass: vi.fn(),
	listBuildPolicyAudit: vi.fn(),
}));

import { buildPolicyDeployGate } from "@dokploy/server/services/build-policy/webhook";

const ENFORCING = {
	buildPolicySettingsId: "s-1",
	organizationId: "org-1",
	enforceRemoteBuilds: true,
	defaultBuildServerId: "srv-1",
	defaultRegistryId: "reg-default",
	requiredChecksTimeoutMinutes: 5,
	createdAt: "",
	updatedAt: "",
} as any;

const UNIT = {
	unitId: "app-1",
	unitName: "sendly-web",
	environmentId: "env-1",
	watchPaths: null,
	buildPath: "apps/web",
	dockerfile: null,
	dockerContextPath: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isBuildPolicyEnforcedAnywhere.mockResolvedValue(true);
	mocks.findBuildPolicySettings.mockResolvedValue(ENFORCING);
	mocks.recordBuildPolicyAudit.mockResolvedValue(undefined);
	mocks.environmentsFindFirst.mockResolvedValue({
		environmentId: "env-1",
		project: { organizationId: "org-1" },
	});
});

describe("finding B — a derived watch-path skip is audited", () => {
	it("records a deploy_skipped row naming the derived paths and the changed files", async () => {
		const result = await buildPolicyDeployGate({
			unitType: "application",
			unit: UNIT,
			changedFiles: ["packages/shared/index.ts"],
			commitMessage: "chore: shared code only",
			removeWaiting: vi.fn(),
		});

		expect(result.deploy).toBe(false);
		expect(mocks.recordBuildPolicyAudit).toHaveBeenCalledTimes(1);
		const row = mocks.recordBuildPolicyAudit.mock.calls[0]?.[0];
		expect(row).toMatchObject({
			organizationId: "org-1",
			action: "deploy_skipped",
			applicationId: "app-1",
			composeId: null,
		});
		expect(row.reason).toContain("derived watch paths");
		expect(row.metadata.derivedWatchPaths).toEqual(["apps/web/**"]);
		expect(row.metadata.changedFiles).toEqual(["packages/shared/index.ts"]);
	});

	/**
	 * Round-3 nit N9. A monorepo push can touch thousands of files, and this row
	 * is written per skipped delivery, so the whole array in the metadata blob is
	 * a real write-amplification. The count is what an operator actually needs
	 * alongside a sample; the full list is not worth the storage.
	 */
	it("caps the changed files it stores, keeping the count and a truncation flag", async () => {
		const many = Array.from(
			{ length: 500 },
			(_, i) => `packages/shared/f${i}.ts`,
		);

		await buildPolicyDeployGate({
			unitType: "application",
			unit: UNIT,
			changedFiles: many,
			commitMessage: "chore: a very wide refactor",
			removeWaiting: vi.fn(),
		});

		const row = mocks.recordBuildPolicyAudit.mock.calls[0]?.[0];
		expect(row.metadata.changedFilesCount).toBe(500);
		expect(row.metadata.changedFilesTruncated).toBe(true);
		expect(row.metadata.changedFiles).toHaveLength(50);
		expect(row.metadata.changedFiles[0]).toBe("packages/shared/f0.ts");
	});

	it("stores a small push whole, and says it was not truncated", async () => {
		await buildPolicyDeployGate({
			unitType: "application",
			unit: UNIT,
			changedFiles: ["packages/shared/index.ts"],
			commitMessage: "chore: shared code only",
			removeWaiting: vi.fn(),
		});

		const row = mocks.recordBuildPolicyAudit.mock.calls[0]?.[0];
		expect(row.metadata.changedFilesCount).toBe(1);
		expect(row.metadata.changedFilesTruncated).toBe(false);
		expect(row.metadata.changedFiles).toEqual(["packages/shared/index.ts"]);
	});

	it("targets the compose id for a compose unit", async () => {
		await buildPolicyDeployGate({
			unitType: "compose",
			unit: {
				unitId: "compose-1",
				unitName: "stack",
				environmentId: "env-1",
				watchPaths: null,
				composePath: "./stacks/api/docker-compose.yml",
			},
			changedFiles: ["docs/readme.md"],
			removeWaiting: vi.fn(),
		});

		expect(mocks.recordBuildPolicyAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "deploy_skipped",
				applicationId: null,
				composeId: "compose-1",
			}),
		);
	});

	it("does not coalesce when it skips, so nothing waiting is dropped", async () => {
		const removeWaiting = vi.fn();
		await buildPolicyDeployGate({
			unitType: "application",
			unit: UNIT,
			changedFiles: ["packages/shared/index.ts"],
			removeWaiting,
		});

		expect(removeWaiting).not.toHaveBeenCalled();
	});

	it("writes nothing when the push does match the derived paths", async () => {
		const removeWaiting = vi.fn().mockResolvedValue({
			removed: 0,
			titles: [],
		});
		const result = await buildPolicyDeployGate({
			unitType: "application",
			unit: UNIT,
			changedFiles: ["apps/web/page.tsx"],
			removeWaiting,
		});

		expect(result.deploy).toBe(true);
		expect(mocks.recordBuildPolicyAudit).not.toHaveBeenCalled();
	});

	it("still writes nothing at all while the policy is off", async () => {
		mocks.isBuildPolicyEnforcedAnywhere.mockResolvedValue(false);
		const result = await buildPolicyDeployGate({
			unitType: "application",
			unit: UNIT,
			changedFiles: ["packages/shared/index.ts"],
			removeWaiting: vi.fn(),
		});

		expect(result.deploy).toBe(true);
		expect(mocks.recordBuildPolicyAudit).not.toHaveBeenCalled();
	});
});
