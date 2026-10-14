import { quote } from "shell-quote";
import {
	type DeployGuardrails,
	type DeployHealthCheck,
	type DeployStallSnapshot,
	deployGuardrailsSchema,
} from "../../db/validations/compose-guardrails";

export type { DeployGuardrails, DeployHealthCheck, DeployStallSnapshot };

/**
 * Opt-in deploy guardrails for Compose services (all off by default).
 *
 * Stored as one nullable jsonb column (`compose.deployGuardrails`); `null` or
 * an empty object means every guardrail is off and the generated deploy
 * script is byte-identical to what it was before the feature existed.
 */

export const HEALTH_CHECK_INTERVAL_SECONDS = 2;
export const HEALTH_CHECK_HEARTBEAT_SECONDS = 30;
export const DOCKER_EVENTS_MAX_LINES = 500;
/**
 * Last-resort limit for the background `docker events` process. The normal
 * ways it ends are the explicit stop after `up`, the EXIT trap and the parent
 * watchdog (see `getDockerEventsStartScript`); this only matters when all of
 * them are impossible.
 */
export const DOCKER_EVENTS_SAFETY_TIMEOUT_SECONDS = 3600;
/** The watchdog gives up after this long, so a recycled pid cannot keep it alive forever. */
export const DOCKER_EVENTS_WATCHDOG_LIFETIME_SECONDS = 3700;
/** How often the watchdog checks that the deploy shell still exists. */
export const DOCKER_EVENTS_WATCHDOG_INTERVAL_SECONDS = 2;
/**
 * Container events worth recording. Deliberately a short allow-list: the
 * `exec_create` / `exec_start` actions carry the full command line of every
 * `docker exec` (health checks run during `up`), which can hold credentials.
 */
export const DOCKER_EVENTS_ACTIONS = [
	"create",
	"start",
	"die",
	"kill",
	"stop",
	"destroy",
	"health_status",
	"oom",
] as const;

export interface ResolvedDeployGuardrails {
	phaseTimestamps: boolean;
	dockerEvents: boolean;
	healthCheck: DeployHealthCheck | null;
	stallSnapshot: DeployStallSnapshot | null;
}

/**
 * Normalizes whatever is stored in the column. Anything that does not parse
 * (a hand-edited row) counts as "off": a deploy must never fail because of a
 * malformed optional setting.
 */
export const resolveDeployGuardrails = (
	raw: unknown,
): ResolvedDeployGuardrails | null => {
	if (!raw) return null;
	const parsed = deployGuardrailsSchema.safeParse(raw);
	if (!parsed.success) return null;
	const resolved: ResolvedDeployGuardrails = {
		phaseTimestamps: parsed.data.phaseTimestamps === true,
		dockerEvents: parsed.data.dockerEvents === true,
		healthCheck: parsed.data.healthCheck ?? null,
		stallSnapshot: parsed.data.stallSnapshot ?? null,
	};
	if (
		!resolved.phaseTimestamps &&
		!resolved.dockerEvents &&
		!resolved.healthCheck &&
		!resolved.stallSnapshot
	) {
		return null;
	}
	return resolved;
};

/** Timestamp prefix evaluated by the shell that writes the line. */
const TS = '"[$(date -u +%Y-%m-%dT%H:%M:%SZ)]"';

/**
 * Shell: one deploy-log line stamped with the UTC time of the host that runs
 * the command. `message` is a constant of ours, quoted anyway.
 */
export const getPhaseLogLine = (message: string) =>
	`echo ${TS} ${quote([message])}`;

/** Shell helpers for phases that run inside the deploy script. */
export const getPhaseHelpersScript = () =>
	[
		`dokploy_phase_start() { DOKPLOY_PHASE_NAME="$1"; DOKPLOY_PHASE_T0=$(date +%s); echo ${TS} "$1: started"; };`,
		`dokploy_phase_end() { echo ${TS} "$DOKPLOY_PHASE_NAME: $1 after $(( $(date +%s) - DOKPLOY_PHASE_T0 ))s"; };`,
	].join("\n\t\t");

export const getPhaseStartCommand = (name: string) =>
	`dokploy_phase_start ${quote([name])};`;

export const getPhaseEndCommand = (outcome: "finished" | "failed") =>
	`dokploy_phase_end ${outcome};`;

/**
 * Label of the docker objects a deploy of this compose creates, which is what
 * `docker events` is filtered on.
 */
