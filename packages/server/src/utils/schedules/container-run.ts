import { getComposeContainer, getServiceContainer } from "../docker/utils";

/**
 * Application and compose schedules run `docker exec` in the service's
 * container. Killing the host-side `docker exec` client does not stop the
 * process inside the container, and a bare pid is not safe to kill later (a
 * restarted container reuses pids). So every run is tagged with an environment
 * variable that its whole process tree inherits, and a cancel kills exactly the
 * processes that carry the tag of that run.
 */
export const SCHEDULE_RUN_ENV = "DOKPLOY_SCHEDULE_RUN";

const SCHEDULE_PID_MARKER = "__DOKPLOY_SCHEDULE_PID__";

// Printed by the kill script when no process carries the tag of the run: the
// command has not started (yet), or it is over.
export const SCHEDULE_NONE_MARKER = "__DOKPLOY_SCHEDULE_NONE__";

// Run as `<shell> -c <wrapper> <shell>` with the user command on stdin (`docker
// exec -i`): $0 is the shell. The command is never part of a command line, so
// it is not capped at 128 KB (MAX_ARG_STRLEN) and does not show in `ps` on the
// host. The wrapper prints the pid that the command will have (exec keeps it),
// reads the command and runs it from a 0600 file that it unlinks as soon as it
// is open, so nothing is left behind in the container either. A container whose
// temp directory cannot be written falls back to `-c` with the command as one
// argument, which is how every run used to work.
export const SCHEDULE_RUN_WRAPPER = [
	`printf '${SCHEDULE_PID_MARKER}=%s\\n' "$$"`,
	"s=$(cat) || exit 1",
	'f="${TMPDIR:-/tmp}/.dokploy-schedule-$$"',
	`if ( set -C; umask 077; printf '%s\\n' "$s" > "$f" ) 2>/dev/null && exec 3< "$f" && [ -r /dev/fd/3 ]; then rm -f "$f"; exec "$0" /dev/fd/3; fi`,
	'rm -f "$f"',
	'exec "$0" -c "$s"',
].join("; ");

// Run as `<shell> -c <script> <shell> <deploymentId>`. Processes are frozen
// before they are killed so a looping command cannot fork a replacement while
// the others are being killed. A process is only touched when its environment
// has exactly this run's tag, so nothing unrelated can be hit.
export const SCHEDULE_KILL_SCRIPT = `scan() { for d in /proc/[0-9]*; do p=\${d#/proc/}; [ "$p" = "$$" ] && continue; { tr '\\0' '\\n' < "$d/environ"; } 2>/dev/null | grep -Fxq "${SCHEDULE_RUN_ENV}=$1" && echo "$p"; done; }
pids=$(scan "$1")
if [ -z "$pids" ]; then echo "${SCHEDULE_NONE_MARKER}"; exit 0; fi
kill -STOP $pids 2>/dev/null
pids=$(scan "$1")
[ -n "$pids" ] && kill -9 $pids 2>/dev/null
exit 0`;

// Reads the output of a remote run from a pipe. Only the pid marker line goes
// to stdout, which is what `execAsyncRemote` hands back; everything else is
// appended to the log. Output of the command therefore never travels back over
// ssh, where a failure would put it in error messages. The marker is looked for
// in the first lines only: it is printed first, but docker may deliver a line
// the command wrote to stderr ahead of it. The exit status of the pipeline is
// the one of docker exec (the caller sets pipefail).
export const remoteRunOutputToLog = (quotedLogPath: string) =>
	`{ n=0; while [ $n -lt ${MARKER_SEARCH_LINES} ] && { IFS= read -r l || [ -n "$l" ]; }; do case "$l" in ${SCHEDULE_PID_MARKER}=*) printf '%s\\n' "$l"; break ;; *) printf '%s\\n' "$l" >> ${quotedLogPath} ;; esac; n=$((n+1)); done; cat >> ${quotedLogPath}; }`;

// A deployment id is a nanoid; anything else never reaches a shell.
export const isSafeDeploymentId = (deploymentId: string) =>
	/^[A-Za-z0-9_-]{1,64}$/.test(deploymentId);

// How many lines the remote run looks at for the marker.
const MARKER_SEARCH_LINES = 20;

const MARKER_LINE = new RegExp(`(^|\\n)${SCHEDULE_PID_MARKER}=(\\d+)\\r?\\n`);
// The marker is the first thing the run prints; give up if it never shows up.
const MAX_SCAN_LENGTH = 8192;

/**
 * Feed it the output of a run chunk by chunk. `onPid` is called once, with the
 * pid of the first marker line, and nothing printed afterwards (a user command
 * that echoes `PID: 99` or the marker itself) can change it. Returns the chunk
 * with that marker line removed, for callers that write the output to a log.
 */
export const createSchedulePidCapture = (onPid: (pid: string) => void) => {
	let pending = "";
	let finished = false;
	return (chunk: string): string => {
		if (finished) return chunk;
		pending += chunk;
		const match = MARKER_LINE.exec(pending);
		if (match) {
			finished = true;
			onPid(match[2] as string);
			return chunk.replace(MARKER_LINE, "$1");
		}
		if (pending.length > MAX_SCAN_LENGTH) finished = true;
		return chunk;
	};
};

type ScheduleTarget = {
	scheduleType: string;
	serviceName?: string | null;
	application?: { appName: string; serverId?: string | null } | null;
	compose?: Parameters<typeof getComposeContainer>[0] | null;
};

/** The running container of an application or compose schedule, and its server. */
export const resolveScheduleContainer = async (schedule: ScheduleTarget) => {
	let containerId = "";
	let serverId = "";
	if (schedule.scheduleType === "application" && schedule.application) {
		const container = await getServiceContainer(
			schedule.application.appName,
			schedule.application.serverId,
		);
		containerId = container?.Id || "";
		serverId = schedule.application.serverId || "";
	}
	if (schedule.scheduleType === "compose" && schedule.compose) {
		const container = await getComposeContainer(
			schedule.compose,
			schedule.serviceName || "",
		);
		containerId = container?.Id || "";
		serverId = schedule.compose.serverId || "";
	}
	return { containerId, serverId };
};
