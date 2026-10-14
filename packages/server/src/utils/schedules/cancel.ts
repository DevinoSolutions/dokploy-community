import { IS_CLOUD } from "@dokploy/server/constants";
import { findScheduleById } from "@dokploy/server/services/schedule";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import {
	isSafeDeploymentId,
	resolveScheduleContainer,
	SCHEDULE_KILL_SCRIPT,
	SCHEDULE_NONE_MARKER,
} from "./container-run";
import type { ScheduleRunLaunch } from "./launch";

/**
 * Stops one run of an application or compose schedule, inside its container.
 *
 * The run's `docker exec` is tagged with `DOKPLOY_SCHEDULE_RUN=<deploymentId>`
 * (see `runCommand`), which every process it starts inherits, so killing the
 * processes that carry exactly that tag stops the command and its children and
 * can never hit an unrelated process. The container is looked up again, the way
 * the run did. `containerFound: false` means it is gone, so is the run.
 * `found: false` means the container is there but no process carries the tag:
 * the command has not been started yet, or it is over.
 */
export const cancelScheduleRun = async (
	scheduleId: string,
	deploymentId: string,
): Promise<{ containerFound: boolean; found: boolean }> => {
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
	if (!containerId) return { containerFound: false, found: false };

	const { shellType } = schedule;
	const command = `docker exec ${quote([containerId])} ${quote([shellType])} -c ${quote([SCHEDULE_KILL_SCRIPT])} ${quote([shellType])} ${quote([deploymentId])}`;
	const result = serverId
		? await execAsyncRemote(serverId, command)
		: await execAsync(command);
	return {
		containerFound: true,
		found: !String(result?.stdout ?? "").includes(SCHEDULE_NONE_MARKER),
	};
};

/**
 * How long after its launch a run may still be registering its processes: a
 * cancel that finds no tagged process within this is asked to retry.
 */
export const SCHEDULE_LAUNCH_SETTLE_MS = 10_000;

/**
 * A running row that has no launch record and is older than this was stranded
 * (Dokploy restarted under it), far above any ssh connect time.
 */
export const SCHEDULE_STRANDED_MS = 10 * 60_000;

/**
 * What a cancel does for a `server` / `dokploy-server` run that has no pid and
 * no process carrying its tag:
 * - `claim`: no launch record yet. The cancel stands: the run reads it when it
 *   gets to its launch point, and never starts the command.
 * - `retry`: the run is at its last look at the cancel (whether it goes on is
 *   not decided), or launched moments ago and its processes may not exist yet.
 * - `gone`: launched a while ago and nothing carries the tag: it already exited
 *   or cannot be tracked.
 * - `stranded`: never launched by a process we know of, and too old to still be
 *   on its way: left behind by a restart.
 */
export const decideRunWithoutProcess = ({
	launch,
	startedAt,
	now = Date.now(),
}: {
	launch: ScheduleRunLaunch | undefined;
	startedAt: string | null | undefined;
	now?: number;
}): "claim" | "retry" | "gone" | "stranded" => {
	if (launch?.state === "checking") return "retry";
	if (launch?.state === "launched") {
		return now - launch.at < SCHEDULE_LAUNCH_SETTLE_MS ? "retry" : "gone";
	}
	const started = startedAt ? new Date(startedAt).getTime() : Number.NaN;
	return Number.isFinite(started) && now - started >= SCHEDULE_STRANDED_MS
		? "stranded"
		: "claim";
};

/**
 * Stops a run of a server or dokploy-server schedule by its tag, for a run that
 * never printed its pid. The run is tagged like a container run (see
 * `runCommand`), so the same kill script finds its processes on the host that
 * runs it: `serverId`, or the Dokploy host when null. `found: false` means no
 * process carries the tag (see `decideRunWithoutProcess`).
 *
 * The tag is an environment variable, so a daemon the run spawned (pm2, tmux)
 * inherits it and is killed with the run, and a `sudo` with env_reset drops it
 * from the processes it starts, which this cannot find.
 */
export const cancelHostScheduleRun = async (
	serverId: string | null,
	deploymentId: string,
): Promise<{ found: boolean }> => {
	if (!isSafeDeploymentId(deploymentId)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Deployment has an invalid id",
		});
	}
	if (!serverId && IS_CLOUD) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Deployment has no server to stop it on",
		});
	}
	const command = `sh -c ${quote([SCHEDULE_KILL_SCRIPT])} sh ${quote([deploymentId])}`;
	const result = serverId
		? await execAsyncRemote(serverId, command)
		: await execAsync(command);
	return {
		found: !String(result?.stdout ?? "").includes(SCHEDULE_NONE_MARKER),
	};
};

/**
 * True when `kill` failed because the process is already gone. Both the local
 * and the remote exec errors carry what `kill` wrote to stderr; dash and bash
 * both say "No such process".
 */
export const isMissingProcessError = (error: unknown): boolean => {
	if (typeof error !== "object" || error === null) return false;
	const { message, stderr } = error as { message?: unknown; stderr?: unknown };
	return [message, stderr].some(
		(text) => typeof text === "string" && /No such process/i.test(text),
	);
};