export const getEventsLabelFilter = (composeType: string, appName: string) =>
	composeType === "stack"
		? `label=com.docker.stack.namespace=${appName}`
		: `label=com.docker.compose.project=${appName}`;

/**
 * Shell: function definitions plus the start of a background `docker events`
 * scoped to the project label, covering the `compose up` window.
 *
 * Only container events from an allow-list are recorded (never `exec_*`,
 * whose action holds the exec'd command line), and the action is cut at the
 * first `:` when printed as a second guard.
 *
 * The capture is started BY the watchdog subshell, so there is no window in
 * which it runs unwatched: the watchdog ends it when the deploy shell is gone
 * (a `kill -9` skips every trap, and `timeout` may not exist), when the capture
 * exits, or after its own lifetime bound. The explicit stop around `up` and the
 * EXIT trap (success, failure and `exit 1`) end it through the same watchdog
 * (SIGTERM), and `timeout` is a last resort where it is available.
 * `--since` makes the capture independent of how long the CLI takes to attach.
 */
export const getDockerEventsStartScript = (
	composeType: string,
	appName: string,
	{ maxLines = DOCKER_EVENTS_MAX_LINES }: { maxLines?: number } = {},
) => {
	const filters = [
		"type=container",
		...DOCKER_EVENTS_ACTIONS.map((action) => `event=${action}`),
		getEventsLabelFilter(composeType, appName),
	]
		.map((filter) => `--filter ${quote([filter])}`)
		.join(" ");
	const header = quote([
		`Docker events for ${appName} during the compose up window (UTC)`,
	]);
	const disabled = quote([
		"Docker events capture skipped: could not create a private temporary directory on this host",
	]);
	const empty = quote([
		`No docker events were recorded for ${appName} during the compose up window`,
	]);
	// `|` separates the fields: a health_status action contains spaces, and a
	// container name cannot contain `|`.
	const format = quote([
		"{{.TimeNano}}|{{.Type}}|{{.Action}}|{{.Actor.Attributes.name}}",
	]);
	const eventsCommand = `docker events --since "$DOKPLOY_EVENTS_SINCE" ${filters} --format ${format} > "$DOKPLOY_EVENTS_DIR/events" 2>/dev/null </dev/null &`;
	// Everything lives in a private mktemp -d directory. If it cannot be created
	// the capture is skipped: a predictable /tmp path could be pre-created as a
	// symlink or hold an attacker-chosen pid.
	return `
		DOKPLOY_EVENTS_DIR=$(mktemp -d 2>/dev/null) || DOKPLOY_EVENTS_DIR="";
		DOKPLOY_EVENTS_WD_PID="";
		dokploy_events_stop() {
			if [ -n "$DOKPLOY_EVENTS_WD_PID" ]; then kill "$DOKPLOY_EVENTS_WD_PID" 2>/dev/null || true; wait "$DOKPLOY_EVENTS_WD_PID" 2>/dev/null || true; DOKPLOY_EVENTS_WD_PID=""; fi;
		};
		dokploy_events_cleanup() {
			dokploy_events_stop;
			if [ -n "$DOKPLOY_EVENTS_DIR" ]; then rm -rf "$DOKPLOY_EVENTS_DIR" 2>/dev/null || true; fi;
		};
		dokploy_events_flush() {
			dokploy_events_stop;
			if [ -z "$DOKPLOY_EVENTS_DIR" ]; then return 0; fi;
			if [ -s "$DOKPLOY_EVENTS_DIR/events" ]; then
				EV_TOTAL=$(wc -l < "$DOKPLOY_EVENTS_DIR/events" | tr -d ' ');
				echo ${TS} ${header};
				if [ "$EV_TOTAL" -gt ${maxLines} ]; then echo "(truncated: showing the last ${maxLines} of $EV_TOTAL events)"; fi;
				tail -n ${maxLines} "$DOKPLOY_EVENTS_DIR/events" | while IFS='|' read -r EV_NS EV_TYPE EV_ACTION EV_NAME; do
					EV_SHOWN=\${EV_ACTION%%:*};
					case "$EV_ACTION" in "health_status: healthy"|"health_status: unhealthy"|"health_status: starting") EV_SHOWN=$EV_ACTION;; esac;
					EV_SECS=\${EV_NS%?????????}; EV_FRAC=\${EV_NS#$EV_SECS}; EV_MS=\${EV_FRAC%??????};
					EV_TIME=$(date -u -d "@$EV_SECS" +%Y-%m-%dT%H:%M:%S 2>/dev/null) && echo "$EV_TIME.$EV_MS""Z $EV_TYPE $EV_SHOWN $EV_NAME" || echo "$EV_NS $EV_TYPE $EV_SHOWN $EV_NAME";
				done;
			else
				echo ${TS} ${empty};
			fi;
			rm -rf "$DOKPLOY_EVENTS_DIR" 2>/dev/null || true;
			DOKPLOY_EVENTS_DIR="";
		};
		trap 'dokploy_events_cleanup' EXIT;
		if [ -z "$DOKPLOY_EVENTS_DIR" ]; then
			echo ${TS} ${disabled};
		else
			DOKPLOY_EVENTS_SINCE=$(date +%s);
			sh -c 'echo $PPID' > "$DOKPLOY_EVENTS_DIR/shell.pid" 2>/dev/null;
			DOKPLOY_SHELL_PID=$(cat "$DOKPLOY_EVENTS_DIR/shell.pid" 2>/dev/null || echo "$$");
			(
				trap 'kill "$DOKPLOY_CAPTURE_PID" 2>/dev/null || true; exit 0' TERM;
				DOKPLOY_CAPTURE_PID="";
				kill -0 "$DOKPLOY_SHELL_PID" 2>/dev/null || exit 0;
				if command -v timeout >/dev/null 2>&1; then
					timeout ${DOCKER_EVENTS_SAFETY_TIMEOUT_SECONDS} ${eventsCommand}
				else
					${eventsCommand}
				fi;
				DOKPLOY_CAPTURE_PID=$!;
				# Wall clock (date +%s): a host clock jump can stretch or shorten this bound.
				DOKPLOY_WD_END=$(( $(date +%s) + ${DOCKER_EVENTS_WATCHDOG_LIFETIME_SECONDS} ));
				while kill -0 "$DOKPLOY_SHELL_PID" 2>/dev/null && kill -0 "$DOKPLOY_CAPTURE_PID" 2>/dev/null && [ "$(date +%s)" -lt "$DOKPLOY_WD_END" ]; do
					sleep ${DOCKER_EVENTS_WATCHDOG_INTERVAL_SECONDS} & wait $!;
				done;
				kill "$DOKPLOY_CAPTURE_PID" 2>/dev/null || true;
				# Deploy shell gone (killed before its EXIT trap ran) or lifetime bound hit:
				# nobody will flush, so remove the private directory. When only the capture
				# exited the shell still flushes and removes it.
				if ! kill -0 "$DOKPLOY_SHELL_PID" 2>/dev/null || [ "$(date +%s)" -ge "$DOKPLOY_WD_END" ]; then rm -rf "$DOKPLOY_EVENTS_DIR" 2>/dev/null || true; fi;
			) >/dev/null 2>&1 </dev/null &
			DOKPLOY_EVENTS_WD_PID=$!;
		fi;
		`;
};

