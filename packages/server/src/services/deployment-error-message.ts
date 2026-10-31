import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema";
import { skipWriteOfReleasedJob } from "@dokploy/server/utils/process/job-context";
import { getVaultResolutionMessage } from "@dokploy/server/utils/vault/errors";
import { eq } from "drizzle-orm";

/**
 * Puts the reason a deploy failed on a vault reference that could not be
 * resolved on the deployment row, so the dashboard shows it next to the failed
 * status instead of only in the deploy log (T-11775). The text is the message
 * the log gets; it names the provider and the secret, never a value.
 *
 * Call it right after `updateDeploymentStatus(id, "error")`. A no-op for any
 * other error and for a job the watchdog released (its own message stays), and
 * it never throws: it must not mask the deploy error the caller rethrows.
 */
export const recordVaultFailureReason = async (
	deploymentId: string,
	error: unknown,
) => {
	const message = getVaultResolutionMessage(error);
	if (!message) return;
	if (
		skipWriteOfReleasedJob(
			`the error message of deployment ${deploymentId}`,
			deploymentId,
		)
	) {
		return;
	}
	try {
		await db
			.update(deployments)
			.set({ errorMessage: message })
			.where(eq(deployments.deploymentId, deploymentId));
	} catch (writeError) {
		console.error(
			"Could not record the vault failure on the deployment",
			writeError,
		);
	}
};
