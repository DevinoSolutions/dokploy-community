import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema";
import {
	describeUnreadableCommit,
	isCommitSha,
	parseCheckedOutCommit,
} from "@dokploy/server/utils/providers/pin-commit";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { updateDeployment } from "./deployment";

/**
 * Rebuild pin for build-server composes (T-7960).
 *
 * A deploy clones the source into a code directory it has just emptied, so
 * the commit read there right after the fetch is the commit that was really
 * fetched. A rebuild clones nothing: it builds the checkout earlier steps left
 * on disk, and the build server is pinned to whatever commit that checkout
 * reports. So a deploy records its commit on its deployment row, and a rebuild
 * builds only when the checkout on disk still reports that very commit.
 *
 * - The record is the latest compose deployment row that has one. A rebuild
 *   that passed the check carries the same commit forward on its own row, so
 *   pruning old deployment rows never drops the last record.
 * - No record (a compose last deployed before this check existed, or before it
 *   had a build server), a record that is not a full commit id, a checkout
 *   whose commit cannot be read, or a different commit: the rebuild is
 *   refused before anything is touched, and the message says to deploy. A
 *   deploy fetches again and records again.
 * - Composes without a build server and raw composes are not pinned: they
 *   build the files on the serving host itself, the files its guards checked.
 */

/**
 * Records the commit `readServingHostCommitOutput` read right after a deploy's
 * fetch on `deploymentId`. Records nothing when it is not a full commit id;
 * prepare refuses that deploy anyway.
 */
export const recordDeployedCommit = async (
	deploymentId: string | undefined,
	servingCommitOutput: string | undefined,
) => {
	const commit = parseCheckedOutCommit(servingCommitOutput);
	if (!deploymentId || !commit) return null;
	await updateDeployment(deploymentId, { pinnedCommit: commit });
	return commit;
};

/** The commit the compose's latest recording deployment checked out, as stored. */
export const findLastRecordedComposeCommit = async (composeId: string) => {
	const row = await db.query.deployments.findFirst({
		columns: { pinnedCommit: true },
		where: and(
			eq(deployments.composeId, composeId),
			isNotNull(deployments.pinnedCommit),
		),
		orderBy: [desc(deployments.createdAt)],
	});
	return row?.pinnedCommit ?? null;
};

/**
 * Refuses a build-server compose rebuild unless the serving host's checkout
 * (`servingCommitOutput`, read at the start of the rebuild) is the commit the
 * last deploy recorded. On a match the commit is carried forward on the
 * rebuild's own row and returned.
 */
export const assertRebuildCommitMatchesDeploy = async ({
	composeId,
	deploymentId,
	servingCommitOutput,
}: {
	composeId: string;
	deploymentId: string;
	servingCommitOutput: string | undefined;
}) => {
	const recorded = await findLastRecordedComposeCommit(composeId);
	if (!recorded) {
		throw new Error(
			"No deploy of this compose recorded the commit it checked out (it was last deployed before rebuilds checked this, or before it had a build server). A rebuild only builds the commit the last deploy checked out, so nothing was built. Deploy it once; rebuilds work again after that.",
		);
	}
	// Never used in a command, but held to the same form as every pin.
	if (!isCommitSha(recorded)) {
		throw new Error(
			"The commit recorded by the last deploy is not a full commit id, so the rebuild cannot check the code on disk against it. Nothing was built; deploy again.",
		);
	}
	const onDisk = parseCheckedOutCommit(servingCommitOutput);
	if (!onDisk) {
		throw new Error(
			`Could not read the commit checked out on the serving host (${describeUnreadableCommit(servingCommitOutput)}), so the rebuild cannot check it against commit ${recorded} that the last deploy checked out. Nothing was built; deploy again.`,
		);
	}
	if (onDisk !== recorded) {
		throw new Error(
			`The code on the serving host is commit ${onDisk}, not commit ${recorded} that the last deploy checked out. A rebuild only builds the commit the last deploy checked out, so nothing was built. Deploy to build the current code.`,
		);
	}
	await updateDeployment(deploymentId, { pinnedCommit: recorded });
	return recorded;
};
