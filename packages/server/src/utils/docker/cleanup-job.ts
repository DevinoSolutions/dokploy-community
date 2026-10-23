import { scheduledJobs, scheduleJob } from "node-schedule";
import { backgroundJob } from "../process/background";
import {
	countActiveDeploymentsOnHost,
	runDockerCleanupWhenIdle,
} from "./cleanup-guard";
import {
	DEFAULT_DOCKER_CLEANUP_CRON,
	dockerCleanupRule,
} from "./cleanup-schedule";
import { cleanupAll } from "./utils";

/** The node-schedule name of the Dokploy server's own cleanup; a remote server's is its serverId. */
export const WEB_SERVER_CLEANUP_JOB = "docker-cleanup";

export type ScheduleDockerCleanupInput = {
	jobName: string;
	/** null/undefined = the Dokploy server. */
	serverId?: string | null;
	hostLabel: string;
	/** The host's `dockerCleanupCron`, read in UTC. */
	cron: string | null | undefined;
	/** Runs after a cleanup that went ahead, for example the notification. */
	afterCleanup?: () => Promise<unknown> | unknown;
};

/** Cancels the cleanup job `jobName`, if there is one. */
export const cancelDockerCleanup = (jobName: string) => {
	scheduledJobs[jobName]?.cancel();
};

/**
 * Schedules a host's Docker cleanup, replacing the job of the same name:
 * node-schedule keeps the old job running when a new one reuses its name, so the
 * old one is cancelled first. The cron is read in UTC, and each run waits for
 * the host's deployments to finish (see runDockerCleanupWhenIdle).
 */
export const scheduleDockerCleanup = ({
	jobName,
	serverId,
	hostLabel,
	cron,
	afterCleanup,
}: ScheduleDockerCleanupInput) => {
	cancelDockerCleanup(jobName);
	const callback = backgroundJob(
		`Docker cleanup (${hostLabel})`,
		async () => {
			console.log(`Docker cleanup: starting for ${hostLabel}`);
			await runDockerCleanupWhenIdle({
				serverId,
				hostLabel,
				// Stop waiting if the job was disabled or rescheduled meanwhile.
				shouldContinue: () => scheduledJobs[jobName] === job,
				run: async () => {
					// A deploy can start after the idle check, and the later prunes
					// delete any image no container uses yet: look again between them.
					const { aborted } = await cleanupAll(serverId || undefined, {
						shouldAbort: async () =>
							(await countActiveDeploymentsOnHost(serverId)) > 0,
					});
					if (aborted) {
						console.warn(
							`Docker cleanup aborted mid-run: deployment started on ${hostLabel}`,
						);
						return;
					}
					await afterCleanup?.();
				},
			});
		},
		serverId ? { serverId } : {},
	);
	let job = scheduleJob(jobName, dockerCleanupRule(cron), callback);
	if (!job) {
		// node-schedule returns null for a rule that never fires (for example a
		// day that no listed month has). Never leave the host without cleanup.
		console.error(
			`Docker cleanup: schedule "${cron}" for ${hostLabel} never fires, using the default`,
		);
		cancelDockerCleanup(jobName);
		job = scheduleJob(
			jobName,
			dockerCleanupRule(DEFAULT_DOCKER_CLEANUP_CRON),
			callback,
		);
	}
	return job;
};
