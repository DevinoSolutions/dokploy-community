import { IS_CLOUD } from "@dokploy/server/constants";
import { findScheduleById } from "@dokploy/server/services/schedule";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import {
	isSafeDeploymentId,
	resolveScheduleContainer,
	SCHEDULE_KILL_SCRIPT,
} from "./container-run";

/**
 * Stops one run of an application or compose schedule, inside its container.
 *
 * The run's `docker exec` is tagged with `DOKPLOY_SCHEDULE_RUN=<deploymentId>`
 * (see `runCommand`), which every process it starts inherits, so killing the
 * processes that carry exactly that tag stops the command and its children and
 * can never hit an unrelated process. The container is looked up again, the way
 * the run did. `containerFound: false` means it is gone, so is the run.
 */
export const cancelScheduleRun = async (
	scheduleId: string,
	deploymentId: string,
): Promise<{ containerFound: boolean }> => {
	if (!isSafeDeploymentId(deploymentId)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Deployment has an invalid id",
		});
	}
	const schedule = await findScheduleById(scheduleId);
	if (
		schedule.scheduleType !== "application" &&
		schedule.scheduleType !== "compose"
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only application and compose schedules run in a container",
		});
	}

	const serverId =
		schedule.scheduleType === "application"
			? schedule.application?.serverId
			: schedule.compose?.serverId;
	if (!serverId && IS_CLOUD) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Deployment has no server to stop it on",
		});
	}

	const { containerId } = await resolveScheduleContainer(schedule);
	if (!containerId) return { containerFound: false };

	const { shellType } = schedule;
	const command = `docker exec ${quote([containerId])} ${quote([shellType])} -c ${quote([SCHEDULE_KILL_SCRIPT])} ${quote([shellType])} ${quote([deploymentId])}`;
	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
	return { containerFound: true };
};
