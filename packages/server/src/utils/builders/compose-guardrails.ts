import { quote } from "shell-quote";
import {
	type DeployGuardrails,
	type DeployHealthCheck,
	deployGuardrailsSchema,
} from "../../db/validations/compose-guardrails";

export type { DeployGuardrails, DeployHealthCheck };

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
	};
	if (
		!resolved.phaseTimestamps &&
		!resolved.dockerEvents &&
		!resolved.healthCheck
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
			) >/dev/null 2>&1 </dev/null &
			DOKPLOY_EVENTS_WD_PID=$!;
		fi;
		`;
};

export const DOCKER_EVENTS_FLUSH_COMMAND = "dokploy_events_flush;";

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
