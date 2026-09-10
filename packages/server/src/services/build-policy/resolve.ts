import type {
	BuildPolicyAudit,
	BuildPolicySettings,
} from "@dokploy/server/db/schema";
import {
	consumeBreakGlass,
	findPendingBreakGlass,
	recordBuildPolicyAudit,
} from "./audit";
import { BuildPolicyError } from "./errors";
import { isUnitExcluded } from "./exclusions";
import {
	type BuildPolicyDecision,
	type BuildPolicyUnitType,
	decideBuildPolicy,
} from "./policy";
import { findBuildPolicySettings } from "./settings";

/**
 * Database-backed wrapper around the pure `decideBuildPolicy`.
 *
 * This is the only place that reads settings, exclusions and break-glass
 * grants, and the only place a grant is spent.
 */
export interface BuildPolicyUnitRef {
	unitType: BuildPolicyUnitType;
	unitId: string;
	unitName: string;
	organizationId: string;
	sourceType: string;
	customGitUrl?: string | null;
	buildServerId?: string | null;
	buildRegistryId?: string | null;
}

export interface ResolvedBuildPolicy {
	decision: BuildPolicyDecision;
	settings: BuildPolicySettings | null;
}

/**
 * The decision, read-only: no grant is spent and no audit row is written.
 *
 * `resolveBuildPolicy` below is the deploy-path entry point and has both of
 * those side effects, which is right for a deploy and wrong for anything that
 * merely wants to *know* what the plan would be. Round-3 review finding I: the
 * deploy-hook allowlist has to resolve the same registry the plan would, and it
 * must not consume a one-shot break-glass grant to do it — the grant belongs to
 * the next deploy.
 *
 * Returns the grant alongside the decision so `resolveBuildPolicy` can spend it
 * without reading it twice.
 */
export const previewBuildPolicyDecision = async (
	unit: BuildPolicyUnitRef,
): Promise<ResolvedBuildPolicy & { grant: BuildPolicyAudit | null }> => {
	const settings = await findBuildPolicySettings(unit.organizationId);

	// Nothing else needs reading when the policy is off, which is the common
	// case on an unconfigured instance.
	if (!settings?.enforceRemoteBuilds) {
		return {
			settings,
			grant: null,
			decision: decideBuildPolicy({
				unit,
				settings,
				isExcluded: false,
				breakGlass: null,
			}),
		};
	}

	const [isExcluded, grant] = await Promise.all([
		isUnitExcluded({
			organizationId: unit.organizationId,
			unitType: unit.unitType,
			unitId: unit.unitId,
		}),
		findPendingBreakGlass({
			organizationId: unit.organizationId,
			unitType: unit.unitType,
			unitId: unit.unitId,
		}),
	]);

	const decision = decideBuildPolicy({
		unit,
		settings,
		isExcluded,
		breakGlass: grant
			? {
					auditId: grant.buildPolicyAuditId,
					actorEmail: grant.actorEmail ?? "unknown",
					reason: grant.reason ?? "",
				}
			: null,
	});

	return { settings, decision, grant };
};

export const resolveBuildPolicy = async (
	unit: BuildPolicyUnitRef,
	{ consume = true }: { consume?: boolean } = {},
): Promise<ResolvedBuildPolicy> => {
	const { settings, decision, grant } = await previewBuildPolicyDecision(unit);

	if (
		consume &&
		grant &&
		decision.mode === "local" &&
		decision.reason === "break_glass"
	) {
		await consumeBreakGlass({
			grant,
			organizationId: unit.organizationId,
			unitType: unit.unitType,
			unitId: unit.unitId,
			metadata: { unitName: unit.unitName },
		});
	}

	if (decision.mode === "error") {
		await recordBuildPolicyAudit({
			organizationId: unit.organizationId,
			action: "build_server_missing",
			applicationId: unit.unitType === "application" ? unit.unitId : null,
			composeId: unit.unitType === "compose" ? unit.unitId : null,
			reason: decision.message,
			metadata: { code: decision.code, unitName: unit.unitName },
		});
	}

	if (decision.mode === "remote") {
		await recordBuildPolicyAudit({
			organizationId: unit.organizationId,
			action: "remote_build_enforced",
			applicationId: unit.unitType === "application" ? unit.unitId : null,
			composeId: unit.unitType === "compose" ? unit.unitId : null,
			metadata: {
				unitName: unit.unitName,
				buildServerId: decision.buildServerId,
				registryId: decision.registryId,
			},
		});
	}

	return { settings, decision };
};

/** Turns an `error` decision into the thrown, named failure the deploy shows. */
export const assertBuildPolicyOk = (
	decision: BuildPolicyDecision,
): BuildPolicyDecision => {
	if (decision.mode === "error") {
		throw new BuildPolicyError(decision.code, decision.message);
	}
	return decision;
};
