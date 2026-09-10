import { db } from "@dokploy/server/db";
import { environments } from "@dokploy/server/db/schema";
import { shouldDeploy } from "@dokploy/server/utils/watch-paths/should-deploy";
import { eq } from "drizzle-orm";
import { findAllRegistryByOrganizationId } from "../registry";
import { recordBuildPolicyAudit } from "./audit";
import { coalesceQueuedDeploy } from "./coalesce";
import { parseDeployHookImage } from "./hook-body";
import { toPinnedImageJob } from "./pinned-deploy";
import type { BuildPolicyUnitType } from "./policy";
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
	/** Drops still-waiting jobs for this unit; returns how many it dropped. */
	removeWaiting: () => Promise<number> | number;
}): Promise<BuildPolicyGateResult> => {
	const organizationId = await findOrganizationId(unit.environmentId);

	const marker = matchedSkipDeployMarker(commitMessage);
	if (marker) {
		const message = `Deployment skipped: the commit message contains ${marker}`;
		if (organizationId) {
			await recordBuildPolicyAudit({
				organizationId,
				action: "deploy_skipped",
				applicationId: unitType === "application" ? unit.unitId : null,
				composeId: unitType === "compose" ? unit.unitId : null,
				reason: message,
				metadata: { unitName: unit.unitName, marker },
			});
		}
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

	if (!organizationId) return { deploy: true, coalesced: 0 };

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

/**
 * Optional deploy-hook body `{image, tag, digest}` (spec 5.2.9), validated
 * against the registries this organization has configured.
 *
 * Returns a result union rather than throwing so the route stays four lines.
 */
export const resolveDeployHookImage = async (
	organizationId: string | null,
	body: unknown,
): Promise<
	| { ok: true; pinnedImage?: PinnedImageJob }
	| { ok: false; message: string }
> => {
	try {
		const record =
			body !== null && typeof body === "object" && !Array.isArray(body)
				? (body as Record<string, unknown>)
				: null;
		if (!record || record.image === undefined || record.image === null) {
			return { ok: true };
		}
		if (!organizationId) {
			return {
				ok: false,
				message:
					"A deploy hook image was supplied but this unit's organization could " +
					"not be resolved, so the registry could not be validated.",
			};
		}
		const registries = await findAllRegistryByOrganizationId(organizationId);
		const allowedHosts = registries
			.map((registry) => registry.registryUrl)
			.filter((url): url is string => !!url);
		const parsed = parseDeployHookImage(body, allowedHosts);
		return { ok: true, pinnedImage: toPinnedImageJob(parsed) };
	} catch (error) {
		return {
			ok: false,
			message:
				error instanceof Error ? error.message : "Invalid deploy hook image",
		};
	}
};

export const findUnitOrganizationId = findOrganizationId;
