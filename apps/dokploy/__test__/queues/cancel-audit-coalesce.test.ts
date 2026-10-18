import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A push that drops waiting deploys has no caller. The drop lands in the
 * fork's cancel trail as the system, next to the build-policy audit row.
 */

const mocks = vi.hoisted(() => ({
	isBuildPolicyEnforcedAnywhere: vi.fn(),
	findBuildPolicySettings: vi.fn(),
	recordBuildPolicyAudit: vi.fn(async () => undefined),
	recordDeploymentCancelAudit: vi.fn(async () => undefined),
	environmentsFindFirst: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { environments: { findFirst: mocks.environmentsFindFirst } },
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

vi.mock("@dokploy/server/services/deployment-cancel-audit", () => ({
	recordDeploymentCancelAudit: mocks.recordDeploymentCancelAudit,
}));

import { buildPolicyDeployGate } from "@dokploy/server/services/build-policy/webhook";

const UNIT = {
	unitId: "app-1",
	unitName: "sendly-web",
	environmentId: "env-1",
	watchPaths: null,
	buildPath: ".",
	dockerfile: null,
	dockerContextPath: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isBuildPolicyEnforcedAnywhere.mockResolvedValue(true);
	mocks.findBuildPolicySettings.mockResolvedValue({
		buildPolicySettingsId: "s-1",
		organizationId: "org-1",
		enforceRemoteBuilds: true,
		defaultBuildServerId: "srv-1",
		defaultRegistryId: "reg-default",
		requiredChecksTimeoutMinutes: 5,
		createdAt: "",
		updatedAt: "",
	});
	mocks.environmentsFindFirst.mockResolvedValue({
		environmentId: "env-1",
		project: { organizationId: "org-1" },
	});
});

describe("coalescing in the cancel trail", () => {
	it("records the drop with the system as the actor", async () => {
		await buildPolicyDeployGate({
			unitType: "application",
			unit: UNIT,
			changedFiles: ["a.ts"],
			commitMessage: "feat: x",
			removeWaiting: vi.fn(async () => ({
				removed: 2,
				titles: ["old push"],
			})),
		});

		expect(mocks.recordBuildPolicyAudit).toHaveBeenCalledTimes(1);
		expect(mocks.recordDeploymentCancelAudit).toHaveBeenCalledTimes(1);
		expect(mocks.recordDeploymentCancelAudit).toHaveBeenCalledWith({
			organizationId: "org-1",
			action: "coalesce_drop",
			actor: { type: "system" },
			targetType: "application",
			targetId: "app-1",
			targetName: "sendly-web",
			applicationId: "app-1",
			composeId: null,
			metadata: expect.objectContaining({ removed: 2 }),
		});
	});

	it("writes nothing when no deploy was waiting", async () => {
		await buildPolicyDeployGate({
			unitType: "application",
			unit: UNIT,
			changedFiles: ["a.ts"],
			commitMessage: "feat: x",
			removeWaiting: vi.fn(async () => 0),
		});

		expect(mocks.recordDeploymentCancelAudit).not.toHaveBeenCalled();
	});
});
