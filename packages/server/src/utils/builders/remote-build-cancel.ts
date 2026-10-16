import { paths } from "@dokploy/server/constants";

/**
 * Pure command builders that let a build running on a build server be
 * cancelled precisely.
 *
 * A build-server deploy runs its build as one (application) or a few (compose)
 * `execAsyncRemote` commands. Cancelling must stop THAT deployment's build and
 * nothing else on the build server, which runs up to three builds at once and
 * doubles as a CI runner. So instead of a pattern kill (`pkill -f ...`):
 *
 * - the build command is launched through `wrapCancelableRemoteBuild`, which
 *   starts it in its own session (`setsid`, so the process group id is the
 *   session leader's pid) and records `<pgid> <start time> <deploymentId>` in a
 *   per-deployment pid file;
 * - `getKillRemoteBuildCommand` reads that file, checks that the recorded
 *   process is still the one that wrote it, and signals only that group.
 *
 * Nothing here ever prints or logs a process's arguments: the build command
 * carries repository tokens, a base64 `.env` and registry credentials. The
 * kill script only prints one of a fixed set of status words.
 */

/** Everything the wrapper and the kill command agree on. */
export interface RemoteBuildCancelTarget {
	/** Per-deployment pid file on the build server. */
	pidFile: string;
	deploymentId: string;
	/**
	 * Release step only: after the command ends, wait up to this many seconds
	 * for its process group to be gone before returning. A cancel kills the
	 * session's first process at once, while a trap in the script still has
	 * cleanup to do; returning earlier would free the deployment job (and let a
	 * queued deploy of the same compose start) while that cleanup runs.
	 */
	drainSeconds?: number;
}

/**
 * Wraps `value` in single quotes so a shell reads it back verbatim: ids, paths
 * and the build command itself can contain any character.
 */
