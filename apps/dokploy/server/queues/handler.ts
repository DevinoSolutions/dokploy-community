import {
	deployApplication,
	deployCompose,
	deployPreviewApplication,
	rebuildApplication,
	rebuildCompose,
	rebuildPreviewApplication,
	updateApplicationStatus,
	updateCompose,
	updatePreviewDeployment,
} from "@dokploy/server";
import { killDockerBuild } from "./kill-docker-build";
import type { DeploymentJob } from "./queue-types";

/**
 * Single place that dispatches a `DeploymentJob` to the right service call.
 *
 * The `signal` is plumbed through so callers (queue-manager) can cancel a
 * running deployment. The underlying `deployApplication` / `deployCompose`
 * functions don't yet accept an `AbortSignal` — they predate this queue — so
 * we listen here and shell out to `killDockerBuild` on abort, which is the
 * same mechanism the "Kill build" UI button uses.
 *
 * When a cancellation lands while the handler is awaiting the service call,
 * the service call still resolves/rejects on its own; we swallow any error
 * that occurs *after* the abort, since the abort is the causal failure the
 * caller cares about.
 */
export async function handleDeploymentJob(
	job: DeploymentJob,
	signal: AbortSignal,
): Promise<void> {
	const cleanup = registerAbortHandler(job, signal);
	try {
		throwIfAborted(signal);
		await dispatch(job, signal);
	} finally {
		cleanup();
	}
}

/**
 * If the signal is already aborted, throw the reason immediately so the
 * queue's `done` promise rejects without running any more DB writes or
 * subprocesses.
 */
function throwIfAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new Error(String(signal.reason ?? "Aborted"));
}

function registerAbortHandler(
	job: DeploymentJob,
	signal: AbortSignal,
): () => void {
	const onAbort = () => {
		const type: "application" | "compose" =
			job.applicationType === "compose" ? "compose" : "application";
		// Build happens on buildServerId when set, otherwise on the deploy
		// target — that's the host where docker build is actually running.
		const buildHost =
			job.applicationType === "compose"
				? (job.serverId ?? null)
				: (job.buildServerId ?? job.serverId ?? null);
		killDockerBuild(type, buildHost).catch((error) => {
			console.error("killDockerBuild failed during cancellation", error);
		});
	};
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}

async function dispatch(
	job: DeploymentJob,
	signal: AbortSignal,
): Promise<void> {
	try {
		if (job.applicationType === "application") {
			await updateApplicationStatus(job.applicationId, "running");
			throwIfAborted(signal);
			if (job.type === "redeploy") {
				await rebuildApplication({
					applicationId: job.applicationId,
					titleLog: job.titleLog,
					descriptionLog: job.descriptionLog,
				});
			} else {
				await deployApplication({
					applicationId: job.applicationId,
					titleLog: job.titleLog,
					descriptionLog: job.descriptionLog,
				});
			}
			return;
		}

		if (job.applicationType === "compose") {
			await updateCompose(job.composeId, { composeStatus: "running" });
			throwIfAborted(signal);
			if (job.type === "redeploy") {
				await rebuildCompose({
					composeId: job.composeId,
					titleLog: job.titleLog,
					descriptionLog: job.descriptionLog,
				});
			} else {
				await deployCompose({
					composeId: job.composeId,
					titleLog: job.titleLog,
					descriptionLog: job.descriptionLog,
				});
			}
			return;
		}

		// application-preview
		await updatePreviewDeployment(job.previewDeploymentId, {
			previewStatus: "running",
		});
		throwIfAborted(signal);
		if (job.type === "redeploy") {
			await rebuildPreviewApplication({
				applicationId: job.applicationId,
				titleLog: job.titleLog,
				descriptionLog: job.descriptionLog,
				previewDeploymentId: job.previewDeploymentId,
			});
		} else {
			await deployPreviewApplication({
				applicationId: job.applicationId,
				titleLog: job.titleLog,
				descriptionLog: job.descriptionLog,
				previewDeploymentId: job.previewDeploymentId,
			});
		}
	} catch (error) {
		// Log and rethrow so the queue's `done` promise settles correctly.
		console.error("Deployment handler error", error);
		throw error;
	}
}
