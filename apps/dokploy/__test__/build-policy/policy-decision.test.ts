import { describe, expect, it } from "vitest";
import {
	decideBuildPolicy,
	type BuildPolicyDecisionInput,
} from "@dokploy/server/services/build-policy/policy";

const settings = (overrides: Record<string, unknown> = {}) => ({
	enforceRemoteBuilds: true,
	defaultBuildServerId: "build-server-1",
	defaultRegistryId: "registry-1",
	requiredChecksTimeoutMinutes: 30,
	...overrides,
});

const githubApp = (overrides: Record<string, unknown> = {}) => ({
	unitType: "application" as const,
	unitId: "app-1",
	sourceType: "github",
	customGitUrl: null,
	buildServerId: null,
	buildRegistryId: null,
	...overrides,
});

const input = (
	overrides: Partial<BuildPolicyDecisionInput> = {},
): BuildPolicyDecisionInput => ({
	unit: githubApp(),
	settings: settings(),
	isExcluded: false,
	breakGlass: null,
	...overrides,
});

describe("decideBuildPolicy", () => {
	describe("when enforcement is off", () => {
		it("leaves the unit alone with reason not_enforced", () => {
			const decision = decideBuildPolicy(
				input({ settings: settings({ enforceRemoteBuilds: false }) }),
			);
			expect(decision).toEqual({ mode: "local", reason: "not_enforced" });
		});

		it("treats a missing settings row as enforcement off", () => {
			const decision = decideBuildPolicy(input({ settings: null }));
			expect(decision).toEqual({ mode: "local", reason: "not_enforced" });
		});

		it("does not consume a break-glass grant", () => {
			const decision = decideBuildPolicy(
				input({
					settings: null,
					breakGlass: {
						auditId: "audit-1",
						actorEmail: "a@example.com",
						reason: "hotfix",
					},
				}),
			);
			expect(decision).toEqual({ mode: "local", reason: "not_enforced" });
		});
	});

	describe("source gating", () => {
		it("enforces a remote build for a github-sourced application", () => {
			expect(decideBuildPolicy(input())).toEqual({
				mode: "remote",
				buildServerId: "build-server-1",
				registryId: "registry-1",
			});
		});

		it("enforces a remote build for a git source hosted on github.com", () => {
			const decision = decideBuildPolicy(
				input({
					unit: githubApp({
						sourceType: "git",
						customGitUrl: "https://github.com/DevinoSolutions/sendly.git",
					}),
				}),
			);
			expect(decision).toEqual({
				mode: "remote",
				buildServerId: "build-server-1",
				registryId: "registry-1",
			});
		});

		it("leaves a git source on another host alone", () => {
			const decision = decideBuildPolicy(
				input({
					unit: githubApp({
						sourceType: "git",
						customGitUrl: "https://gitlab.com/acme/thing.git",
					}),
				}),
			);
			expect(decision).toEqual({ mode: "local", reason: "not_github" });
		});

		it.each(["docker", "gitlab", "bitbucket", "gitea", "drop", "raw"])(
			"leaves a %s source alone",
			(sourceType) => {
				const decision = decideBuildPolicy(
					input({ unit: githubApp({ sourceType }) }),
				);
				expect(decision).toEqual({ mode: "local", reason: "not_github" });
			},
		);
	});

	describe("exclusions", () => {
		it("keeps an excluded unit on a local build", () => {
			const decision = decideBuildPolicy(input({ isExcluded: true }));
			expect(decision).toEqual({ mode: "local", reason: "excluded" });
		});

		it("prefers the exclusion over a break-glass grant so the grant is not burned", () => {
			const decision = decideBuildPolicy(
				input({
					isExcluded: true,
					breakGlass: {
						auditId: "audit-1",
						actorEmail: "a@example.com",
						reason: "hotfix",
					},
				}),
			);
			expect(decision).toEqual({ mode: "local", reason: "excluded" });
		});

		it("excludes a unit even when no build server is configured", () => {
			const decision = decideBuildPolicy(
				input({
					isExcluded: true,
					settings: settings({ defaultBuildServerId: null }),
				}),
			);
			expect(decision).toEqual({ mode: "local", reason: "excluded" });
		});
	});

	describe("break glass", () => {
		it("allows one local build and reports the grant that was used", () => {
			const decision = decideBuildPolicy(
				input({
					breakGlass: {
						auditId: "audit-1",
						actorEmail: "ops@example.com",
						reason: "registry outage",
					},
				}),
			);
			expect(decision).toEqual({
				mode: "local",
				reason: "break_glass",
				breakGlassAuditId: "audit-1",
			});
		});

		it("wins over a missing build server, because it is the manual escape hatch", () => {
			const decision = decideBuildPolicy(
				input({
					settings: settings({ defaultBuildServerId: null }),
					breakGlass: {
						auditId: "audit-2",
						actorEmail: "ops@example.com",
						reason: "build server down",
					},
				}),
			);
			expect(decision).toEqual({
				mode: "local",
				reason: "break_glass",
				breakGlassAuditId: "audit-2",
			});
		});
	});

	describe("no silent local fallback", () => {
		it("errors when enforcement is on and no build server is available", () => {
			const decision = decideBuildPolicy(
				input({ settings: settings({ defaultBuildServerId: null }) }),
			);
			expect(decision.mode).toBe("error");
			if (decision.mode !== "error") throw new Error("unreachable");
			expect(decision.code).toBe("NO_BUILD_SERVER");
			expect(decision.message).toMatch(/build server/i);
		});

		it("errors when enforcement is on and no registry is available", () => {
			const decision = decideBuildPolicy(
				input({ settings: settings({ defaultRegistryId: null }) }),
			);
			expect(decision.mode).toBe("error");
			if (decision.mode !== "error") throw new Error("unreachable");
			expect(decision.code).toBe("NO_REGISTRY");
			expect(decision.message).toMatch(/registry/i);
		});

		it("never falls back to the per-unit build server when the org has none", () => {
			const decision = decideBuildPolicy(
				input({
					settings: settings({ defaultBuildServerId: null }),
					unit: githubApp({ buildServerId: "some-other-server" }),
				}),
			);
			expect(decision.mode).toBe("error");
		});
	});

	describe("overriding the per-unit field", () => {
		it("replaces a per-unit build server with the org default", () => {
			const decision = decideBuildPolicy(
				input({
					unit: githubApp({
						buildServerId: "stale-server",
						buildRegistryId: "stale-registry",
					}),
				}),
			);
			expect(decision).toEqual({
				mode: "remote",
				buildServerId: "build-server-1",
				registryId: "registry-1",
			});
		});
	});

	describe("compose units", () => {
		it("does not relocate a compose build, and says so explicitly", () => {
			const decision = decideBuildPolicy(
				input({
					unit: {
						unitType: "compose",
						unitId: "compose-1",
						sourceType: "github",
						customGitUrl: null,
						buildServerId: null,
						buildRegistryId: null,
					},
				}),
			);
			expect(decision).toEqual({
				mode: "local",
				reason: "compose_build_not_relocatable",
			});
		});
	});
});
