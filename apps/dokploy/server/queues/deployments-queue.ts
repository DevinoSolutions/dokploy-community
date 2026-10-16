import {
	deployApplication,
	deployCompose,
	deployComposePreview,
	// build-policy hook: see the pinnedImage branch below.
	deployPinnedApplicationImage,
	deployPreviewApplication,
	findUserById,
	isDeploymentCancelledError,
	readServiceStatus,
	rebuildApplication,
	rebuildCompose,
	rebuildComposePreview,
	rebuildPreviewApplication,
	restoreServiceStatusIfUnchanged,
	updateApplicationStatus,
	updateCompose,
	updatePreviewDeployment,
} from "@dokploy/server";
import type { InMemoryJob, JobOutcome } from "./in-memory-queue";

/**
 * The status a service had before this job flipped it to "running", so a
 * cancelled deployment can put exactly that back. Best effort: undefined when
 * it cannot be read, in which case the deploy flow's own fallback applies.
 */
const readStatusBeforeJob = async (job: InMemoryJob) => {
	try {
		if (job.data.applicationType === "application") {
			return await readServiceStatus({ applicationId: job.data.applicationId });
		}
		if (job.data.applicationType === "compose") {
			return await readServiceStatus({ composeId: job.data.composeId });
		}
	} catch {
		// Not worth failing the deployment for.
	}
	return undefined;
};

const isRestorableStatus = (
	status: unknown,
): status is "idle" | "done" | "error" =>
	status === "idle" || status === "done" || status === "error";

/**
 * The payload carries the requester's user id (the queue list shows payloads, so
 * no email there); the deployment note names them by email, falling back to the
 * id when the user is gone.
 */
const requesterLabel = async (userId: string): Promise<string> => {
	try {
		return (await findUserById(userId)).email || userId;
	} catch {
		return userId;
	}
};

/**
 * The description recorded on the deployment. A job that went ahead of waiting
 * jobs through the priority lane says so (and for whom), since that is what the
 * person reading the deployment will wonder about.
 */
export const describeJob = async (job: InMemoryJob): Promise<string> => {
	const base = job.data.descriptionLog;
	const ahead = job.wentAheadOf ?? 0;
	if (ahead <= 0) return base;
	const by = job.data.priorityBy
		? `, requested by ${await requesterLabel(job.data.priorityBy)}`
		: "";
	const note = `Deployed ahead of ${ahead} waiting job${ahead === 1 ? "" : "s"} (priority${by})`;
	return base ? `${base} - ${note}` : note;
};

/**
 * Processes a single deployment job. Shared by the in-memory queue worker and
 * (in cloud) the direct background execution path.
 *
 * Returns "cancelled" or "failed" when the job ended early, so the queue can
 * hand back a priority job's cooldown; nothing on success.
 */
