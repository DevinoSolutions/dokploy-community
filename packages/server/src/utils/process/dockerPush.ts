import { quote } from "shell-quote";
import { dockerWithConfig } from "./dockerConfig";

/**
 * Registry pushes fail now and then for reasons that have nothing to do with
 * the image: the registry's object storage answers a blob HEAD or an upload
 * commit with a 5xx (`received unexpected HTTP status: 503 `), or the
 * connection drops. Docker's own per-layer retry does not cover those, so one
 * hiccup used to fail the whole deploy. A push is idempotent (layers that are
 * already there report "Layer already exists" / "Mounted from"), so running it
 * again is safe.
 *
 * Every image push in this package goes through the shell snippet below. It is
 * shell, not TypeScript, because the pushes are lines inside bigger scripts
 * that run on the build server over SSH and write to the deployment log.
 */

/** Seconds to wait before the 2nd and the 3rd attempt (3 attempts in total). */
export const DOCKER_PUSH_RETRY_DELAYS_SECONDS = [15, 45];

/**
 * Output of a push that is worth another attempt: a 5xx from the registry or
 * its storage, or a dropped / stalled connection (extended regex, matched
 * case-insensitively).
 */
export const DOCKER_PUSH_TRANSIENT_PATTERN =
	"unexpected HTTP status: 5[0-9]{2}|50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)|HTTP status:? 50[234]|connection reset|(^|[^A-Za-z])EOF([^A-Za-z]|$)|i/o timeout|TLS handshake timeout";

/**
 * Output that is never retried, whatever else it says: credentials or
 * permissions (a retry cannot fix them and only delays the error) and a
 * rejected manifest.
 */
export const DOCKER_PUSH_PERMANENT_PATTERN =
	"unauthorized|denied|authentication required|manifest invalid|(^|[^0-9A-Za-z])40[13]([^0-9A-Za-z]|$)";

/** Name of the shell function the snippets below define and call. */
const FUNCTION_NAME = "dokploy_push_retry";

export interface DockerPushRetryOptions {
	/** Seconds to wait between attempts; one more attempt than entries. */
	delaysSeconds?: number[];
}

/**
 * Shell function `dokploy_push_retry <command…>`: runs the push command,
 * copies its output to stdout (so it lands in the deployment log), and runs it
 * again when it failed with a transient error. Returns the last exit code.
 *
 * The exit code of the push is written to a file from inside the pipe's left
 * side, so it is not lost behind `tee` and no `pipefail` (not POSIX) is
 * needed. It does not depend on `set -e`, which is ignored on the left of `||`
 * anyway. Define it once per script and call it for every push.
 */
export const getDockerPushRetryFunction = ({
	delaysSeconds = DOCKER_PUSH_RETRY_DELAYS_SECONDS,
}: DockerPushRetryOptions = {}): string => {
	for (const delay of delaysSeconds) {
		if (!Number.isInteger(delay) || delay < 0) {
			throw new Error("Push retry delays must be whole seconds");
		}
	}
	const attempts = delaysSeconds.length + 1;
	const delayCases = delaysSeconds
		.map((delay, index) => `${index + 1}) _dp_delay=${delay} ;;`)
		.join(" ");

	return `${FUNCTION_NAME}() {
	_dp_attempt=1
	while :; do
		_dp_out=$(mktemp "\${TMPDIR:-/tmp}/dokploy-push.XXXXXX") || { "$@"; return $?; }
		( "$@" 2>&1; echo $? > "$_dp_out.rc" ) | tee "$_dp_out"
		_dp_code=$(cat "$_dp_out.rc" 2>/dev/null)
		[ -n "$_dp_code" ] || _dp_code=1
		if [ "$_dp_code" -eq 0 ]; then
			rm -f "$_dp_out" "$_dp_out.rc"
			return 0
		fi
		if [ "$_dp_attempt" -ge ${attempts} ] || ! grep -Eiq ${quote([DOCKER_PUSH_TRANSIENT_PATTERN])} "$_dp_out" || grep -Eiq ${quote([DOCKER_PUSH_PERMANENT_PATTERN])} "$_dp_out"; then
			rm -f "$_dp_out" "$_dp_out.rc"
			return "$_dp_code"
		fi
		rm -f "$_dp_out" "$_dp_out.rc"
		case "$_dp_attempt" in ${delayCases} esac
		echo "⚠️ Registry push failed with a transient error (attempt $_dp_attempt/${attempts}), retrying in \${_dp_delay}s…"
		sleep "$_dp_delay"
		_dp_attempt=$((_dp_attempt + 1))
	done
}`;
};

/**
 * One push through `dokploy_push_retry`. Needs the function from
 * `getDockerPushRetryFunction` to be defined earlier in the same script.
 *
 * `docker --config <configDir>` is kept when the registry has its own config.
 * `imageRef` is shell-quoted; pass `rawShellRef` when the reference is a shell
 * word built by the caller (such as `"$TAG"`), which the caller must have
 * quoted already. The line exits non-zero when the push finally fails, so it
 * composes with `|| { echo …; exit 1; }`.
 */
export const getDockerPushRetryCall = (
	imageRef: string,
	configDir?: string | null,
	{ rawShellRef = false }: { rawShellRef?: boolean } = {},
): string =>
	`${FUNCTION_NAME} ${dockerWithConfig(configDir)} push ${rawShellRef ? imageRef : quote([imageRef])}`;

/**
 * Function plus one call, for a script with a single push. The login is not
 * repeated on a retry: a 5xx has nothing to do with credentials.
 */
export const buildDockerPushWithRetry = (
	imageRef: string,
	configDir?: string | null,
	options: DockerPushRetryOptions & { rawShellRef?: boolean } = {},
): string =>
	`${getDockerPushRetryFunction(options)}\n${getDockerPushRetryCall(imageRef, configDir, options)}`;
