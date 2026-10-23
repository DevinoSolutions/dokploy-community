import { scheduledJobs, scheduleJob } from "node-schedule";
import { backgroundJob } from "../process/background";
import { runDockerCleanupWhenIdle } from "./cleanup-guard";
import { dockerCleanupRule } from "./cleanup-schedule";
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
	const job = scheduleJob(
		jobName,
		dockerCleanupRule(cron),
		backgroundJob(
			`Docker cleanup (${hostLabel})`,
			async () => {
				console.log(`Docker cleanup: starting for ${hostLabel}`);
				await runDockerCleanupWhenIdle({
					serverId,
					hostLabel,
					// Stop waiting if the job was disabled or rescheduled meanwhile.
					shouldContinue: () => scheduledJobs[jobName] === job,
					run: async () => {
						await cleanupAll(serverId || undefined);
						await afterCleanup?.();
					},
				});
			},
			serverId ? { serverId } : {},
		),
	);
	return job;
};