export const processDeploymentJob = async (
	job: InMemoryJob,
): Promise<JobOutcome | undefined> => {
	let statusBeforeJob: string | undefined;
	const descriptionLog = await describeJob(job);
	try {
		statusBeforeJob = await readStatusBeforeJob(job);
		if (job.data.applicationType === "application") {
			await updateApplicationStatus(job.data.applicationId, "running");

			// >>> build-policy hook: deploy-hook supplied image, no build.
			// See packages/server/src/services/build-policy/README.md
			if (job.data.pinnedImage) {
				await deployPinnedApplicationImage({
					applicationId: job.data.applicationId,
					pinnedImage: job.data.pinnedImage,
					titleLog: job.data.titleLog,
					descriptionLog,
				});
			} else if (job.data.type === "redeploy") {
				// <<< build-policy hook
				await rebuildApplication({
					applicationId: job.data.applicationId,
					titleLog: job.data.titleLog,
					descriptionLog,
				});
			} else if (job.data.type === "deploy") {
				await deployApplication({
					applicationId: job.data.applicationId,
					titleLog: job.data.titleLog,
					descriptionLog,
				});
			}
		} else if (job.data.applicationType === "compose") {
			await updateCompose(job.data.composeId, {
				composeStatus: "running",
			});
			if (job.data.type === "deploy") {
				await deployCompose({
					composeId: job.data.composeId,
					titleLog: job.data.titleLog,
					descriptionLog,
					freshVolumes: job.data.freshVolumes,
				});
			} else if (job.data.type === "redeploy") {
				await rebuildCompose({
					composeId: job.data.composeId,
					titleLog: job.data.titleLog,
					descriptionLog,
					freshVolumes: job.data.freshVolumes,
				});
			}
		} else if (job.data.applicationType === "application-preview") {
			await updatePreviewDeployment(job.data.previewDeploymentId, {
				previewStatus: "running",
			});

			if (job.data.type === "redeploy") {
				await rebuildPreviewApplication({
					applicationId: job.data.applicationId,
					titleLog: job.data.titleLog,
					descriptionLog,
					previewDeploymentId: job.data.previewDeploymentId,
				});
			} else if (job.data.type === "deploy") {
				await deployPreviewApplication({
					applicationId: job.data.applicationId,
					titleLog: job.data.titleLog,
					descriptionLog,
					previewDeploymentId: job.data.previewDeploymentId,
				});
			}
		} else if (job.data.applicationType === "compose-preview") {
			await updatePreviewDeployment(job.data.previewDeploymentId, {
				previewStatus: "running",
			});

			if (job.data.type === "redeploy") {
				await rebuildComposePreview({
					composeId: job.data.composeId,
					titleLog: job.data.titleLog,
					descriptionLog,
					previewDeploymentId: job.data.previewDeploymentId,
				});
			} else if (job.data.type === "deploy") {
				await deployComposePreview({
					composeId: job.data.composeId,
					titleLog: job.data.titleLog,
					descriptionLog,
					previewDeploymentId: job.data.previewDeploymentId,
				});
			}
		}
	} catch (error) {
		// A build-server deployment the user cancelled: the deploy flow already
		// recorded `cancelled` and put the service back to the state of the
		// release that is still serving, so it must not be flipped to "error".
		// Returning here ends the job normally, releasing its queue slot and the
		// service's group lock.
		if (isDeploymentCancelledError(error)) {
			console.log(`Deployment cancelled: ${(error as Error).message}`);
			// Back to the status the service had when this job started. The deploy
			// flow already set done/idle (`settledStatus`) as a fallback; moving on
			// from it only if the service is still in that status keeps a Stop or
			// Start clicked in the meantime.
			const { settledStatus } = error as { settledStatus?: unknown };
			if (
				isRestorableStatus(statusBeforeJob) &&
				isRestorableStatus(settledStatus)
			) {
				if (job.data.applicationType === "application") {
					await restoreServiceStatusIfUnchanged(
						{ applicationId: job.data.applicationId },
						settledStatus,
						statusBeforeJob,
					).catch(() => {});
				} else if (job.data.applicationType === "compose") {
					await restoreServiceStatusIfUnchanged(
						{ composeId: job.data.composeId },
						settledStatus,
						statusBeforeJob,
					).catch(() => {});
				}
			}
			return "cancelled";
		}
		console.log("Error", error);
		// Roll back the status set at the start of the job so a failed deployment
		// does not leave the service stuck in "running".
		if (job.data.applicationType === "application") {
			await updateApplicationStatus(job.data.applicationId, "error").catch(
				() => {},
			);
		} else if (job.data.applicationType === "compose") {
			await updateCompose(job.data.composeId, {
				composeStatus: "error",
			}).catch(() => {});
		} else if (
			job.data.applicationType === "application-preview" ||
			job.data.applicationType === "compose-preview"
		) {
			await updatePreviewDeployment(job.data.previewDeploymentId, {
				previewStatus: "error",
			}).catch(() => {});
		}
		return "failed";
	}
};
