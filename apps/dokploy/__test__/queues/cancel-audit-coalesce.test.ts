import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A push that drops waiting deploys has no caller. The drop lands in the
 * fork's cancel trail as the system, next to the build-policy audit row. A
 * manual deploy has one, and the row names them.
 */

const mocks = vi.hoisted(() => ({
	isBuildPolicyEnforcedAnywhere: vi.fn(),
	findBuildPolicySettings: vi.fn(),
	recordBuildPolicyAudit: vi.fn(async (_entry: unknown) => undefined),
	recordDeploymentCancelAudit: vi.fn(async (_input: unknown) => undefined),
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

	it("records the drop under the person behind a manual deploy", async () => {
		await buildPolicyDeployGate({
			unitType: "compose",
			unit: { ...UNIT, unitId: "c-1", unitName: "stack" },
			caller: {
				actor: {
					type: "user",
					userId: "user-2",
					email: "dev@example.com",
				},
			},
			removeWaiting: vi.fn(async () => ({ removed: 1, merged: true })),
		});

		expect(mocks.recordDeploymentCancelAudit).toHaveBeenCalledTimes(1);
		const row = mocks.recordDeploymentCancelAudit.mock.calls[0]?.[0] as {
			actor: unknown;
			metadata: Record<string, unknown>;
		};
		expect(row.actor).toEqual({
			type: "user",
			userId: "user-2",
			email: "dev@example.com",
		});
		expect(row.metadata).not.toHaveProperty("impersonatedBy");
	});

	it("keeps an API key and the impersonating admin on the row", async () => {
		await buildPolicyDeployGate({
			unitType: "application",
			unit: UNIT,
			caller: {
				actor: {
					type: "api_key",
					userId: "user-2",
					email: "dev@example.com",
					apiKeyId: "key-1",
				},
				impersonatedBy: "admin-9",
			},
			removeWaiting: vi.fn(async () => ({ removed: 2 })),
		});

		expect(mocks.recordDeploymentCancelAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				actor: expect.objectContaining({
					type: "api_key",
					apiKeyId: "key-1",
				}),
				metadata: expect.objectContaining({
					removed: 2,
					impersonatedBy: "admin-9",
				}),
			}),
		);
	});

	it("keeps commit messages out of the cancel trail row", async () => {
		await buildPolicyDeployGate({
			unitType: "application",
			unit: UNIT,
			changedFiles: ["a.ts"],
			commitMessage: "feat: x",
			removeWaiting: vi.fn(async () => ({
				removed: 1,
				titles: ["fix: secret customer thing"],
			})),
		});

		const row = mocks.recordDeploymentCancelAudit.mock.calls[0]?.[0] as {
			metadata: Record<string, unknown>;
		};
		expect(row.metadata).not.toHaveProperty("droppedTitles");
		expect(JSON.stringify(row)).not.toContain("secret customer thing");
		// The build-policy row keeps them, as before.
		const policyRow = mocks.recordBuildPolicyAudit.mock.calls[0]?.[0] as {
			metadata: Record<string, unknown>;
		};
		expect(policyRow.metadata.droppedTitles).toEqual([
			"fix: secret customer thing",
		]);
	});

	it("still writes the cancel trail row when the build-policy write fails", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.recordBuildPolicyAudit.mockRejectedValueOnce(new Error("db down"));

		const out = await buildPolicyDeployGate({
			unitType: "application",
			unit: UNIT,
			changedFiles: ["a.ts"],
			commitMessage: "feat: x",
			removeWaiting: vi.fn(async () => ({ removed: 1 })),
		});

		expect(mocks.recordDeploymentCancelAudit).toHaveBeenCalledTimes(1);
		expect(out).toMatchObject({ deploy: true, coalesced: 1 });
		logged.mockRestore();
	});

	it("still writes the build-policy row when the cancel trail write fails", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.recordDeploymentCancelAudit.mockRejectedValueOnce(new Error("boom"));

		await buildPolicyDeployGate({
			unitType: "application",
			unit: UNIT,
			changedFiles: ["a.ts"],
			commitMessage: "feat: x",
			removeWaiting: vi.fn(async () => ({ removed: 1 })),
		});

		expect(mocks.recordBuildPolicyAudit).toHaveBeenCalledTimes(1);
		logged.mockRestore();
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
