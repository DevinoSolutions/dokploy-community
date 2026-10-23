import {
	CLEANUP_CRON_JOB,
	findServerById,
	IS_CLOUD,
	sendDockerCleanupNotifications,
} from "@dokploy/server";
import {
	cancelDockerCleanup,
	scheduleDockerCleanup,
} from "@dokploy/server/utils/docker/cleanup-job";
import { removeJob, schedule } from "./backup";

/**
 * Schedules (or cancels) a remote server's Docker cleanup. `cron` is the
 * server's `dockerCleanupCron` (UTC); left out it is read from the server, so a
 * caller that did not change it still gets the stored schedule.
 *
 * IS_CLOUD is served by the separate jobs service, which keeps the legacy
 * schedule.
 */
export const applyDockerCleanupSchedule = async (
	serverId: string,
	organizationId: string,
	enable: boolean,
	cron?: string,
) => {
	if (IS_CLOUD) {
		const job = {
			cronSchedule: CLEANUP_CRON_JOB,
			serverId,
			type: "server",
		} as const;
		await (enable ? schedule(job) : removeJob(job));
		return;
	}
	if (!enable) {
		cancelDockerCleanup(serverId);
		return;
	}
	const server = await findServerById(serverId);
	scheduleDockerCleanup({
		jobName: serverId,
		serverId,
		hostLabel: `server ${server.name} (${serverId})`,
		cron: cron ?? server.dockerCleanupCron,
		afterCleanup: () => sendDockerCleanupNotifications(organizationId),
	});
};
