import { createWriteStream } from "node:fs";
import path from "node:path";
import { IS_CLOUD, paths } from "@dokploy/server/constants";
import type { Schedule } from "@dokploy/server/db/schema/schedule";
import { getDokployUrl } from "@dokploy/server/services/admin";
import {
	createDeploymentSchedule,
	updateDeployment,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import {
	findScheduleById,
	findScheduleOrganizationId,
} from "@dokploy/server/services/schedule";
import { scheduledJobs, scheduleJob as scheduleJobNode } from "node-schedule";
import { quote } from "shell-quote";
import { sendScheduleFailureNotifications } from "../notifications/schedule-failure";
import { execAsyncRemote } from "../process/execAsync";
import { spawnAsync } from "../process/spawnAsync";
import {
	createSchedulePidCapture,
	remoteRunOutputToLog,
	resolveScheduleContainer,
	SCHEDULE_RUN_ENV,
	SCHEDULE_RUN_WRAPPER,
} from "./container-run";

type ScheduleExtended = Awaited<ReturnType<typeof findScheduleById>>;

// Records the in-container pid of an application/compose run so it can be
// cancelled (see cancel.ts). The returned function hands back its input with the
// pid marker line removed.
const capturePid = (deploymentId: string) =>
	createSchedulePidCapture((pid) => {
		void (async () => {
			try {
				await updateDeployment(deploymentId, { pid });
			} catch (error) {
				console.error(
					`Failed to record the pid of run ${deploymentId}:`,
					error,
				);
			}
		})();
	});

const handleScheduleError = async (
	schedule: ScheduleExtended,
	deploymentId: string,
	error: unknown,
) => {
	await updateDeploymentStatus(deploymentId, "error");
	try {
		const organizationId = await findScheduleOrganizationId(
			schedule.scheduleId,
		);
		if (!organizationId) return;

		const projectName =
			schedule.application?.environment?.project?.name ||
			schedule.compose?.environment?.project?.name ||
			schedule.server?.name ||
			"Dokploy";

		const errorMessage =
			error instanceof Error
				? error.message
				: typeof error === "string"
					? error
					: "Unknown error";

		const scheduleLink = `${await getDokployUrl()}/dashboard/schedules/${schedule.scheduleId}`;

		await sendScheduleFailureNotifications({
			projectName,
			scheduleName: schedule.name,
			scheduleType: schedule.scheduleType,
			errorMessage,
			scheduleLink,
			organizationId,
		});
	} catch (notifyError) {
		console.log("Failed to send schedule failure notification:", notifyError);
	}
};

export const scheduleJob = (schedule: Schedule) => {
	const { cronExpression, scheduleId, timezone } = schedule;

	// Use timezone from schedule, default to UTC if not specified
	const tz = timezone || "UTC";

	scheduleJobNode(
		scheduleId,
		{
			tz,
			rule: cronExpression,
		},
		async () => {
			try {
				await runCommand(scheduleId);
			} catch (error) {
				// runCommand already logs to the deployment log and fires the
				// failure notification via handleScheduleError. Swallow here so a
				// failing scheduled run does not become an unhandledRejection from
				// node-schedule's async callback.
				console.error(`Scheduled job ${scheduleId} failed:`, error);
			}
		},
	);
};

export const removeScheduleJob = (scheduleId: string) => {
	const currentJob = scheduledJobs[scheduleId];
	currentJob?.cancel();
};

export const runCommand = async (scheduleId: string) => {
	const schedule = await findScheduleById(scheduleId);
	const {
		application,
		command,
		shellType,
		scheduleType,
		compose,
		serviceName,
		appName,
		serverId,
	} = schedule;

	const deployment = await createDeploymentSchedule({
		scheduleId,
		title: "Schedule",
		description: "Schedule",
	});

	try {
		if (scheduleType === "application" || scheduleType === "compose") {
			const { containerId, serverId } =
				await resolveScheduleContainer(schedule);

			if (!containerId) {
				const target =
					scheduleType === "compose"
						? `service '${serviceName}' of compose '${compose?.name}'`
						: `application '${application?.appName}'`;
				const message = `Container not found for ${target}, make sure the service is running`;
				if (serverId) {
					await execAsyncRemote(
						serverId,
						`echo ${quote([`❌ ${message}`])} >> ${quote([deployment.logPath])}`,
					);
				} else {
					const writeStream = createWriteStream(deployment.logPath, {
						flags: "a",
					});
					writeStream.write(`❌ ${message}\n`);
					writeStream.end();
				}
				throw new Error(message);
			}

			if (serverId) {
				// Only the pid line comes back over ssh; the output goes to the log.
				await execAsyncRemote(
					serverId,
					`
					set -e
					set -o pipefail
					echo "Running scheduled command" >> ${quote([deployment.logPath])};
					docker exec -e ${quote([`${SCHEDULE_RUN_ENV}=${deployment.deploymentId}`])} ${quote([containerId])} ${quote([shellType])} -c ${quote([SCHEDULE_RUN_WRAPPER])} ${quote([shellType])} ${quote([command])} 2>&1 | ${remoteRunOutputToLog(quote([deployment.logPath]))} || {
						echo "❌ Command failed" >> ${quote([deployment.logPath])};
						exit 1;
					}
					echo "✅ Command executed successfully" >> ${quote([deployment.logPath])};
					`,
					capturePid(deployment.deploymentId),
					{ streamOnly: true },
				);
			} else {
				const writeStream = createWriteStream(deployment.logPath, {
					flags: "a",
				});

				const capture = capturePid(deployment.deploymentId);
				try {
					if (IS_CLOUD) {
						writeStream.write(
							"This feature is not available in the cloud version.",
						);
						writeStream.end();
						await updateDeploymentStatus(deployment.deploymentId, "error");
						return { ...deployment, status: "error" as const };
					}
					writeStream.write(
						`docker exec ${containerId} ${shellType} -c ${command}\n`,
					);
					await spawnAsync(
						"docker",
						[
							"exec",
							"-e",
							`${SCHEDULE_RUN_ENV}=${deployment.deploymentId}`,
							containerId,
							shellType,
							"-c",
							SCHEDULE_RUN_WRAPPER,
							shellType,
							command,
						],
						(data) => {
							const output = capture(data);
							if (output && writeStream.writable) {
								writeStream.write(output);
							}
						},
					);

					writeStream.write("✅ Command executed successfully\n");
					writeStream.end();
				} catch (error) {
					writeStream.write("❌ Command failed\n");
					writeStream.write(
						error instanceof Error ? error.message : "Unknown error",
					);
					writeStream.end();
					throw error;
				}
			}
		} else if (scheduleType === "dokploy-server") {
			const writeStream = createWriteStream(deployment.logPath, { flags: "a" });
			const { SCHEDULES_PATH } = paths();
			const fullPath = path.join(SCHEDULES_PATH, appName || "");

			await spawnAsync(
				"bash",
				["-c", "./script.sh"],
				async (data) => {
					if (writeStream.writable) {
						// we need to extract the PID and Schedule ID from the data
						const pid = data?.match(/PID: (\d+)/)?.[1];

						if (pid) {
							await updateDeployment(deployment.deploymentId, {
								pid,
							});
						}
						writeStream.write(data);
					}
				},
				{
					cwd: fullPath,
				},
			);
		} else if (scheduleType === "server") {
			const { SCHEDULES_PATH } = paths(true);
			const fullPath = path.join(SCHEDULES_PATH, appName || "");
			const command = `
				set -euo pipefail
				echo "Running script" >> ${quote([deployment.logPath])};
				bash -c ${quote([`${fullPath}/script.sh`])} 2>&1 | tee -a ${quote([deployment.logPath])} || {
					echo "❌ Command failed" >> ${quote([deployment.logPath])};
					exit 1;
				  }
				echo "✅ Command executed successfully" >> ${quote([deployment.logPath])};
			`;
			await execAsyncRemote(serverId, command, async (data) => {
				// we need to extract the PID and Schedule ID from the data
				const pid = data?.match(/PID: (\d+)/)?.[1];
				if (pid) {
					await updateDeployment(deployment.deploymentId, {
						pid,
					});
				}
			});
		}
		await updateDeploymentStatus(deployment.deploymentId, "done");
		return { ...deployment, status: "done" as const };
	} catch (error) {
		// `handleScheduleError` marks the deployment as errored and fans out the
		// schedule-failure notifications.
		await handleScheduleError(schedule, deployment.deploymentId, error);
		return { ...deployment, status: "error" as const };
	}
};
