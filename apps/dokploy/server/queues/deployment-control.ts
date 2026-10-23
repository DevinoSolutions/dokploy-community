import { IS_CLOUD } from "@dokploy/server/constants";
import {
	appendLogLine,
	cancelBuildServerDeploymentById,
} from "@dokploy/server/services/deployment-cancel";
import { recordDeploymentCancelAudit } from "@dokploy/server/services/deployment-cancel-audit";
import {
	countOtherRunningDeploys,
	listLatestDeploysOf,
	listRunningDeployDeployments,
	loadWatchdogServiceContext,
	markDeploymentFailedByWatchdog,
	markServiceFailedIfStillRunning,
	readLogIdleMs,
	resolveWatchdogLogHost,
	resolveWatchdogService,
	sendWatchdogFailureNotification,
} from "@dokploy/server/services/deployment-watchdog";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import { resolveWatchdogConfig } from "@dokploy/server/utils/deployments/watchdog-config";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import type { CancelActiveDeps } from "../utils/cancel-active-deployment";
import { type StopDeps, stopDeploymentWork } from "./deployment-stop";
import {
	createDeploymentWatchdog,
	WATCHDOG_INTERVAL_MS,
	type WatchdogDeps,
} from "./deployment-watchdog";
import { killDockerBuild, myQueue } from "./queueSetup";

/**
 * The real queue, database and hosts behind the stuck-deployment watchdog and
 * the self-hosted cancel of a running job. Kept apart from their logic so that
 * logic can be tested without any of them.
 */

export const defaultStopDeps: StopDeps = {
	cancelWithLauncher: cancelBuildServerDeploymentById,
	countOtherRunning: countOtherRunningDeploys,
	killPid: async (serverId, pid) => {
		const command = `kill -9 ${pid}`;
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	},
	killDockerBuild,
};

export const createDefaultWatchdogDeps = (): WatchdogDeps => ({
	now: () => Date.now(),
	loadConfig: async () => resolveWatchdogConfig(await getWebServerSettings()),
	activeJobs: () => myQueue.getJobs(["active"]),
	releaseJob: (jobId) => myQueue.releaseActive(jobId),
	listRunning: listRunningDeployDeployments,
	latestDeploys: listLatestDeploysOf,
	resolveService: resolveWatchdogService,
	readLogIdleMs: (row) => readLogIdleMs(row),
	logHost: resolveWatchdogLogHost,
	appendLog: appendLogLine,
	stop: (row) => stopDeploymentWork(row, defaultStopDeps),
	markFailed: markDeploymentFailedByWatchdog,
	failServiceIfRunning: markServiceFailedIfStillRunning,
	loadContext: loadWatchdogServiceContext,
	notify: (row, host, context, fallbackMessage) =>
		sendWatchdogFailureNotification(row, host, context, fallbackMessage),
	recordAudit: recordDeploymentCancelAudit,
});

export const createDefaultCancelDeps = (): CancelActiveDeps => ({
	listRunning: listRunningDeployDeployments,
	activeJobs: () => myQueue.getJobs(["active"]),
	stop: (row) => stopDeploymentWork(row, defaultStopDeps),
	logHost: resolveWatchdogLogHost,
	appendLog: appendLogLine,
});

/**
 * Starts the periodic sweep (once a minute). Self-hosted only: cloud runs its
 * deploys outside this queue. Returns a function that stops it.
 */
export const startDeploymentWatchdog = (
	deps: WatchdogDeps = createDefaultWatchdogDeps(),
	intervalMs: number = WATCHDOG_INTERVAL_MS,
): (() => void) => {
	if (IS_CLOUD) return () => {};
	const watchdog = createDeploymentWatchdog(deps);
	const timer = setInterval(() => void watchdog.sweep(), intervalMs);
	// A sweep must never keep the process alive on shutdown.
	timer.unref?.();
	return () => clearInterval(timer);
};
