import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema";
import { skipWriteOfReleasedJob } from "@dokploy/server/utils/process/job-context";
import { redactSecrets } from "@dokploy/server/utils/process/redactSecrets";
import { getVaultResolutionMessage } from "@dokploy/server/utils/vault/errors";
import { and, eq, like } from "drizzle-orm";
import {
	decideRegistryRetry,
	isRegistryAccessError,
} from "./gha-connect/registry-retry";
import { findRegistryRetriesDone } from "./gha-connect/store";

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

/**
 * Keeps the reason a GitHub Actions release deploy failed on the deployment row
 * when the registry refused the image (T-15783). GHCR can take a while to make
 * a freshly pushed manifest readable without a login, so the swarm task is
 * Rejected with `... denied: denied`; the connection poll reads this message to
 * retry the release later instead of settling it as failed.
 *
 * Only the deployments of a GitHub Actions release (their title starts with
 * "GHA ") and only for a registry access error: every other failure keeps its
 * row as it was. Call it BEFORE `updateDeploymentStatus(id, "error")`, so the
 * poll never sees the error status without the message. Never throws.
 */
export const recordRegistryAccessFailure = async (
	deploymentId: string,
	error: unknown,
) => {
	const message = error instanceof Error ? error.message : String(error);
	if (!isRegistryAccessError(message)) return;
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
					like(deployments.title, "GHA %"),
				),
			);
	} catch (writeError) {
		console.error(
			"Could not record the registry access failure on the deployment",
			writeError,
		);
	}
};

const DEPLOYMENT_HANDLE = /\[deployment #(\d+)\]\s*$/;

/**
 * Whether this failed deploy is one the connection poll will retry (T-15783): a
 * registry access error on a GitHub Actions release that still has retries
 * left. The deploy path then leaves the service status alone and sends no
 * failure notification; the notification goes out only if the release finally
 * settles as failed. `title` is the deployment's title, which ends in the
 * handle of the GitHub deployment. Never throws: unsure means not retryable,
 * which is the old behavior.
 */
export const willRetryRegistryFailure = async (
	title: string | null | undefined,
	serviceId: string,
	error: unknown,
): Promise<boolean> => {
	const message = error instanceof Error ? error.message : String(error);
	if (!isRegistryAccessError(message)) return false;
	const handle = DEPLOYMENT_HANDLE.exec(title ?? "");
	if (!handle?.[1] || !title?.startsWith("GHA ")) return false;
	try {
		const done = await findRegistryRetriesDone(serviceId, Number(handle[1]));
		return (
			done !== null &&
			decideRegistryRetry({ registryAccess: true, retriesDone: done }).kind ===
				"retry"
		);
	} catch {
		return false;
	}
};
