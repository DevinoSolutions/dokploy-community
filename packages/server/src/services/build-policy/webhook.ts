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
import { previewBuildPolicyDecision } from "./resolve";
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
	/**
	 * Source type and every build-path column, because the derived watch paths
	 * have to read the one this unit actually builds from — see
	 * `buildPathForSource`. Passing only `buildPath` was round-3 finding K.
	 */
	sourceType?: string | null;
	buildPath?: string | null;
	gitlabBuildPath?: string | null;
	bitbucketBuildPath?: string | null;
	giteaBuildPath?: string | null;
	dropBuildPath?: string | null;
	customGitBuildPath?: string | null;
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

/**
 * How many changed paths a `deploy_skipped` audit row stores.
 *
 * The row exists so an operator can answer "why did my push not deploy", which
 * needs the derived paths, the total, and enough of a sample to recognise the
 * push. It does not need the whole list: a monorepo-wide change touches
 * thousands of paths and this row is written once per skipped webhook delivery.
 * Round-3 nit N9.
 */
const AUDIT_CHANGED_FILES_LIMIT = 50;

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
			sourceType: unit.sourceType,
			buildPath: unit.buildPath,
			gitlabBuildPath: unit.gitlabBuildPath,
			bitbucketBuildPath: unit.bitbucketBuildPath,
			giteaBuildPath: unit.giteaBuildPath,
			dropBuildPath: unit.dropBuildPath,
			customGitBuildPath: unit.customGitBuildPath,
			dockerfile: unit.dockerfile,
			dockerContextPath: unit.dockerContextPath,
			composePath: unit.composePath,
		});
		if (!shouldDeploy(paths, changedFiles)) {
			const message = `Deployment skipped: no changed file matched the derived watch paths (${paths.join(", ")})`;
			// Audited for the same reason the skip marker is, and with more force:
			// nobody asked for a derived watch path, so "why did my push not
			// deploy" has no other answer at all. Without this row the only trace
			// is a 301 on a webhook delivery nobody reads. Round-2 review
			// finding B.
			await recordBuildPolicyAudit({
				organizationId,
				action: "deploy_skipped",
				applicationId: unitType === "application" ? unit.unitId : null,
				composeId: unitType === "compose" ? unit.unitId : null,
				reason: message,
				metadata: {
					unitName: unit.unitName,
					derivedWatchPaths: paths,
					changedFilesCount: changedFiles.length,
					changedFilesTruncated:
						changedFiles.length > AUDIT_CHANGED_FILES_LIMIT,
					changedFiles: changedFiles.slice(0, AUDIT_CHANGED_FILES_LIMIT),
				},
			});
			return { deploy: false, reason: "watch_paths", message };
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
	/**
	 * Where this unit's image lives when the policy does **not** relocate its
	 * build — an excluded unit, a break-glassed one, or a non-GitHub source.
	 */
	registryId?: string | null;
	buildRegistryId?: string | null;
	/** Everything the plan needs to say whether this unit would be enforced. */
	unitType: BuildPolicyUnitType;
	unitId: string;
	unitName: string;
	sourceType: string;
	customGitUrl?: string | null;
	buildServerId?: string | null;
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
		// Gate 2: exactly one acceptable repository, the one this unit's image
		// will actually live on.
		//
		// That is not a fixed precedence, it is whatever the plan would decide,
		// so ask the plan. An enforced unit publishes to
		// `settings.defaultRegistryId` (`policy.ts`), and a unit the policy
		// leaves local — excluded, break-glassed, or not GitHub sourced —
		// publishes to its own registry exactly as it did before the fork.
		//
		// Round-2 finding D fixed this in one direction by putting the org
		// default first, and round-3 finding I caught the other: gate 1 above
		// tests whether the *organization* enforces, not whether *this unit* is
		// enforced, so the capability is live for local units too and a fixed
		// precedence gets one of the two cases wrong whichever way it points.
		//
		// `previewBuildPolicyDecision` is the read-only sibling of
		// `resolveBuildPolicy`: it spends no break-glass grant and writes no
		// audit row, because validating a request body must not consume a
		// one-shot grant that belongs to the next deploy.
		const { decision } = await previewBuildPolicyDecision({
			unitType: unit.unitType,
			unitId: unit.unitId,
			unitName: unit.unitName,
			organizationId: unit.organizationId,
			sourceType: unit.sourceType,
			customGitUrl: unit.customGitUrl,
			buildServerId: unit.buildServerId,
			buildRegistryId: unit.buildRegistryId,
		});

		const registryId =
			decision.mode === "remote"
				? decision.registryId
				: (unit.registryId ??
					unit.buildRegistryId ??
					settings.defaultRegistryId);
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