export const shSingleQuote = (value: string) =>
	`'${value.replace(/'/g, `'\\''`)}'`;

/** Deployment ids are nanoids; anything else must not escape the file name. */
const safeFileSegment = (value: string) =>
	value.replace(/[^A-Za-z0-9_-]/g, "_") || "_";

/**
 * Where the pid file of one deployment's build lives on the build server: a
 * hidden directory under the deployments' log directory, one file per
 * deployment id.
 */
export const getRemoteBuildPidFile = (deploymentId: string) =>
	`${paths(true).LOGS_PATH}/.build-pids/${safeFileSegment(deploymentId)}.pid`;

export const getRemoteBuildCancelTarget = (
	deploymentId: string,
): RemoteBuildCancelTarget => ({
	pidFile: getRemoteBuildPidFile(deploymentId),
	deploymentId,
});

/**
 * The release step of a build-server deploy (the script that pulls and starts
 * the new release on the serving host) is cancelable the same way, with a pid
 * file of its own on the serving host. Its key is the deployment id plus a
 * suffix, so the build-server cancel (keyed by the bare id) never mistakes it
 * for a build: the registry of running commands and the pid file's owner field
 * both use this key.
 */
export const getReleaseCancelKey = (deploymentId: string) =>
	`${deploymentId}.release`;

/**
 * `onRemoteHost` follows the path layout of the serving host: false when that
 * is the Dokploy host itself (a compose without a server).
 */
export const getReleaseCancelTarget = (
	deploymentId: string,
	onRemoteHost: boolean,
): RemoteBuildCancelTarget => {
	const key = getReleaseCancelKey(deploymentId);
	return {
		pidFile: `${paths(onRemoteHost).LOGS_PATH}/.build-pids/${safeFileSegment(key)}.pid`,
		deploymentId: key,
		drainSeconds: RELEASE_DRAIN_SECONDS,
	};
};

/**
 * Inner script, run by `setsid sh -c`. `$$` is the new session leader (and so
 * the group id); its field 22 in /proc/<pid>/stat is its start time, which is
 * what later proves that a pid is still the process that wrote the file and
 * not an unrelated one that reused the number.
 * Arguments: $1 pid file, $2 deployment id, $3 the build command.
 */
const SESSION_LAUNCHER = [
	's=$(sed "s/^.*) //" /proc/$$/stat 2>/dev/null | cut -d" " -f20)',
	"b=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)",
	// The umask is scoped to the pid-file write: the build itself must keep the
	// session's normal umask, or clones and COPY'd files end up root-only.
	'( umask 077; printf "%s %s %s %s\\n" "$$" "$s" "$2" "$b" > "$1.$$" ) 2>/dev/null && mv -f "$1.$$" "$1" 2>/dev/null',
	'exec "${SHELL:-sh}" -c "$3"',
].join("; ");

/**
 * Wraps a build command so it runs in its own session with a pid file, then
 * removes the pid file when the command ends, passing its exit status on.
 *
 * - The subshell makes `setsid` exec in place: it only forks (and then returns
 *   at once) when the caller is a process group leader, which the first
 *   process of an ssh session is.
 * - The command still runs in the login shell (`$SHELL -c`), exactly as when
 *   it is sent over ssh unwrapped.
 * - Without `setsid` the command runs as before, uncancellable, and says so.
 * - If the pid file cannot be written the command still runs.
 */
export const wrapCancelableRemoteBuild = (
	command: string,
	{ pidFile, deploymentId, drainSeconds }: RemoteBuildCancelTarget,
) => {
	// A release step tells the wrapper when its cancel cleanup is finished
	// (`$DOKPLOY_RELEASE_DONE`, see the rolling script's trap): the wrapper then
	// stops waiting even if background helpers of the script are still in the
	// group. The marker is cleared before the command starts.
	const isRelease = Boolean(drainSeconds && drainSeconds > 0);
	const drain =
		drainSeconds && drainSeconds > 0
			? [
					// Only after a signal-style exit (a cancel): a command that ended on
					// its own is not waited for. The group id is the session leader's
					// pid, first field of the pid file.
					'if [ "$__rc" -ge 128 ]; then',
					'read -r __pg _ < "$__f" 2>/dev/null || __pg=""',
					'case "$__pg" in ""|*[!0-9]*|0|1) ;; *)',
					"__i=0",
					`while [ "$__i" -lt ${Math.floor(drainSeconds)} ] && [ ! -e "$__f.done" ] && kill -s 0 -- "-$__pg" 2>/dev/null; do sleep 1; __i=$((__i+1)); done`,
					// The marker stays while helpers are left, for the kill script
					// that may still be polling for it; it removes it.
					'kill -s 0 -- "-$__pg" 2>/dev/null || rm -f "$__f.done";;',
					"esac",
					"fi",
				]
			: [];
	return [
		`__f=${shSingleQuote(pidFile)}`,
		`__id=${shSingleQuote(deploymentId)}`,
		`__cmd=${shSingleQuote(command)}`,
		'mkdir -p "$(dirname "$__f")" 2>/dev/null',
		...(isRelease
			? [
					'rm -f "$__f.done"',
					'DOKPLOY_RELEASE_DONE="$__f.done"; export DOKPLOY_RELEASE_DONE',
				]
			: []),
		"if command -v setsid >/dev/null 2>&1; then",
		`( exec setsid sh -c ${shSingleQuote(SESSION_LAUNCHER)} sh "$__f" "$__id" "$__cmd" )`,
		"else",
		'echo "setsid is not installed on this server: this build cannot be cancelled from Dokploy." >&2',
		'( exec "${SHELL:-sh}" -c "$__cmd" )',
		"fi",
		"__rc=$?",
		...drain,
		'rm -f "$__f"',
		'exit "$__rc"',
	].join("\n");
};

/** What the kill command reports, one word on stdout. */
export type RemoteBuildKillResult =
	/** The group was signalled and is gone. */
	| "KILLED"
	/** No pid file: no wrapped build is running (or it has not started yet). */
	| "NONE"
	/** A pid file that does not belong to this deployment or is unreadable. */
	| "STALE"
	/** The recorded process is gone or is not the one that wrote the file. */
	| "GONE"
	/** The group survived SIGKILL. */
	| "FAILED"
	/** Release steps only: it needed SIGKILL, so its cancel cleanup never ran. */
	| "KILLED_HARD"
	/** No /proc, so the process cannot be told apart from a reused pid. */
	| "UNVERIFIED";

export const KILL_GRACE_SECONDS = 8;

/**
 * Grace for a release step: after SIGTERM its rolling-replace trap still has to
 * remove the replica that was not promoted, which takes longer than a build
 * client needs to unwind. Must stay below the cancel's overall timeout.
 */
export const RELEASE_KILL_GRACE_SECONDS = 20;

/** How long the release wrapper waits for the script's group after it ends. */
export const RELEASE_DRAIN_SECONDS = RELEASE_KILL_GRACE_SECONDS + 5;

/**
 * Runs on the build server: sends SIGTERM to the deployment's process group,
 * waits up to `graceSeconds` for it to go, then SIGKILLs what is left. The
 * docker/buildx client handles SIGTERM by cancelling its BuildKit solve, so the
 * grace lets the daemon side stop cleanly before the hard kill.
 *
 * It refuses to signal anything unless the pid file names this deployment and
 * the process with the recorded pid still has the recorded start time.
 */
export const getKillRemoteBuildCommand = (
	{ pidFile, deploymentId }: RemoteBuildCancelTarget,
	graceSeconds = KILL_GRACE_SECONDS,
	{ reportHardKill = false }: { reportHardKill?: boolean } = {},
) => {
	const grace = Math.max(1, Math.floor(graceSeconds));
	return [
		`f=${shSingleQuote(pidFile)}`,
		`id=${shSingleQuote(deploymentId)}`,
		'[ -f "$f" ] || { echo NONE; exit 0; }',
		'read -r pgid start owner boot < "$f" || { echo STALE; exit 0; }',
		'[ "$owner" = "$id" ] || { echo STALE; exit 0; }',
		'case "$pgid" in ""|*[!0-9]*|0|1) echo STALE; exit 0;; esac',
		'[ "$pgid" != "$$" ] || { echo STALE; exit 0; }',
		'[ -r "/proc/$pgid/stat" ] || { [ -d /proc/self ] && { rm -f "$f"; echo GONE; exit 0; }; echo UNVERIFIED; exit 0; }',
		// A pid file left over from before a reboot names a pid that now belongs to
		// something else; the boot id tells the two boots apart.
		"curboot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)",
		'[ "$boot" = "$curboot" ] || { rm -f "$f"; echo GONE; exit 0; }',
		'cur=$(sed "s/^.*) //" "/proc/$pgid/stat" 2>/dev/null | cut -d" " -f20)',
		'[ -n "$start" ] && [ "$cur" = "$start" ] || { rm -f "$f"; echo GONE; exit 0; }',
		'kill -s TERM -- "-$pgid" 2>/dev/null',
		"i=0",
		`while [ "$i" -lt ${grace} ]; do`,
		// The script finished its cancel cleanup; only helpers can be left. A
		// second later (its own exit) SIGKILL takes those too: a helper that
		// ignores TERM (`docker events`, the stall snapshot) would survive the
		// group signal otherwise.
		'[ ! -e "$f.done" ] || { sleep 1; kill -s KILL -- "-$pgid" 2>/dev/null; rm -f "$f" "$f.done"; echo KILLED; exit 0; }',
		'kill -s 0 -- "-$pgid" 2>/dev/null || { rm -f "$f"; echo KILLED; exit 0; }',
		"sleep 1; i=$((i+1))",
		"done",
		'kill -s KILL -- "-$pgid" 2>/dev/null',
		"sleep 1",
		'kill -s 0 -- "-$pgid" 2>/dev/null && { echo FAILED; exit 0; }',
		`rm -f "$f" "$f.done"; echo ${reportHardKill ? "KILLED_HARD" : "KILLED"}`,
	].join("\n");
};

const KILL_RESULTS: readonly RemoteBuildKillResult[] = [
	"KILLED_HARD",
	"KILLED",
	"NONE",
	"STALE",
	"GONE",
	"FAILED",
	"UNVERIFIED",
];

/** Reads the status word the kill command printed (the last line wins). */
export const parseKillResult = (stdout: string): RemoteBuildKillResult => {
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const last = lines[lines.length - 1];
	return KILL_RESULTS.find((result) => result === last) ?? "FAILED";
};