export const DOCKER_EVENTS_FLUSH_COMMAND = "dokploy_events_flush;";

/** Each snapshot prints at most this many lines of `docker ps` / `docker stack ps`. */
export const STALL_SNAPSHOT_MAX_LINES = 200;
/** A snapshot command that has not returned after this long is killed and reported. */
export const STALL_SNAPSHOT_COMMAND_TIMEOUT_SECONDS = 20;
/** How often the watcher checks that the deploy shell still exists. */
export const STALL_SNAPSHOT_POLL_INTERVAL_SECONDS = 2;
/** A state command that ignores SIGTERM is sent SIGKILL after this long. */
export const STALL_SNAPSHOT_KILL_GRACE_SECONDS = 2;

/**
 * Shell: function definitions plus a background watcher that, while `compose
 * up` (or `stack deploy`) is still running, appends a delimited snapshot of
 * the project's container states to the deploy log. Observe only: it never
 * kills, times out or changes the deploy.
 *
 * The watcher waits `afterSeconds`, then prints a snapshot every
 * `everySeconds`, at most `maxSnapshots` times. A snapshot is the output of
 * `docker ps -a --filter label=com.docker.compose.project=<app>` (the state
 * column shows created / removing / dead / running / exited), or of
 * `docker stack ps <app>` for a swarm stack. The formats name only the
 * container, its state, status and creation time: never the environment,
 * labels, mounts or command lines. The command's stderr is dropped and a
 * failure is reported by exit code only.
 *
 * Cleanup mirrors the events capture: everything lives in a private `mktemp -d`
 * directory (skipped when it cannot be created), the watcher polls for the
 * deploy shell and removes the directory itself when the shell is gone (a
 * `kill -9` skips every trap) or it is done, a wall-clock bound covers a
 * recycled pid, and `dokploy_stall_cleanup` (called right after `up`, and from
 * the EXIT trap) ends it and removes the directory.
 *
 * A state command is stopped with SIGTERM and, if it ignores that, SIGKILL
 * after a short grace, both when it times out and when the deploy shell is
 * gone. The watcher's own TERM handler only raises a flag that is checked
 * after every wait, so a TERM between starting the command and recording its
 * pid cannot orphan it (it also drops a stop file that the per-command killer
 * polls, because a TERM before the wait starts does not interrupt it). After
 * the last snapshot the watcher stays alive, napping, until the shell stops it,
 * the shell or its directory is gone, or the lifetime bound passes, so the
 * directory is removed even if the shell is killed later. Only a watcher that
 * hit the lifetime bound with the shell alive leaves a `done` marker, and the
 * shell then never signals its (possibly reused) pid.
 *
 * For a swarm stack, `docker stack deploy` usually returns before the tasks
 * converge, so the deploy rarely lasts long enough for a snapshot to fire.
 *
 * The EXIT trap is shared with the events capture, which installs its own
 * first: this one must be emitted AFTER `getDockerEventsStartScript` and it
 * cleans the events capture up too, so neither can orphan the other.
 */
