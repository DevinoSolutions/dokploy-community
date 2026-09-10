import { db } from "@dokploy/server/db";
import { environments } from "@dokploy/server/db/schema";
import { getRegistryTag } from "@dokploy/server/utils/cluster/upload";
import { shouldDeploy } from "@dokploy/server/utils/watch-paths/should-deploy";
import { eq } from "drizzle-orm";
import { findRegistryByIdWithCredentials } from "../registry";
import { recordBuildPolicyAudit } from "./audit";
import {
	type CoalesceQueuedDeployInput,
	coalesceQueuedDeploy,
} from "./coalesce";
import { parseDeployHookImage } from "./hook-body";
import { toPinnedImageJob } from "./pinned-deploy";
import type { BuildPolicyUnitType } from "./policy";
import {
	findBuildPolicySettings,
	isBuildPolicyEnforcedAnywhere,
} from "./settings";
import { matchedSkipDeployMarker } from "./skip-deploy";
import { resolveWatchPaths } from "./watch-paths";

export type PinnedImageJob = {
	ref: string;
	tag: string | null;
	digest: string;
};

/**
 * The single gate every deploy entry point calls just before enqueueing.
 *
 * It does the three things that have to happen at enqueue time and nowhere
 * else: honour `[skip deploy]`, apply the derived default `watchPaths` when the
 * unit has none, and coalesce the deploys that are still waiting for this unit.
 *
 * **All three only happen while the organization enforces remote builds.** With
 * the policy off the gate is a no-op that reads nothing and drops nothing, so
 * the deploy entry points behave exactly as upstream does. That matters because
 * a derived watch path silently *stops* deploys, which is the last thing a team
 * should discover by accident after a fork upgrade.
 *
 * It is intentionally the only build-policy touch point in the webhook and
 * deploy-hook routes, so an upstream merge has one place to reconcile.
 */
export interface BuildPolicyGateUnit {
	unitId: string;
	unitName: string;
	environmentId: string;
	watchPaths?: string[] | null;
	buildPath?: string | null;
	dockerfile?: string | null;
	dockerContextPath?: string | null;
	composePath?: string | null;
}

export type BuildPolicyGateResult =
	| { deploy: true; coalesced: number }
	| {
			deploy: false;
			reason: "skip_deploy_marker" | "watch_paths";
			message: string;
	  };

const PASS: BuildPolicyGateResult = { deploy: true, coalesced: 0 };

const findOrganizationId = async (
	environmentId: string,
): Promise<string | null> => {
	const environment = await db.query.environments.findFirst({
		where: eq(environments.environmentId, environmentId),
		with: { project: true },
	});
	return environment?.project?.organizationId ?? null;
};

export const buildPolicyDeployGate = async ({
	unitType,
	unit,
	changedFiles,
	commitMessage,
	removeWaiting,
}: {
	unitType: BuildPolicyUnitType;
	unit: BuildPolicyGateUnit;
	/** Paths touched by the push, or null when the caller has no file list. */
	changedFiles?: string[] | null;
	commitMessage?: string | null;
	/**
	 * Drops this unit's still-waiting plain deploys (never its previews) and
	 * reports how many, and ideally their titles.
	 */
	removeWaiting: CoalesceQueuedDeployInput["removeWaiting"];
}): Promise<BuildPolicyGateResult> => {
	// Cheap cached check first: on an instance where nobody enforces, this is
	// the only thing the gate does.
	if (!(await isBuildPolicyEnforcedAnywhere())) return PASS;

	const organizationId = await findOrganizationId(unit.environmentId);
	if (!organizationId) return PASS;

	const settings = await findBuildPolicySettings(organizationId);
	if (!settings?.enforceRemoteBuilds) return PASS;

	const marker = matchedSkipDeployMarker(commitMessage);
	if (marker) {
		const message = `Deployment skipped: the commit message contains ${marker}`;
		await recordBuildPolicyAudit({
			organizationId,
			action: "deploy_skipped",
			applicationId: unitType === "application" ? unit.unitId : null,
			composeId: unitType === "compose" ? unit.unitId : null,
			reason: message,
			metadata: { unitName: unit.unitName, marker },
		});
		return { deploy: false, reason: "skip_deploy_marker", message };
	}

	// Only meaningful when the caller knows which files changed and the unit has
	// no watchPaths of its own; upstream already applied any explicit ones.
	const hasOwnWatchPaths =
		Array.isArray(unit.watchPaths) && unit.watchPaths.length > 0;
	if (!hasOwnWatchPaths && Array.isArray(changedFiles)) {
		const { paths } = resolveWatchPaths(unit.watchPaths, {
			unitType,
			buildPath: unit.buildPath,
			dockerfile: unit.dockerfile,
			dockerContextPath: unit.dockerContextPath,
			composePath: unit.composePath,
		});
		if (!shouldDeploy(paths, changedFiles)) {
			return {
				deploy: false,
				reason: "watch_paths",
				message: `Deployment skipped: no changed file matched the derived watch paths (${paths.join(", ")})`,
			};
		}
	}

	const { removed } = await coalesceQueuedDeploy({
		unitType,
		unitId: unit.unitId,
		unitName: unit.unitName,
		organizationId,
		removeWaiting,
		recordAudit: recordBuildPolicyAudit,
	});

	return { deploy: true, coalesced: removed };
};

