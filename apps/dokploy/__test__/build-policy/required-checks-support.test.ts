import { BuildPolicyError } from "@dokploy/server/services/build-policy/errors";
import {
	assertRequiredChecksSupported,
	assertRequiredChecksSupportedForUpdate,
	describeRequiredChecksSupport,
} from "@dokploy/server/services/build-policy/source";
import { describe, expect, it } from "vitest";

/**
 * Round-2 review finding F. `parseGithubOwnerRepo` exists so a
 * `sourceType: "git"` unit can still be check-gated, and `resolveOwnerRepo`
 * duly falls back to it — but the check reader two functions below hard-requires
 * a GitHub App provider, so a unit that never had one resolved its owner/repo
 * and then threw on the very next step. The build had already been tagged and
 * pushed by then, and the message did not say the fix was to connect the App.
 *
 * The fallback is kept, because it genuinely works for the unit it was written
 * for: `saveGitProvider` (`routers/application.ts:722`) sets `sourceType: "git"`
 * without clearing `githubId`, so a unit moved from the App to a plain git
 * remote keeps a usable token. What is added is the refusal at the API
 * boundary, so an unsupported configuration is rejected when the operator types
 * it rather than on every deploy for ever after.
 */

const githubApp = {
	unitName: "sendly-web",
	sourceType: "github",
	githubId: "gh-1",
	owner: "DevinoSolutions",
	repository: "sendly",
	customGitUrl: null,
};

describe("describeRequiredChecksSupport", () => {
	it("supports a GitHub App unit with an owner and a repository", () => {
		expect(describeRequiredChecksSupport(githubApp)).toEqual({
			supported: true,
		});
	});

	it("supports a sourceType 'git' github.com unit that kept its GitHub App id", () => {
		expect(
			describeRequiredChecksSupport({
				...githubApp,
				sourceType: "git",
				owner: null,
				repository: null,
				customGitUrl: "https://github.com/DevinoSolutions/sendly.git",
			}),
		).toEqual({ supported: true });
	});

	it("supports the scp-like git remote form too", () => {
		expect(
			describeRequiredChecksSupport({
				...githubApp,
				sourceType: "git",
				owner: null,
				repository: null,
				customGitUrl: "git@github.com:DevinoSolutions/sendly.git",
			}),
		).toEqual({ supported: true });
	});

	it("refuses a github.com git remote with no GitHub App provider — finding F", () => {
		const result = describeRequiredChecksSupport({
			...githubApp,
			sourceType: "git",
			githubId: null,
			owner: null,
			repository: null,
			customGitUrl: "https://github.com/DevinoSolutions/sendly.git",
		});
		expect(result.supported).toBe(false);
		expect(result.supported === false && result.reason).toContain("GitHub App");
		// The operator has to be told what to do, not just what went wrong.
		expect(result.supported === false && result.reason).toContain("sendly-web");
	});

	it("refuses a GitHub App unit whose id was disconnected", () => {
		const result = describeRequiredChecksSupport({
			...githubApp,
			githubId: null,
		});
		expect(result.supported).toBe(false);
	});

	it("refuses a unit that is not sourced from github.com at all", () => {
		for (const unit of [
			{ ...githubApp, sourceType: "gitlab", githubId: null },
			{ ...githubApp, sourceType: "docker", githubId: null },
			{
				...githubApp,
				sourceType: "git",
				githubId: null,
				customGitUrl: "https://gitlab.com/group/repo.git",
			},
			{
				...githubApp,
				sourceType: "git",
				githubId: null,
				customGitUrl: "https://github.enterprise.example.com/org/repo.git",
			},
		]) {
			const result = describeRequiredChecksSupport(unit);
			expect(result.supported).toBe(false);
			expect(result.supported === false && result.reason).toContain(
				"github.com",
			);
		}
	});

	it("refuses a GitHub App unit whose repository is not resolvable", () => {
		const result = describeRequiredChecksSupport({
			...githubApp,
			owner: null,
			repository: null,
		});
		expect(result.supported).toBe(false);
		expect(result.supported === false && result.reason).toContain("repository");
	});
});

describe("assertRequiredChecksSupported", () => {
	it("is a no-op when no required checks are being set", () => {
		expect(() =>
			assertRequiredChecksSupported(
				{ ...githubApp, githubId: null },
				undefined,
			),
		).not.toThrow();
		expect(() =>
			assertRequiredChecksSupported({ ...githubApp, githubId: null }, null),
		).not.toThrow();
		expect(() =>
			assertRequiredChecksSupported({ ...githubApp, githubId: null }, []),
		).not.toThrow();
	});

	it("lets an operator clear an unsupported unit's checks", () => {
		expect(() =>
			assertRequiredChecksSupported(
				{ ...githubApp, sourceType: "gitlab", githubId: null },
				[],
			),
		).not.toThrow();
	});

	it("ignores blank names, which are not a real gate", () => {
		expect(() =>
			assertRequiredChecksSupported({ ...githubApp, githubId: null }, [
				"",
				" ",
			]),
		).not.toThrow();
	});

	it("throws a coded BuildPolicyError when the unit cannot be check-gated", () => {
		try {
			assertRequiredChecksSupported({ ...githubApp, githubId: null }, [
				"build",
			]);
			throw new Error("expected assertRequiredChecksSupported to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(BuildPolicyError);
			expect((error as BuildPolicyError).code).toBe(
				"REQUIRED_CHECKS_UNSUPPORTED",
			);
		}
	});

	it("passes a supported unit through", () => {
		expect(() =>
			assertRequiredChecksSupported(githubApp, ["build", "test"]),
		).not.toThrow();
	});
});

describe("assertRequiredChecksSupportedForUpdate", () => {
	const stored = {
		unitName: "sendly-web",
		sourceType: "github",
		githubId: "gh-1",
		owner: "DevinoSolutions",
		repository: "sendly",
		customGitUrl: null,
	};

	it("validates against the stored row when the patch touches only the checks", () => {
		expect(() =>
			assertRequiredChecksSupportedForUpdate(stored, {
				requiredChecks: ["build"],
			}),
		).not.toThrow();
	});

	it("honours a source change made in the same call", () => {
		// Moving the unit to GitLab and setting a check in one update must be
		// refused on the new source type, not accepted on the stored one.
		expect(() =>
			assertRequiredChecksSupportedForUpdate(stored, {
				sourceType: "gitlab",
				requiredChecks: ["build"],
			}),
		).toThrow(BuildPolicyError);
	});

	it("honours an explicit null in the patch rather than falling back", () => {
		// `githubId: null` in the patch disconnects the App; `??` would have
		// silently kept the stored id and let the write through.
		expect(() =>
			assertRequiredChecksSupportedForUpdate(stored, {
				githubId: null,
				requiredChecks: ["build"],
			}),
		).toThrow(BuildPolicyError);
	});

	it("accepts a patch that makes an unsupported unit supported", () => {
		expect(() =>
			assertRequiredChecksSupportedForUpdate(
				{ ...stored, githubId: null },
				{ githubId: "gh-2", requiredChecks: ["build"] },
			),
		).not.toThrow();
	});

	it("is a no-op when the patch does not set requiredChecks at all", () => {
		expect(() =>
			assertRequiredChecksSupportedForUpdate(
				{ ...stored, githubId: null },
				{ owner: "someone-else" },
			),
		).not.toThrow();
	});
});
