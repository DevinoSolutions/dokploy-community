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
 * D — the deploy-hook allowlist was built from the unit's own registry first,
 *     while an enforced build always publishes to the organization default, so
 *     the two could name different repositories.
 */

const mocks = vi.hoisted(() => ({
	isBuildPolicyEnforcedAnywhere: vi.fn(),
	findBuildPolicySettings: vi.fn(),
	recordBuildPolicyAudit: vi.fn().mockResolvedValue(undefined),
	environmentsFindFirst: vi.fn(),
	findRegistryByIdWithCredentials: vi.fn(),
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

vi.mock("@dokploy/server/services/registry", () => ({
	findRegistryByIdWithCredentials: mocks.findRegistryByIdWithCredentials,
}));

import {
	buildPolicyDeployGate,
	resolveDeployHookImage,
} from "@dokploy/server/services/build-policy/webhook";

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

describe("finding D — the allowlist follows the publish target", () => {
	const registry = (registryId: string, url: string) => ({
		registryId,
		registryUrl: url,
		imagePrefix: null,
		username: "devino",
		password: "unused",
		registryType: "cloud",
	});

	it("validates against the organization default, which is where an enforced build publishes", async () => {
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(
			registry("reg-default", "ghcr.io") as any,
		);

		const result = await resolveDeployHookImage(
			{
				organizationId: "org-1",
				appName: "sendly-web",
				// A stale registry from a previous Docker-provider configuration.
				registryId: "reg-stale",
				buildRegistryId: null,
			},
			{
				image: "ghcr.io/devino/sendly-web",
				digest: `sha256:${"a".repeat(64)}`,
			},
		);

		expect(mocks.findRegistryByIdWithCredentials).toHaveBeenCalledWith(
			"reg-default",
		);
		expect(result.ok).toBe(true);
	});

	it("falls back to the unit's own registry only when the org has no default", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue({
			...ENFORCING,
			defaultRegistryId: null,
		});
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(
			registry("reg-own", "registry.example.com") as any,
		);

		await resolveDeployHookImage(
			{
				organizationId: "org-1",
				appName: "sendly-web",
				registryId: "reg-own",
				buildRegistryId: "reg-build",
			},
			{
				image: "registry.example.com/devino/sendly-web",
				digest: `sha256:${"b".repeat(64)}`,
			},
		);

		expect(mocks.findRegistryByIdWithCredentials).toHaveBeenCalledWith(
			"reg-own",
		);
	});

	it("still refuses a digest on a repository the enforced build never writes to", async () => {
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(
			registry("reg-default", "ghcr.io") as any,
		);

		const result = await resolveDeployHookImage(
			{
				organizationId: "org-1",
				appName: "sendly-web",
				registryId: "reg-stale",
				buildRegistryId: null,
			},
			{
				image: "ghcr.io/someone-else/sendly-web",
				digest: `sha256:${"c".repeat(64)}`,
			},
		);

		expect(result.ok).toBe(false);
	});

	it("is still inert while the policy is off", async () => {
		mocks.isBuildPolicyEnforcedAnywhere.mockResolvedValue(false);

		const result = await resolveDeployHookImage(
			{
				organizationId: "org-1",
				appName: "sendly-web",
				registryId: "reg-stale",
				buildRegistryId: null,
			},
			{ image: "ghcr.io/anyone/anything", digest: `sha256:${"d".repeat(64)}` },
		);

		expect(result.ok).toBe(true);
		expect(mocks.findRegistryByIdWithCredentials).not.toHaveBeenCalled();
	});
});