export const getStallSnapshotStartScript = (
	composeType: string,
	appName: string,
	{ afterSeconds, everySeconds, maxSnapshots }: DeployStallSnapshot,
	{ maxLines = STALL_SNAPSHOT_MAX_LINES }: { maxLines?: number } = {},
) => {
	const isStack = composeType === "stack";
	const after = Math.trunc(afterSeconds);
	const every = Math.trunc(everySeconds);
	const max = Math.trunc(maxSnapshots);
	// Upper bound of a normal run plus a minute of slack; only matters when the
	// pid watch cannot end the watcher (a recycled pid).
	const lifetime =
		after + max * (every + STALL_SNAPSHOT_COMMAND_TIMEOUT_SECONDS) + 60;
	const what = isStack ? "docker stack deploy" : "docker compose up";
	// `|` separates the fields: a container name cannot contain it.
	const snapshotCommand = isStack
		? `docker stack ps ${quote([appName])} --format ${quote(["{{.Name}}|{{.CurrentState}}|{{.DesiredState}}|{{.Node}}"])}`
		: `docker ps -a --filter ${quote([getEventsLabelFilter(composeType, appName)])} --format ${quote(["{{.Names}}|{{.State}}|{{.Status}}|{{.CreatedAt}}"])}`;
	const columns = quote([
		isStack
			? "TASK|CURRENT STATE|DESIRED STATE|NODE"
			: "NAME|STATE|STATUS|CREATED",
	]);
	const disabled = quote([
		"Stall snapshots skipped: could not create a private temporary directory on this host",
	]);
	const empty = quote([
		"(no containers or tasks were listed for this project)",
	]);
	return `
		DOKPLOY_STALL_DIR=$(mktemp -d 2>/dev/null) || DOKPLOY_STALL_DIR="";
		DOKPLOY_STALL_WD_PID="";
		dokploy_stall_stop() {
			if [ -n "$DOKPLOY_STALL_WD_PID" ]; then
				# A watcher that already finished on its own (marker in its private dir) is
				# not signalled: its pid may have been reused. Otherwise it is only asked to
				# stop, not waited for: it may need a few seconds to put down a state command
				# that ignores SIGTERM, and the deploy must not wait for that.
				if [ -n "$DOKPLOY_STALL_DIR" ] && [ ! -e "$DOKPLOY_STALL_DIR/done" ]; then kill "$DOKPLOY_STALL_WD_PID" 2>/dev/null || true; else wait "$DOKPLOY_STALL_WD_PID" 2>/dev/null || true; fi;
				DOKPLOY_STALL_WD_PID="";
			fi;
		};
		dokploy_stall_cleanup() {
			dokploy_stall_stop;
			if [ -n "$DOKPLOY_STALL_DIR" ]; then rm -rf "$DOKPLOY_STALL_DIR" 2>/dev/null || true; DOKPLOY_STALL_DIR=""; fi;
		};
		trap 'dokploy_stall_cleanup; if command -v dokploy_events_cleanup >/dev/null 2>&1; then dokploy_events_cleanup; fi' EXIT;
		if [ -z "$DOKPLOY_STALL_DIR" ]; then
			echo ${TS} ${disabled};
		else
			sh -c 'echo $PPID' > "$DOKPLOY_STALL_DIR/shell.pid" 2>/dev/null;
			DOKPLOY_STALL_SHELL_PID=$(cat "$DOKPLOY_STALL_DIR/shell.pid" 2>/dev/null || echo "$$");
			DOKPLOY_STALL_APP=${quote([appName])};
			(
				set +e;
				DOKPLOY_STALL_SLEEP_PID=""; DOKPLOY_STALL_CMD_PID=""; DOKPLOY_STALL_KILLER_PID=""; DOKPLOY_STALL_STOP=0;
				# TERM only raises a flag (and drops a stop file for the per-command killer).
				# The main flow checks the flag after every wait, so a TERM that lands between
				# starting the state command and recording its pid cannot leave the command behind.
				trap 'DOKPLOY_STALL_STOP=1; : > "$DOKPLOY_STALL_DIR/stop" 2>/dev/null' TERM;
				# SIGTERM, then SIGKILL after a short grace if the process ignores it. The
				# process is a child of this subshell: it is waited for, so it is reaped too.
				dokploy_stall_reap() {
					if [ -z "$1" ]; then return 0; fi;
					kill -TERM "$1" 2>/dev/null || return 0;
					( sleep ${STALL_SNAPSHOT_KILL_GRACE_SECONDS}; kill -KILL "$1" 2>/dev/null ) >/dev/null 2>&1 </dev/null &
					DOKPLOY_STALL_GRACE_PID=$!;
					while kill -0 "$1" 2>/dev/null; do wait "$1" 2>/dev/null; done;
					kill "$DOKPLOY_STALL_GRACE_PID" 2>/dev/null; wait "$DOKPLOY_STALL_GRACE_PID" 2>/dev/null;
					return 0;
				};
				dokploy_stall_finish() {
					dokploy_stall_reap "$DOKPLOY_STALL_CMD_PID";
					if [ -n "$DOKPLOY_STALL_KILLER_PID" ]; then kill "$DOKPLOY_STALL_KILLER_PID" 2>/dev/null; fi;
					if [ -n "$DOKPLOY_STALL_SLEEP_PID" ]; then kill "$DOKPLOY_STALL_SLEEP_PID" 2>/dev/null; fi;
					rm -rf "$DOKPLOY_STALL_DIR" 2>/dev/null;
					exit 0;
				};
				kill -0 "$DOKPLOY_STALL_SHELL_PID" 2>/dev/null || { rm -rf "$DOKPLOY_STALL_DIR" 2>/dev/null; exit 0; }
				# Wall clock (date +%s): a host clock jump can stretch or shorten these bounds.
				DOKPLOY_STALL_T0=$(date +%s);
				DOKPLOY_STALL_NEXT=$(( DOKPLOY_STALL_T0 + ${after} ));
				DOKPLOY_STALL_END=$(( DOKPLOY_STALL_T0 + ${lifetime} ));
				DOKPLOY_STALL_N=0;
				while [ "$DOKPLOY_STALL_N" -lt ${max} ] && kill -0 "$DOKPLOY_STALL_SHELL_PID" 2>/dev/null && [ "$(date +%s)" -lt "$DOKPLOY_STALL_END" ]; do
					if [ "$DOKPLOY_STALL_STOP" = "1" ]; then dokploy_stall_finish; fi;
					DOKPLOY_STALL_NOW=$(date +%s);
					if [ "$DOKPLOY_STALL_NOW" -lt "$DOKPLOY_STALL_NEXT" ]; then
						DOKPLOY_STALL_NAP=$(( DOKPLOY_STALL_NEXT - DOKPLOY_STALL_NOW ));
						if [ "$DOKPLOY_STALL_NAP" -gt ${STALL_SNAPSHOT_POLL_INTERVAL_SECONDS} ]; then DOKPLOY_STALL_NAP=${STALL_SNAPSHOT_POLL_INTERVAL_SECONDS}; fi;
						sleep "$DOKPLOY_STALL_NAP" & DOKPLOY_STALL_SLEEP_PID=$!;
						wait "$DOKPLOY_STALL_SLEEP_PID" 2>/dev/null;
						if [ "$DOKPLOY_STALL_STOP" = "1" ]; then dokploy_stall_finish; fi;
						DOKPLOY_STALL_SLEEP_PID="";
						continue;
					fi;
					DOKPLOY_STALL_N=$(( DOKPLOY_STALL_N + 1 ));
					DOKPLOY_STALL_CMD_T0=$(date +%s);
					${snapshotCommand} > "$DOKPLOY_STALL_DIR/ps" 2>/dev/null </dev/null &
					DOKPLOY_STALL_CMD_PID=$!;
					# A TERM that arrived before the pid was recorded is only seen now.
					if [ "$DOKPLOY_STALL_STOP" = "1" ]; then dokploy_stall_finish; fi;
					# Bounds the command, and ends it early when the deploy shell is gone or the
					# watcher was told to stop (stop file, or its directory removed). That covers a
					# TERM that lands before the wait below starts, which does not interrupt it.
					(
						DOKPLOY_STALL_I=0;
						while [ "$DOKPLOY_STALL_I" -lt ${STALL_SNAPSHOT_COMMAND_TIMEOUT_SECONDS} ] && kill -0 "$DOKPLOY_STALL_SHELL_PID" 2>/dev/null && [ -d "$DOKPLOY_STALL_DIR" ] && [ ! -e "$DOKPLOY_STALL_DIR/stop" ]; do sleep 1; DOKPLOY_STALL_I=$(( DOKPLOY_STALL_I + 1 )); done;
						kill -TERM "$DOKPLOY_STALL_CMD_PID" 2>/dev/null || exit 0;
						DOKPLOY_STALL_G=0;
						while [ "$DOKPLOY_STALL_G" -lt ${STALL_SNAPSHOT_KILL_GRACE_SECONDS} ] && kill -0 "$DOKPLOY_STALL_CMD_PID" 2>/dev/null; do sleep 1; DOKPLOY_STALL_G=$(( DOKPLOY_STALL_G + 1 )); done;
						if kill -0 "$DOKPLOY_STALL_CMD_PID" 2>/dev/null; then kill -KILL "$DOKPLOY_STALL_CMD_PID" 2>/dev/null; fi;
					) >/dev/null 2>&1 </dev/null &
					DOKPLOY_STALL_KILLER_PID=$!;
					if [ "$DOKPLOY_STALL_STOP" = "1" ]; then dokploy_stall_finish; fi;
					wait "$DOKPLOY_STALL_CMD_PID" 2>/dev/null; DOKPLOY_STALL_RC=$?;
					if [ "$DOKPLOY_STALL_STOP" = "1" ]; then dokploy_stall_finish; fi;
					kill "$DOKPLOY_STALL_KILLER_PID" 2>/dev/null; wait "$DOKPLOY_STALL_KILLER_PID" 2>/dev/null;
					DOKPLOY_STALL_CMD_PID=""; DOKPLOY_STALL_KILLER_PID="";
					DOKPLOY_STALL_TIMED_OUT=0;
					if [ "$DOKPLOY_STALL_RC" != "0" ] && [ $(( $(date +%s) - DOKPLOY_STALL_CMD_T0 )) -ge ${STALL_SNAPSHOT_COMMAND_TIMEOUT_SECONDS} ]; then DOKPLOY_STALL_TIMED_OUT=1; fi;
					# The deploy shell went away meanwhile: nobody is reading the log any more.
					kill -0 "$DOKPLOY_STALL_SHELL_PID" 2>/dev/null || break;
					{
						printf '%s\\n' "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ----- Stall snapshot $DOKPLOY_STALL_N/${max}: ${what} still running after $(( $(date +%s) - DOKPLOY_STALL_T0 ))s, state of $DOKPLOY_STALL_APP -----";
						if [ "$DOKPLOY_STALL_TIMED_OUT" = "1" ]; then
							echo "(the state command did not return within ${STALL_SNAPSHOT_COMMAND_TIMEOUT_SECONDS}s and was stopped)";
						elif [ "$DOKPLOY_STALL_RC" != "0" ]; then
							echo "(the state command failed with exit code $DOKPLOY_STALL_RC)";
						elif [ -s "$DOKPLOY_STALL_DIR/ps" ]; then
							echo ${columns};
							DOKPLOY_STALL_TOTAL=$(wc -l < "$DOKPLOY_STALL_DIR/ps" | tr -d ' ');
							head -n ${maxLines} "$DOKPLOY_STALL_DIR/ps";
							if [ "$DOKPLOY_STALL_TOTAL" -gt ${maxLines} ]; then echo "(truncated: showing the first ${maxLines} of $DOKPLOY_STALL_TOTAL lines)"; fi;
						else
							echo ${empty};
						fi;
						echo "----- End of stall snapshot $DOKPLOY_STALL_N/${max} -----";
					} > "$DOKPLOY_STALL_DIR/block" 2>/dev/null;
					if [ "$DOKPLOY_STALL_STOP" = "1" ]; then dokploy_stall_finish; fi;
					cat "$DOKPLOY_STALL_DIR/block" 2>/dev/null;
					# Scheduled from the previous deadline, so the time a command took does not
					# stretch the interval. A deadline already reached (the command took
					# at least as long as the interval) restarts the interval from now, so snapshots
					# never run back to back; maxSnapshots bounds the total either way.
					DOKPLOY_STALL_NEXT=$(( DOKPLOY_STALL_NEXT + ${every} ));
					DOKPLOY_STALL_NOW=$(date +%s);
					if [ "$DOKPLOY_STALL_NEXT" -le "$DOKPLOY_STALL_NOW" ]; then DOKPLOY_STALL_NEXT=$(( DOKPLOY_STALL_NOW + ${every} )); fi;
				done;
				# All snapshots taken (or the shell or lifetime ended the loop). Stay around so
				# the shell can simply signal this process, until it is told to stop, the shell
				# or the private dir is gone, or the lifetime bound passes. Then remove the dir.
				while [ "$DOKPLOY_STALL_STOP" != "1" ] && kill -0 "$DOKPLOY_STALL_SHELL_PID" 2>/dev/null && [ -d "$DOKPLOY_STALL_DIR" ] && [ "$(date +%s)" -lt "$DOKPLOY_STALL_END" ]; do
					sleep ${STALL_SNAPSHOT_POLL_INTERVAL_SECONDS} & DOKPLOY_STALL_SLEEP_PID=$!;
					wait "$DOKPLOY_STALL_SLEEP_PID" 2>/dev/null;
					DOKPLOY_STALL_SLEEP_PID="";
				done;
				if [ "$DOKPLOY_STALL_STOP" = "1" ]; then dokploy_stall_finish; fi;
				if kill -0 "$DOKPLOY_STALL_SHELL_PID" 2>/dev/null && [ -d "$DOKPLOY_STALL_DIR" ]; then
					# Lifetime bound passed with the shell still alive: leave a marker (the shell
					# removes the dir) so the shell never signals this pid after it may have been
					# reused.
					: > "$DOKPLOY_STALL_DIR/done" 2>/dev/null;
					rm -f "$DOKPLOY_STALL_DIR/ps" "$DOKPLOY_STALL_DIR/block" "$DOKPLOY_STALL_DIR/shell.pid" 2>/dev/null;
					kill -0 "$DOKPLOY_STALL_SHELL_PID" 2>/dev/null || rm -rf "$DOKPLOY_STALL_DIR" 2>/dev/null;
				else
					rm -rf "$DOKPLOY_STALL_DIR" 2>/dev/null;
				fi;
			) 2>/dev/null </dev/null &
			DOKPLOY_STALL_WD_PID=$!;
		fi;
		`;
};

