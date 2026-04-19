import { IS_CLOUD } from "@dokploy/server";
import { handleDeploymentJob } from "./handler";
import { deploymentQueueManager } from "./queueSetup";

/**
 * Worker facade preserved for backward compatibility.
 *
 * Callers (application/compose routers, `server.ts`) depend on this shape:
 *   - `run()`        — called at boot; registers the handler with the queue manager.
 *   - `close()`      — called on shutdown; drains in-flight jobs.
 *   - `cancelJob`    — cancel a specific job.
 *   - `cancelAllJobs`— cancel every job across every target.
 *
 * In cloud mode every method is a no-op (deployments don't queue locally).
 */
export const deploymentWorker = IS_CLOUD
	? {
			run: async () => {},
			close: async () => {},
			cancelJob: (_jobId: string, _reason?: string) => false,
			cancelAllJobs: (_reason?: string) => {},
		}
	: {
			run: async () => {
				deploymentQueueManager.setHandler(handleDeploymentJob);
			},
			close: async (reason = "shutdown") => {
				await deploymentQueueManager.close(reason);
			},
			cancelJob: (jobId: string, reason?: string) =>
				deploymentQueueManager.cancelJob(jobId, reason),
			cancelAllJobs: (reason?: string) =>
				deploymentQueueManager.cancelAllJobs(reason),
		};
