import { isGithubSourcedUnit } from "./source";

/**
 * The whole policy decision, as a pure function.
 *
 * Everything that touches the database lives in `resolve.ts`; this file is the
 * part that is worth reasoning about, and it is exhaustively unit tested.
 */
export type BuildPolicyUnitType = "application" | "compose";

export interface BuildPolicyUnitInput {
	unitType: BuildPolicyUnitType;
	unitId: string;
	sourceType: string;
	customGitUrl?: string | null;
	buildServerId?: string | null;
	buildRegistryId?: string | null;
}

export interface BuildPolicySettingsInput {
	enforceRemoteBuilds: boolean;
	defaultBuildServerId: string | null;
	defaultRegistryId: string | null;
	requiredChecksTimeoutMinutes: number;
}

export interface BuildPolicyBreakGlass {
	auditId: string;
	actorEmail: string;
	reason: string;
}

export interface BuildPolicyDecisionInput {
	unit: BuildPolicyUnitInput;
	settings: BuildPolicySettingsInput | null;
	isExcluded: boolean;
	breakGlass: BuildPolicyBreakGlass | null;
}

export type BuildPolicyLocalReason =
	| "not_enforced"
	| "not_github"
	| "excluded"
	| "break_glass"
	| "compose_build_not_relocatable";

export type BuildPolicyDecision =
	| {
			mode: "local";
			reason: BuildPolicyLocalReason;
			breakGlassAuditId?: string;
	  }
	| { mode: "remote"; buildServerId: string; registryId: string }
	| {
			mode: "error";
			code: "NO_BUILD_SERVER" | "NO_REGISTRY";
			message: string;
	  };

export const decideBuildPolicy = (
	input: BuildPolicyDecisionInput,
): BuildPolicyDecision => {
	const { unit, settings, isExcluded, breakGlass } = input;

	// Policy off (or never configured) — behave exactly like upstream.
	if (!settings?.enforceRemoteBuilds) {
		return { mode: "local", reason: "not_enforced" };
	}

	if (!isGithubSourcedUnit(unit)) {
		return { mode: "local", reason: "not_github" };
	}

	// Checked before break-glass so an exclusion does not burn a grant.
	if (isExcluded) {
		return { mode: "local", reason: "excluded" };
	}

	if (breakGlass) {
		return {
			mode: "local",
			reason: "break_glass",
			breakGlassAuditId: breakGlass.auditId,
		};
	}

	// A compose unit builds and runs in one `docker compose up --build`, so its
	// build cannot be relocated to another host without splitting the deploy in
	// two. That is out of scope for this module; see README.md § Known gap.
	//
	// Which build-policy behaviours a compose unit does and does not get, since
	// this function is where the asymmetry starts:
	//
	// - it DOES get queue coalescing, `[skip deploy]` and derived `watchPaths`
	//   (all at enqueue time, in `buildPolicyDeployGate`), and `requiredChecks`
	//   (in `compose-checks.ts`, between the clone and the build, on the deploy
	//   path, the redeploy path and both preview paths);
	// - it does NOT get exclusions or break-glass, and cannot: both decide where
	//   a unit builds, and this early return means a compose unit is never
	//   enforced, so there is nothing to exclude it from. The router refuses a
	//   `composeId` on both rather than writing a row nothing reads.
	//
	// Keep this list honest. Round-2 review finding A was a comment here, plus
	// the README and the PR body, all claiming compose parity that three of the
	// six behaviours did not have.
	if (unit.unitType === "compose") {
		return { mode: "local", reason: "compose_build_not_relocatable" };
	}

	const buildServerId = settings.defaultBuildServerId;
	if (!buildServerId) {
		return {
			mode: "error",
			code: "NO_BUILD_SERVER",
			message:
				"Enforced remote builds are on but this organization has no default build server. " +
				"Set one in Settings, exclude this unit, or use the audited break-glass action. " +
				"Falling back to a local build is deliberately not offered.",
		};
	}

	const registryId = settings.defaultRegistryId;
	if (!registryId) {
		return {
			mode: "error",
			code: "NO_REGISTRY",
			message:
				"Enforced remote builds are on but this organization has no default registry, " +
				"so a remote build could not be pushed or deployed by digest. Set one in Settings.",
		};
	}

	return { mode: "remote", buildServerId, registryId };
};