export const STALL_SNAPSHOT_CLEANUP_COMMAND = "dokploy_stall_cleanup;";

/**
 * The URL as shown in the deploy log: scheme and host only. The path and query
 * (webhook-style URLs carry their token there) and the fragment are never
 * logged; `/…` marks that a path was configured.
 */
export const getHealthCheckDisplayUrl = (rawUrl: string) => {
	try {
		const url = new URL(rawUrl);
		return `${url.protocol}//${url.host}${url.pathname !== "/" || url.search ? "/…" : ""}`;
	} catch {
		return "(invalid URL)";
	}
};

/** Printed instead of running the check on a swarm stack. */
export const HEALTH_CHECK_STACK_SKIPPED_MESSAGE =
	"Health check skipped: docker stack deploy returns before the services are ready, so it cannot tell whether this release is healthy.";

/**
 * Shell: polls the health check URL on the host that ran `compose up`, until
 * it answers with the expected status or the timeout is reached. A timeout
 * exits non-zero WITHOUT touching the running release (no rollback).
 *
 * The URL reaches the shell only through shell-quote, and only its
 * scheme and host are printed.
 *
 * A status counts only when curl itself succeeded (a stalled or truncated body
 * leaves the status line at 200 but curl non-zero) and the deadline has not
 * passed: every request is capped to the time that is left.
 */
