import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Round-3 review findings I and J, both consequences of round 2's finding D.
 *
 * I — D swapped the allowlist precedence from "the unit's own registry first"
 *     to "the organization default first". For an **enforced** unit that is
 *     exactly right and it fixed the case round 2 named. But gate 1 of
 *     `resolveDeployHookImage` tests whether the *organization* enforces, not
 *     whether *this unit* is enforced, so the capability is live for units the
 *     policy leaves local — excluded, break-glassed, non-GitHub-sourced — and
 *     those publish to their own registry. Their own repository was then
 *     rejected. The divergence was inverted rather than removed.
 * J — nit N2, promoted. An empty `registryUrl` is the supported Docker Hub
 *     configuration, not a misconfiguration, and `getRegistryTag` returns a
 *     repository with no host for it. `hook-body.ts` required a host, so after
 *     the D reorder an organization whose default registry is Docker Hub had
 *     EVERY unit's deploy-hook body rejected.
 *
 * The fix for I is to resolve the registry the way the plan would, which is
 * what `previewBuildPolicyDecision` does — read-only, spending no break-glass
 * grant and writing no audit row. The fix for J is to drop the host
 * requirement, which bought something when the allowlist was a host allowlist
 * and buys nothing now that whole repositories are compared for equality.
 */

const mocks = vi.hoisted(() => ({
	isBuildPolicyEnforcedAnywhere: vi.fn(),
	findBuildPolicySettings: vi.fn(),
	findRegistryByIdWithCredentials: vi.fn(),
	isUnitExcluded: vi.fn(),
	findPendingBreakGlass: vi.fn(),
	consumeBreakGlass: vi.fn(),
	recordBuildPolicyAudit: vi.fn().mockResolvedValue(undefined),
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

vi.mock("@dokploy/server/services/build-policy/exclusions", () => ({
	isUnitExcluded: mocks.isUnitExcluded,
}));

vi.mock("@dokploy/server/services/build-policy/audit", () => ({
	findPendingBreakGlass: mocks.findPendingBreakGlass,
	consumeBreakGlass: mocks.consumeBreakGlass,
	recordBuildPolicyAudit: mocks.recordBuildPolicyAudit,
	grantBreakGlass: vi.fn(),
	listBuildPolicyAudit: vi.fn(),
}));

vi.mock("@dokploy/server/services/registry", () => ({
	findRegistryByIdWithCredentials: mocks.findRegistryByIdWithCredentials,
}));

import { resolveDeployHookImage } from "@dokploy/server/services/build-policy/webhook";

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

const registry = (registryId: string, registryUrl: string) =>
	({
		registryId,
		registryUrl,
		imagePrefix: null,
		username: "devino",
		password: "unused",
		registryType: "cloud",
	}) as any;

/** A GitHub-sourced application, so the policy would enforce it. */
const ENFORCED_UNIT = {
	organizationId: "org-1",
	appName: "sendly-web",
	unitType: "application" as const,
	unitId: "app-1",
	unitName: "Sendly Web",
	sourceType: "github",
	customGitUrl: null,
	registryId: "reg-own",
	buildRegistryId: null,
};

const DIGEST = `sha256:${"a".repeat(64)}`;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isBuildPolicyEnforcedAnywhere.mockResolvedValue(true);
	mocks.findBuildPolicySettings.mockResolvedValue(ENFORCING);
	mocks.isUnitExcluded.mockResolvedValue(false);
	mocks.findPendingBreakGlass.mockResolvedValue(null);
	mocks.recordBuildPolicyAudit.mockResolvedValue(undefined);
});

describe("finding I — the allowlist follows what the plan would decide", () => {
	it("uses the organization default for a unit the policy would enforce", async () => {
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(
			registry("reg-default", "ghcr.io"),
		);

		const result = await resolveDeployHookImage(ENFORCED_UNIT, {
			image: "ghcr.io/devino/sendly-web",
			digest: DIGEST,
		});

		expect(mocks.findRegistryByIdWithCredentials).toHaveBeenCalledWith(
			"reg-default",
		);
		expect(result.ok).toBe(true);
	});

	it("uses the unit's own registry for an EXCLUDED unit — finding I", async () => {
		// An excluded unit builds where it always did and publishes to its own
		// registry, so its own repository must stay allowed.
		mocks.isUnitExcluded.mockResolvedValue(true);
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(
			registry("reg-own", "registry.example.com"),
		);

		const result = await resolveDeployHookImage(ENFORCED_UNIT, {
			image: "registry.example.com/devino/sendly-web",
			digest: DIGEST,
		});

		expect(mocks.findRegistryByIdWithCredentials).toHaveBeenCalledWith(
			"reg-own",
		);
		expect(result.ok).toBe(true);
	});

	it("uses the unit's own registry for a break-glassed unit", async () => {
		mocks.findPendingBreakGlass.mockResolvedValue({
			buildPolicyAuditId: "audit-1",
			actorEmail: "someone@example.com",
			reason: "registry outage",
		});
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(
			registry("reg-own", "registry.example.com"),
		);

		const result = await resolveDeployHookImage(ENFORCED_UNIT, {
			image: "registry.example.com/devino/sendly-web",
			digest: DIGEST,
		});

		expect(mocks.findRegistryByIdWithCredentials).toHaveBeenCalledWith(
			"reg-own",
		);
		expect(result.ok).toBe(true);
	});

	it("never spends the break-glass grant just to validate a body", async () => {
		// The grant is one-shot and belongs to the next deploy. Reading it here
		// must not consume it, and must not write an audit row either.
		mocks.findPendingBreakGlass.mockResolvedValue({
			buildPolicyAuditId: "audit-1",
			actorEmail: "someone@example.com",
			reason: "registry outage",
		});
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(
			registry("reg-own", "registry.example.com"),
		);

		await resolveDeployHookImage(ENFORCED_UNIT, {
			image: "registry.example.com/devino/sendly-web",
			digest: DIGEST,
		});

		expect(mocks.consumeBreakGlass).not.toHaveBeenCalled();
		expect(mocks.recordBuildPolicyAudit).not.toHaveBeenCalled();
	});

	it("uses the unit's own registry for a non-GitHub-sourced unit", async () => {
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(
			registry("reg-own", "registry.example.com"),
		);

		const result = await resolveDeployHookImage(
			{ ...ENFORCED_UNIT, sourceType: "gitlab" },
			{
				image: "registry.example.com/devino/sendly-web",
				digest: DIGEST,
			},
		);

		expect(mocks.findRegistryByIdWithCredentials).toHaveBeenCalledWith(
			"reg-own",
		);
		expect(result.ok).toBe(true);
	});

	it("still refuses a repository neither path would ever publish to", async () => {
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(
			registry("reg-default", "ghcr.io"),
		);

		const result = await resolveDeployHookImage(ENFORCED_UNIT, {
			image: "ghcr.io/someone-else/sendly-web",
			digest: DIGEST,
		});

		expect(result.ok).toBe(false);
	});

	it("falls back to the unit's own registry when the org has no default", async () => {
		mocks.findBuildPolicySettings.mockResolvedValue({
			...ENFORCING,
			defaultRegistryId: null,
		});
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(
			registry("reg-own", "registry.example.com"),
		);

		const result = await resolveDeployHookImage(ENFORCED_UNIT, {
			image: "registry.example.com/devino/sendly-web",
			digest: DIGEST,
		});

		expect(result.ok).toBe(true);
	});

	it("is still inert while the policy is off", async () => {
		mocks.isBuildPolicyEnforcedAnywhere.mockResolvedValue(false);

		const result = await resolveDeployHookImage(ENFORCED_UNIT, {
			image: "ghcr.io/anyone/anything",
			digest: DIGEST,
		});

		expect(result.ok).toBe(true);
		expect(mocks.findRegistryByIdWithCredentials).not.toHaveBeenCalled();
		expect(mocks.isUnitExcluded).not.toHaveBeenCalled();
	});
});

describe("finding J — a Docker Hub default registry no longer rejects every body", () => {
	it("accepts a hostless repository when the allowed repository is hostless too", async () => {
		// registryUrl "" is the supported Docker Hub configuration, so
		// getRegistryTag returns `prefix/app` with no host.
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(
			registry("reg-default", ""),
		);

		const result = await resolveDeployHookImage(ENFORCED_UNIT, {
			image: "devino/sendly-web",
			digest: DIGEST,
		});

		expect(result.ok).toBe(true);
	});

	it("still refuses a different hostless repository", async () => {
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(
			registry("reg-default", ""),
		);

		const result = await resolveDeployHookImage(ENFORCED_UNIT, {
			image: "someone-else/sendly-web",
			digest: DIGEST,
		});

		expect(result.ok).toBe(false);
	});

	it("still refuses a hosted repository when the allowed one is hostless", async () => {
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(
			registry("reg-default", ""),
		);

		const result = await resolveDeployHookImage(ENFORCED_UNIT, {
			image: "ghcr.io/devino/sendly-web",
			digest: DIGEST,
		});

		expect(result.ok).toBe(false);
	});
});
