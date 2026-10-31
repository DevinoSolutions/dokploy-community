import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema";
import { skipWriteOfReleasedJob } from "@dokploy/server/utils/process/job-context";
import { redactSecrets } from "@dokploy/server/utils/process/redactSecrets";
import { getVaultResolutionMessage } from "@dokploy/server/utils/vault/errors";
import { and, eq } from "drizzle-orm";

/**
 * Puts the reason a deploy failed on a vault reference that could not be
 * resolved on the deployment row, so the dashboard shows it next to the failed
 * status instead of only in the deploy log (T-11775). The text is the message
 * the deploy log gets: it names the provider and the reference, and for a
 * failure inside the provider's own client it carries that error's text. The
 * stored copy goes through `redactSecrets`, so credentials in a URL
 * (`user:pass@host`), auth headers and known token shapes are masked; the
 * deploy log copy is not touched. No resolver message contains a secret value.
 *
 * Call it right after `updateDeploymentStatus(id, "error")`. A no-op for any
 * other error and for a job the watchdog released (its own message stays), and
 * it only writes while the row is still `error`, so a cancel warning or a
 * watchdog message that landed first is not overwritten. It never throws: it
 * must not mask the deploy error the caller rethrows.
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
			.set({ errorMessage: redactSecrets(message) })
			.where(
				and(
					eq(deployments.deploymentId, deploymentId),
					eq(deployments.status, "error"),
				),
			);
	} catch (writeError) {
		console.error(
			"Could not record the vault failure on the deployment",
			writeError,
		);
	}
};
