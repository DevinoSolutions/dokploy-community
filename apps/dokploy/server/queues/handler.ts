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

// Underlying deploy functions predate AbortSignal — cancel via killDockerBuild instead.
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
		// `buildServerId` is the host where the build actually runs (falls back to deploy target).
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
		console.error("Deployment handler error", error);
		throw error;
	}
}
