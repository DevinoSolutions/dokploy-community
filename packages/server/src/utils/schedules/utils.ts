import { createWriteStream } from "node:fs";
import path from "node:path";
import { IS_CLOUD, paths } from "@dokploy/server/constants";
import type { Schedule } from "@dokploy/server/db/schema/schedule";
import { getDokployUrl } from "@dokploy/server/services/admin";
import {
	createDeploymentSchedule,
	updateDeployment,
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
import {
	forgetScheduleRunLaunch,
	markScheduleRunChecking,
	markScheduleRunLaunched,
} from "./launch";
import { appendRunLog } from "./run-log";
import {
	endScheduleRunCancelled,
	finishScheduleRun,
	isScheduleRunCancelled,
} from "./run-status";

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

const CANCELLED_LOG_LINE = "⛔ Run cancelled by user.";
const FAILED_LOG_LINE = "❌ Command failed";

// A cancel that came in before the command was started finds nothing to kill
// (see cancel.ts), so the run must not start it: ending with this error makes
// the run end as cancelled, like a killed one. It has its own class because the
// cancel may already have been undone by the time the run looks at its row (the
// kill found nothing and reverted), and the run must still never end as failed.
class CancelledBeforeStartError extends Error {
	constructor() {
		super("The run was cancelled before it started");
	}
}

// The last point before a `server` / `dokploy-server` command is handed over
// for execution (right before the local spawn, or once the ssh channel is
// ready). The run is marked as checking, then looks at the cancel, then is
// marked as launched in the same step it hands the command over. A cancel that
// finds no mark is seen by that look; one that finds "checking" cannot know
// which way it goes and asks the user to retry (see launch.ts and the cancel in
// the deployment router).
const launchPoint = async (deploymentId: string) => {
	markScheduleRunChecking(deploymentId);
	await assertNotCancelled(deploymentId);
	markScheduleRunLaunched(deploymentId);
};

const assertNotCancelled = async (deploymentId: string) => {
	if (await isScheduleRunCancelled(deploymentId)) {
		throw new CancelledBeforeStartError();
	}
};

// A run that a user cancelled ends with a failing exit status (the kill), which
// is not a failure: it stays `cancelled` and nobody is notified. A run whose row
// is gone is not cancelled, so its failure is still reported. A status that
// cannot be written does not hide the failure either: it is logged and the run
// counts as failed.
const endFailedRun = async (
	deploymentId: string,
): Promise<"error" | "cancelled"> => {
	try {
		return (await finishScheduleRun(deploymentId, "error")) === "cancelled"
			? "cancelled"
			: "error";
	} catch (error) {
		console.error(`Failed to record the end of run ${deploymentId}:`, error);
		return "error";
	}
};

// A run that was cancelled before it started ends as cancelled whatever its row
// says now: a revert may have put it back to running.
const endCancelledRun = async (deploymentId: string): Promise<"cancelled"> => {
	try {
		await endScheduleRunCancelled(deploymentId);
	} catch (error) {
		console.error(`Failed to record the end of run ${deploymentId}:`, error);
	}
	return "cancelled";
};

const notifyScheduleFailure = async (
	schedule: ScheduleExtended,
	error: unknown,
) => {
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
				// failure notification itself. Swallow here so a
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
	// Where the run's log lives: on the server it runs on, else on this host.
	const logServerId =
		application?.serverId || compose?.serverId || serverId || null;
	// Set for the runs whose shell script leaves the failure line to us: the
	// script cannot tell a failure from the kill of a cancel, we can.
	let logFailureAfterwards = false;

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
				await assertNotCancelled(deployment.deploymentId);
				logFailureAfterwards = true;
				// Only the pid line comes back over ssh; the output goes to the log.
				// The command travels as the ssh channel's stdin into `docker exec -i`:
				// it is on no command line, on the host or over ssh.
				await execAsyncRemote(
					serverId,
					`
					set -e
					set -o pipefail
					echo "Running scheduled command" >> ${quote([deployment.logPath])};
					docker exec -i -e ${quote([`${SCHEDULE_RUN_ENV}=${deployment.deploymentId}`])} ${quote([containerId])} ${quote([shellType])} -c ${quote([SCHEDULE_RUN_WRAPPER])} ${quote([shellType])} 2>&1 | ${remoteRunOutputToLog(quote([deployment.logPath]))} || exit 1
					echo "✅ Command executed successfully" >> ${quote([deployment.logPath])};
					`,
					capturePid(deployment.deploymentId),
					{ streamOnly: true, stdin: command },
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
						await finishScheduleRun(deployment.deploymentId, "error");
						return { ...deployment, status: "error" as const };
					}
					await assertNotCancelled(deployment.deploymentId);
					writeStream.write(
						`docker exec ${containerId} ${shellType}\n`,
					);
					const run = spawnAsync(
						"docker",
						[
							"exec",
							"-i",
							"-e",
							`${SCHEDULE_RUN_ENV}=${deployment.deploymentId}`,
							containerId,
							shellType,
							"-c",
							SCHEDULE_RUN_WRAPPER,
							shellType,
						],
						(data) => {
							const output = capture(data);
							if (output && writeStream.writable) {
								writeStream.write(output);
							}
						},
					);
					// The command goes in through stdin, never through the arguments. A
					// run that exits without reading it must not crash on EPIPE; its
					// exit status is what counts.
					run.child?.stdin?.on("error", () => {});
					run.child?.stdin?.end(command);
					await run;

					writeStream.write("✅ Command executed successfully\n");
					writeStream.end();
				} catch (error) {
					// A cancel is not a failure: the end of `runCommand` says so in the log.
					if (
						!(error instanceof CancelledBeforeStartError) &&
						!(await isScheduleRunCancelled(deployment.deploymentId))
					) {
						writeStream.write(`${FAILED_LOG_LINE}\n`);
						writeStream.write(
							error instanceof Error ? error.message : "Unknown error",
						);
					}
					writeStream.end();
					throw error;
				}
			}
		} else if (scheduleType === "dokploy-server") {
			await launchPoint(deployment.deploymentId);
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
					// The tag lets a cancel find the run when it has no pid (see
					// cancel.ts). The script's children inherit it, and so do daemons it
					// leaves behind (pm2, tmux), which a cancel then kills too.
					env: { ...process.env, [SCHEDULE_RUN_ENV]: deployment.deploymentId },
				},
			);
		} else if (scheduleType === "server") {
			logFailureAfterwards = true;
			const { SCHEDULES_PATH } = paths(true);
			const fullPath = path.join(SCHEDULES_PATH, appName || "");
			const command = `
				set -euo pipefail
				# The tag a cancel finds the run by when it has no pid (see cancel.ts).
				# Inherited by daemons the script leaves behind (pm2, tmux); a sudo
				# with env_reset drops it from what it starts.
				export ${SCHEDULE_RUN_ENV}=${quote([deployment.deploymentId])}
				echo "Running script" >> ${quote([deployment.logPath])};
				bash -c ${quote([`${fullPath}/script.sh`])} 2>&1 | tee -a ${quote([deployment.logPath])} || exit 1
				echo "✅ Command executed successfully" >> ${quote([deployment.logPath])};
			`;
			await assertNotCancelled(deployment.deploymentId);
			await execAsyncRemote(
				serverId,
				command,
				async (data) => {
					// we need to extract the PID and Schedule ID from the data
					const pid = data?.match(/PID: (\d+)/)?.[1];
					if (pid) {
						await updateDeployment(deployment.deploymentId, {
							pid,
						});
					}
				},
				{ beforeExec: () => launchPoint(deployment.deploymentId) },
			);
		}
		// The script came through: a failure from here on is not its failure.
		logFailureAfterwards = false;
		// A command that traps the kill can still exit 0: a cancelled run stays so.
		const end = await finishScheduleRun(deployment.deploymentId, "done");
		if (end === "cancelled") {
			await appendRunLog(logServerId, deployment.logPath, CANCELLED_LOG_LINE);
			return { ...deployment, status: "cancelled" } as const;
		}
		return { ...deployment, status: "done" } as const;
	} catch (error) {
		// The run is marked as errored unless it was cancelled, which is logged
		// instead; a failure is logged before the schedule-failure notifications
		// go out.
		const status =
			error instanceof CancelledBeforeStartError
				? await endCancelledRun(deployment.deploymentId)
				: await endFailedRun(deployment.deploymentId);
		if (status === "cancelled") {
			await appendRunLog(logServerId, deployment.logPath, CANCELLED_LOG_LINE);
		} else {
			if (logFailureAfterwards) {
				await appendRunLog(logServerId, deployment.logPath, FAILED_LOG_LINE);
			}
			await notifyScheduleFailure(schedule, error);
		}
		return { ...deployment, status } as const;
	} finally {
		forgetScheduleRunLaunch(deployment.deploymentId);
	}
};
