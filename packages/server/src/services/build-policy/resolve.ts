import type { BuildPolicySettings } from "@dokploy/server/db/schema";
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

export const resolveBuildPolicy = async (
	unit: BuildPolicyUnitRef,
	{ consume = true }: { consume?: boolean } = {},
): Promise<ResolvedBuildPolicy> => {
	const settings = await findBuildPolicySettings(unit.organizationId);

	// Nothing else needs reading when the policy is off, which is the common
	// case on an unconfigured instance.
	if (!settings?.enforceRemoteBuilds) {
		return {
			settings,
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
