import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema";
import {
	describeUnreadableCommit,
	isCommitSha,
	parseCheckedOutCommit,
} from "@dokploy/server/utils/providers/pin-commit";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { updateDeployment } from "./deployment";
import type { Patch } from "./patch";

/**
 * Rebuild pin for build-server composes (T-7960).
 *
 * A deploy clones the source into a code directory it has just emptied, so
 * the commit read there right after the fetch is the commit that was really
 * fetched. A rebuild clones nothing: it builds the checkout earlier steps left
 * on disk, and the build server is pinned to whatever commit that checkout
 * reports. So a deploy that passed its checks records what it built on its
 * deployment row: that commit, the build server, and a digest of the enabled
 * patch rows. A rebuild builds only when the checkout on disk still reports
 * that commit and the build server and the patch rows are still the same.
 *
 * - The record is written only after the compose checks and the required
 *   checks passed, never by a deploy they refused: a refused deploy leaves its
 *   commit on disk, and the previous record no longer matches it.
 * - The record is the latest compose deployment row that has one. A rebuild
 *   that passed the check carries it forward on its own row, so pruning old
 *   deployment rows does not drop it after a run of rebuilds.
 * - No record (a compose last deployed before this check existed, or before it
 *   had a build server), a record that is not a full commit id, a checkout
 *   whose commit cannot be read, another commit, another build server or other
 *   patch rows: the rebuild is refused before anything is touched, and the
 *   message says to deploy. A deploy fetches again and records again.
 * - Composes without a build server and raw composes are not pinned: they
 *   build the files on the serving host itself, the files its guards checked.
 */

/** A rebuild the pin refused before anything was touched. */
export class RebuildRefusedError extends Error {
	readonly rebuildRefused = true;
	/** The status the compose was put back to (the queue may restore its own). */
	settledStatus?: "done" | "idle";

	constructor(message: string) {
		super(message);
		this.name = "RebuildRefusedError";
	}
}

/** Duck-typed, like `isDeploymentCancelledError`: a bundle can hold two copies. */
export const isRebuildRefusedError = (
	error: unknown,
): error is RebuildRefusedError =>
	error instanceof RebuildRefusedError ||
	(error instanceof Error &&
		(error as { rebuildRefused?: unknown }).rebuildRefused === true);

/**
 * Digest of the patch rows that apply (the enabled ones), independent of the
 * order they were loaded in. Covers what decides the applied tree: the row,
 * its type, its path and its content.
 */
export const digestAppliedPatches = (rows: Patch[] | undefined) => {
	const applied = (rows ?? [])
		.filter((row) => row.enabled)
		.map((row) => [row.patchId, row.type, row.filePath, row.content] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return createHash("sha256").update(JSON.stringify(applied)).digest("hex");
};

/**
 * Records what a deploy that passed its checks built on `deploymentId`: the
 * commit `readServingHostCommitOutput` read right after its fetch, the build
 * server and the applied patch rows. Records nothing when the read is not a
 * full commit id; prepare refuses that deploy anyway.
 */
export const recordDeployedCommit = async (
	deploymentId: string | undefined,
	{
		servingCommitOutput,
		buildServerId,
		patches,
	}: {
		servingCommitOutput: string | undefined;
		buildServerId: string | null | undefined;
		patches: Patch[] | undefined;
	},
) => {
	const commit = parseCheckedOutCommit(servingCommitOutput);
	if (!deploymentId || !commit || !buildServerId) return null;
	await updateDeployment(deploymentId, {
		pinnedCommit: commit,
		pinnedBuildServerId: buildServerId,
		pinnedPatchDigest: digestAppliedPatches(patches),
	});
	return commit;
};

/** What the compose's latest recording deployment built, as stored. */
export const findLastRecordedComposeCommit = async (composeId: string) => {
	const row = await db.query.deployments.findFirst({
		columns: {
			pinnedCommit: true,
			pinnedBuildServerId: true,
			pinnedPatchDigest: true,
		},
		where: and(
			eq(deployments.composeId, composeId),
			isNotNull(deployments.pinnedCommit),
		),
		orderBy: [desc(deployments.createdAt)],
	});
	return row?.pinnedCommit ? row : null;
};

/**
 * Refuses a build-server compose rebuild unless the serving host's checkout
 * (`servingCommitOutput`, read at the start of the rebuild) is the commit the
 * last deploy recorded, and `buildServerId` and the patch rows the rebuild
 * applies are the ones it recorded. On a match the record is carried forward
 * on the rebuild's own row and the commit returned. Every refusal is a
 * `RebuildRefusedError`.
 */
export const assertRebuildCommitMatchesDeploy = async ({
	composeId,
	deploymentId,
	servingCommitOutput,
	buildServerId,
	patches,
}: {
	composeId: string;
	deploymentId: string;
	servingCommitOutput: string | undefined;
	buildServerId: string | null | undefined;
	patches: Patch[] | undefined;
}) => {
	const recorded = await findLastRecordedComposeCommit(composeId);
	if (!recorded) {
		throw new RebuildRefusedError(
			"No deploy of this compose recorded the commit it checked out (it was last deployed before rebuilds checked this, or before it had a build server). A rebuild only builds the commit the last deploy checked out, so nothing was built. Deploy it once; rebuilds work again after that.",
		);
	}
	const commit = recorded.pinnedCommit;
	// Never used in a command, but held to the same form as every pin.
	if (!isCommitSha(commit)) {
		throw new RebuildRefusedError(
			"The commit recorded by the last deploy is not a full commit id, so the rebuild cannot check the code on disk against it. Nothing was built; deploy again.",
		);
	}
	const onDisk = parseCheckedOutCommit(servingCommitOutput);
	if (!onDisk) {
		throw new RebuildRefusedError(
			`Could not read the commit checked out on the serving host (${describeUnreadableCommit(servingCommitOutput)}), so the rebuild cannot check it against commit ${commit} that the last deploy checked out. Nothing was built; deploy again.`,
		);
	}
	if (onDisk !== commit) {
		throw new RebuildRefusedError(
			`The code on the serving host is commit ${onDisk}, not commit ${commit} that the last deploy checked out. A rebuild only builds the commit the last deploy checked out, so nothing was built. Deploy to build the current code.`,
		);
	}
	if (!buildServerId || recorded.pinnedBuildServerId !== buildServerId) {
		throw new RebuildRefusedError(
			"The compose builds on another build server than at its last deploy. A rebuild only builds what the last deploy built, so nothing was built. Deploy it once; rebuilds work again after that.",
		);
	}
	const patchDigest = digestAppliedPatches(patches);
	if (recorded.pinnedPatchDigest !== patchDigest) {
		throw new RebuildRefusedError(
			"The compose's patches changed since its last deploy. A rebuild only builds what the last deploy built, so nothing was built. Deploy it once; rebuilds work again after that.",
		);
	}
	await updateDeployment(deploymentId, {
		pinnedCommit: commit,
		pinnedBuildServerId: buildServerId,
		pinnedPatchDigest: patchDigest,
	});
	return commit;
};