/** Does this request body carry an `image` at all? Cheap, no database. */
export const deployHookBodyHasImage = (body: unknown): boolean => {
	const record =
		body !== null && typeof body === "object" && !Array.isArray(body)
			? (body as Record<string, unknown>)
			: null;
	return !!record && record.image !== undefined && record.image !== null;
};

/**
 * Optional deploy-hook body `{image, tag, digest}` (spec 5.2.9).
 *
 * Two gates, both required:
 *
 * 1. The capability does not exist while the policy is off. A deploy hook URL
 *    is a bearer token pasted into CI configs across the fleet; it must not
 *    quietly gain the power to run an arbitrary image the day this merges.
 * 2. The image must be **the unit's own repository** — `<registry>/<prefix>/<appName>` —
 *    not merely a repository on a registry the organization happens to own.
 *    Spec 5.2.9 says "restricted to the unit's configured registry"; an
 *    org-wide host allowlist would let any token deploy any image on ghcr.io.
 */
export interface DeployHookImageUnit {
	organizationId: string | null;
	appName: string;
	/** The unit's own registry, then its build registry, then the org default. */
	registryId?: string | null;
	buildRegistryId?: string | null;
}

export const resolveDeployHookImage = async (
	unit: DeployHookImageUnit,
	body: unknown,
): Promise<
	{ ok: true; pinnedImage?: PinnedImageJob } | { ok: false; message: string }
> => {
	if (!deployHookBodyHasImage(body)) return { ok: true };

	// Gate 1: capability off while the policy is off.
	if (!(await isBuildPolicyEnforcedAnywhere())) return { ok: true };
	if (!unit.organizationId) return { ok: true };
	const settings = await findBuildPolicySettings(unit.organizationId);
	if (!settings?.enforceRemoteBuilds) return { ok: true };

	try {
		// Gate 2: exactly one acceptable repository, the unit's own.
		const registryId =
			unit.registryId ?? unit.buildRegistryId ?? settings.defaultRegistryId;
		if (!registryId) {
			return {
				ok: false,
				message:
					"A deploy hook image was supplied but this unit has no registry " +
					"configured and the organization has no default, so there is no " +
					"repository to validate it against.",
			};
		}
		const registry = await findRegistryByIdWithCredentials(registryId);
		const allowedRepository = getRegistryTag(registry, unit.appName);
		const parsed = parseDeployHookImage(body, [allowedRepository]);
		return { ok: true, pinnedImage: toPinnedImageJob(parsed) };
	} catch (error) {
		return {
			ok: false,
			message:
				error instanceof Error ? error.message : "Invalid deploy hook image",
		};
	}
};

/**
 * A compose unit cannot deploy a supplied image by digest (see README.md
 * § Known gap), so an enforcing organization is told so with a 400 rather than
 * having the body silently ignored.
 *
 * While the policy is off this returns `ok` and the body is ignored, exactly as
 * upstream ignores it. Turning a request upstream accepts into a 400 the day
 * this merges is the same mistake as gating a deploy on a derived watch path
 * nobody configured.
 */
export const rejectComposeDeployHookImage = async (
	environmentId: string,
	body: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> => {
	if (!deployHookBodyHasImage(body)) return { ok: true };
	if (!(await isBuildPolicyEnforcedAnywhere())) return { ok: true };
	const organizationId = await findOrganizationId(environmentId);
	if (!organizationId) return { ok: true };
	const settings = await findBuildPolicySettings(organizationId);
	if (!settings?.enforceRemoteBuilds) return { ok: true };
	return {
		ok: false,
		message:
			"Deploying a supplied image by digest is not supported for compose units.",
	};
};

export const findUnitOrganizationId = findOrganizationId;
