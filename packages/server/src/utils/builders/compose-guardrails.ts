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
export const DOCKER_EVENTS_MAX_LINES = 500;
/**
 * Safety net for the background `docker events` process: even if the parent
 * shell is SIGKILLed (no trap runs), `timeout` ends it.
 */
export const DOCKER_EVENTS_SAFETY_TIMEOUT_SECONDS = 7200;

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
 * Every exit path stops the process: the explicit stop calls around `up`, the
 * EXIT trap (success, failure and `exit 1`), and the `timeout` wrapper as a
 * last resort when the shell itself is killed.
 * `--since` makes the capture independent of how long the CLI takes to attach.
 */
export const getDockerEventsStartScript = (
	composeType: string,
	appName: string,
	{ maxLines = DOCKER_EVENTS_MAX_LINES }: { maxLines?: number } = {},
) => {
	const filter = quote([getEventsLabelFilter(composeType, appName)]);
	const header = quote([
		`Docker events for ${appName} during the compose up window (UTC)`,
	]);
	const format = quote([
		"{{.TimeNano}} {{.Type}} {{.Action}} {{.Actor.Attributes.name}}",
	]);
	return `
		DOKPLOY_EVENTS_FILE=$(mktemp 2>/dev/null || echo "/tmp/dokploy-events-$$");
		DOKPLOY_EVENTS_PID="";
		dokploy_events_stop() { if [ -n "$DOKPLOY_EVENTS_PID" ]; then kill "$DOKPLOY_EVENTS_PID" 2>/dev/null || true; wait "$DOKPLOY_EVENTS_PID" 2>/dev/null || true; DOKPLOY_EVENTS_PID=""; fi; };
		dokploy_events_flush() {
			dokploy_events_stop;
			if [ -s "$DOKPLOY_EVENTS_FILE" ]; then
				EV_TOTAL=$(wc -l < "$DOKPLOY_EVENTS_FILE" | tr -d ' ');
				echo ${TS} ${header};
				if [ "$EV_TOTAL" -gt ${maxLines} ]; then echo "(truncated: showing the last ${maxLines} of $EV_TOTAL events)"; fi;
				tail -n ${maxLines} "$DOKPLOY_EVENTS_FILE" | while IFS=' ' read -r EV_NS EV_REST; do
					EV_SECS=\${EV_NS%?????????}; EV_FRAC=\${EV_NS#$EV_SECS}; EV_MS=\${EV_FRAC%??????};
					EV_TIME=$(date -u -d "@$EV_SECS" +%Y-%m-%dT%H:%M:%S 2>/dev/null) && echo "$EV_TIME.$EV_MS""Z $EV_REST" || echo "$EV_NS $EV_REST";
				done;
			else
				echo ${TS} "No docker events were recorded for ${quote([appName])} during the compose up window";
			fi;
			rm -f "$DOKPLOY_EVENTS_FILE";
		};
		trap 'dokploy_events_stop; rm -f "$DOKPLOY_EVENTS_FILE"' EXIT;
		DOKPLOY_EVENTS_SINCE=$(date +%s);
		if command -v timeout >/dev/null 2>&1; then
			timeout ${DOCKER_EVENTS_SAFETY_TIMEOUT_SECONDS} docker events --since "$DOKPLOY_EVENTS_SINCE" --filter ${filter} --format ${format} > "$DOKPLOY_EVENTS_FILE" 2>/dev/null &
		else
			docker events --since "$DOKPLOY_EVENTS_SINCE" --filter ${filter} --format ${format} > "$DOKPLOY_EVENTS_FILE" 2>/dev/null &
		fi;
		DOKPLOY_EVENTS_PID=$!;
		`;
};

export const DOCKER_EVENTS_FLUSH_COMMAND = "dokploy_events_flush;";

/**
 * Shell: polls the health check URL on the host that ran `compose up`, until
 * it answers with the expected status or the timeout is reached. A timeout
 * exits non-zero WITHOUT touching the running release (no rollback).
 *
 * The URL reaches the shell only through shell-quote.
 */
export const getHealthCheckScript = (
	healthCheck: DeployHealthCheck,
	{ phaseTimestamps }: { phaseTimestamps: boolean },
) => {
	const url = quote([healthCheck.url]);
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
		`Health check: waiting up to ${timeout}s for ${healthCheck.url} to answer ${expectedLabel}`,
	]);
	const failure = quote([
		`Error: ❌ Health check failed: ${healthCheck.url} did not answer ${expectedLabel} within ${timeout}s, last result: `,
	]);
	return `
		${phaseTimestamps ? getPhaseStartCommand("Health check") : ""}
		echo ${intro};
		if ! command -v curl >/dev/null 2>&1; then
			echo "Error: ❌ Health check failed: curl is not installed on this host";
			${phaseTimestamps ? getPhaseEndCommand("failed") : ""}
			exit 1;
		fi
		HC_DEADLINE=$(( $(date +%s) + ${timeout} ));
		HC_OK=0;
		HC_LAST="";
		HC_PREV="";
		while :; do
			HC_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 5 ${url} 2>/dev/null || true);
			HC_LAST="HTTP $HC_CODE";
			case "$HC_CODE" in ${expected}) HC_OK=1; break;; esac
			if [ "$HC_LAST" != "$HC_PREV" ]; then echo "Health check: $HC_LAST"; HC_PREV="$HC_LAST"; fi
			if [ "$(date +%s)" -ge "$HC_DEADLINE" ]; then break; fi
			sleep ${HEALTH_CHECK_INTERVAL_SECONDS};
		done
		if [ "$HC_OK" = "1" ]; then
			echo "Health check passed: $HC_LAST";
			${phaseTimestamps ? getPhaseEndCommand("finished") : ""}
		else
			echo ${failure}"$HC_LAST";
			${phaseTimestamps ? getPhaseEndCommand("failed") : ""}
			exit 1;
		fi
		`;
};