export const getHealthCheckScript = (
	healthCheck: DeployHealthCheck,
	{ phaseTimestamps }: { phaseTimestamps: boolean },
) => {
	const url = quote([healthCheck.url]);
	const shownUrl = getHealthCheckDisplayUrl(healthCheck.url);
	const timeout = healthCheck.timeoutSeconds;
	const expected =
		healthCheck.expectedStatus === undefined
			? "2??"
			: String(healthCheck.expectedStatus);
	const expectedLabel =
		healthCheck.expectedStatus === undefined
			? "2xx"
			: String(healthCheck.expectedStatus);
	const intro = quote([
		`Health check: waiting up to ${timeout}s for ${shownUrl} to answer ${expectedLabel}`,
	]);
	const failure = quote([
		`Error: ❌ Health check failed: ${shownUrl} did not answer ${expectedLabel} within ${timeout}s, last result: `,
	]);
	const noCurl = quote([
		"Error: ❌ Health check failed: curl is not installed on this host. The new release was left running; no automatic rollback was performed.",
	]);
	const left = quote([
		". The new release was left running; no automatic rollback was performed.",
	]);
	return `
		${phaseTimestamps ? getPhaseStartCommand("Health check") : ""}
		echo ${intro};
		if ! command -v curl >/dev/null 2>&1; then
			echo ${noCurl};
			${phaseTimestamps ? getPhaseEndCommand("failed") : ""}
			exit 1;
		fi
		# Wall clock (date +%s): a host clock jump can stretch or shorten the timeout.
		HC_START=$(date +%s);
		HC_DEADLINE=$(( HC_START + ${timeout} ));
		HC_OK=0;
		HC_LAST="no attempt made";
		HC_PREV="";
		HC_BEAT=$HC_START;
		while :; do
			HC_NOW=$(date +%s);
			HC_REMAIN=$(( HC_DEADLINE - HC_NOW ));
			if [ "$HC_REMAIN" -le 0 ]; then break; fi
			HC_MAX=5;
			if [ "$HC_REMAIN" -lt "$HC_MAX" ]; then HC_MAX=$HC_REMAIN; fi
			HC_CONNECT=3;
			if [ "$HC_MAX" -lt "$HC_CONNECT" ]; then HC_CONNECT=$HC_MAX; fi
			if HC_CODE=$(curl -s -L --globoff --max-redirs 5 --proto =http,https --proto-redir =http,https -o /dev/null -w '%{http_code}' --connect-timeout "$HC_CONNECT" --max-time "$HC_MAX" ${url} 2>/dev/null); then HC_RC=0; else HC_RC=$?; fi
			HC_NOW=$(date +%s);
			if [ "$HC_RC" = "0" ]; then HC_LAST="HTTP $HC_CODE"; else HC_LAST="no valid answer (curl exit $HC_RC)"; fi
			if [ "$HC_RC" = "0" ] && [ "$HC_NOW" -lt "$HC_DEADLINE" ]; then
				case "$HC_CODE" in ${expected}) HC_OK=1; break;; esac
			fi
			if [ "$HC_LAST" != "$HC_PREV" ]; then echo "Health check: $HC_LAST"; HC_PREV="$HC_LAST"; HC_BEAT=$HC_NOW; fi
			if [ $(( HC_NOW - HC_BEAT )) -ge ${HEALTH_CHECK_HEARTBEAT_SECONDS} ]; then echo "Health check: still waiting, $(( HC_NOW - HC_START ))s elapsed of ${timeout}s, last result: $HC_LAST"; HC_BEAT=$HC_NOW; fi
			HC_REMAIN=$(( HC_DEADLINE - HC_NOW ));
			if [ "$HC_REMAIN" -le 0 ]; then break; fi
			HC_SLEEP=${HEALTH_CHECK_INTERVAL_SECONDS};
			if [ "$HC_REMAIN" -lt "$HC_SLEEP" ]; then HC_SLEEP=$HC_REMAIN; fi
			sleep "$HC_SLEEP";
		done
		if [ "$HC_OK" = "1" ]; then
			echo "Health check passed: $HC_LAST";
			${phaseTimestamps ? getPhaseEndCommand("finished") : ""}
		else
			echo ${failure}"$HC_LAST"${left};
			${phaseTimestamps ? getPhaseEndCommand("failed") : ""}
			exit 1;
		fi
		`;
};
