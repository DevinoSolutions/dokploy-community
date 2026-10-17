import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `isCoalescingEnforcedForUnit` answers "would a push for this unit coalesce?"
 * for callers that act on the queue outside a push (the post-restore dedupe).
 * It must say yes exactly when the enqueue gate would let coalescing run: some
 * organization enforces, the unit exists, its environment has an organization,
 * and that organization enforces remote builds.
 */

const mocks = vi.hoisted(() => ({
	isBuildPolicyEnforcedAnywhere: vi.fn(),
	findBuildPolicySettings: vi.fn(),
	applicationsFindFirst: vi.fn(),
	composeFindFirst: vi.fn(),
	environmentsFindFirst: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			applications: { findFirst: mocks.applicationsFindFirst },
			compose: { findFirst: mocks.composeFindFirst },
			environments: { findFirst: mocks.environmentsFindFirst },
		},
	},
}));

vi.mock("@dokploy/server/services/build-policy/settings", () => ({
	isBuildPolicyEnforcedAnywhere: mocks.isBuildPolicyEnforcedAnywhere,
	findBuildPolicySettings: mocks.findBuildPolicySettings,
}));

const { isCoalescingEnforcedForUnit } = await import(
	"@dokploy/server/services/build-policy/webhook"
);

const unitQuery = {
	application: () => mocks.applicationsFindFirst,
	compose: () => mocks.composeFindFirst,
};

describe.each(["application", "compose"] as const)(
	"isCoalescingEnforcedForUnit (%s)",
	(unitType) => {
		beforeEach(() => {
			vi.resetAllMocks();
			mocks.isBuildPolicyEnforcedAnywhere.mockResolvedValue(true);
			unitQuery[unitType]().mockResolvedValue({ environmentId: "env-1" });
			mocks.environmentsFindFirst.mockResolvedValue({
				project: { organizationId: "org-1" },
			});
			mocks.findBuildPolicySettings.mockResolvedValue({
				enforceRemoteBuilds: true,
			});
		});

		it("is true when the unit's organization enforces remote builds", async () => {
			expect(await isCoalescingEnforcedForUnit(unitType, "u1")).toBe(true);
			expect(mocks.findBuildPolicySettings).toHaveBeenCalledWith("org-1");
		});

		it("is false, without reading anything else, when nobody enforces", async () => {
			mocks.isBuildPolicyEnforcedAnywhere.mockResolvedValue(false);

			expect(await isCoalescingEnforcedForUnit(unitType, "u1")).toBe(false);
			expect(unitQuery[unitType]()).not.toHaveBeenCalled();
			expect(mocks.environmentsFindFirst).not.toHaveBeenCalled();
			expect(mocks.findBuildPolicySettings).not.toHaveBeenCalled();
		});

		it("is false when the unit no longer exists", async () => {
			unitQuery[unitType]().mockResolvedValue(undefined);

			expect(await isCoalescingEnforcedForUnit(unitType, "u1")).toBe(false);
			expect(mocks.findBuildPolicySettings).not.toHaveBeenCalled();
		});

		it("is false when the environment has no organization", async () => {
			mocks.environmentsFindFirst.mockResolvedValue(undefined);

			expect(await isCoalescingEnforcedForUnit(unitType, "u1")).toBe(false);
			expect(mocks.findBuildPolicySettings).not.toHaveBeenCalled();
		});

		it("is false when the organization has no policy settings", async () => {
			mocks.findBuildPolicySettings.mockResolvedValue(undefined);

			expect(await isCoalescingEnforcedForUnit(unitType, "u1")).toBe(false);
		});

		it("is false when the organization does not enforce remote builds", async () => {
			mocks.findBuildPolicySettings.mockResolvedValue({
				enforceRemoteBuilds: false,
			});

			expect(await isCoalescingEnforcedForUnit(unitType, "u1")).toBe(false);
		});

		it("looks the unit up in its own table only", async () => {
			await isCoalescingEnforcedForUnit(unitType, "u1");

			const other = unitType === "application" ? "compose" : "application";
			expect(unitQuery[other]()).not.toHaveBeenCalled();
		});
	},
);
