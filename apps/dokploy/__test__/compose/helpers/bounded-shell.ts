import {
	type ChildProcess,
	type SpawnOptions,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	spawn,
	spawnSync,
} from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

// The tests that run resolver or own-directory shell text start a real shell.
// Node's spawn timeout only stops the direct child; on Windows the shell's own
// children can outlive it (and the whole run), and a shell that keeps looping
// slows down every later process start. So the bound is set INSIDE the spawned
// process: `timeout -k 5 N sh ...` with a CPU cap (`ulimit -t`), which ends the
// shell even when node or vitest has been killed. A host without `timeout` does
// not run these tests at all, never without a bound.

/** Seconds a shell may run when the caller gives no timeout of its own. */
const DEFAULT_SECONDS = 150;

// $1 seconds, $2 the CPU cap, $3 the absolute `timeout`, $4 the shell to run.
// The `timeout` path is resolved once, so a test that puts a stub `timeout` on
// the PATH of the script it runs does not take the bound away.
const WRAPPER =
	'n=$1; c=$2; t=$3; s=$4; shift 4; exec "$t" -k 5 "$n" sh -c \'ulimit -t "$0" 2>/dev/null || true; s=$1; shift; exec "$s" "$@"\' "$c" "$s" "$@"';

/** Where `sh` finds `timeout` (looked up by the shell, not by node: on Windows node finds an unrelated `timeout.exe`). */
const timeoutPath = (() => {
	const probe = spawnSync(
		"sh",
		["-c", 't=$(command -v timeout) && "$t" -k 1 10 true && printf %s "$t"'],
		{ encoding: "utf8", timeout: 30_000 },
	);
	return probe.status === 0 && probe.stdout ? probe.stdout : "";
})();

/** Whether `timeout` exists for `sh`. */
export const boundedShellAvailable = (() => {
	if (!timeoutPath) {
		console.warn(
			"Skipping the resolver shell tests: `timeout` is not available in sh, and they never run without a bound.",
		);
	}
	return timeoutPath !== "";
})();

const toSeconds = (timeout: number | undefined) =>
	timeout ? Math.ceil(timeout / 1000) : DEFAULT_SECONDS;

const seconds = (options: SpawnSyncOptionsWithStringEncoding) =>
	toSeconds(options.timeout);

const wrapperArgs = (shell: string, limit: number, args: string[]) => {
	if (!boundedShellAvailable) {
		throw new Error("No `timeout` in sh: refusing to run a shell unbounded.");
	}
	return [
		"-c",
		WRAPPER,
		"sh",
		String(limit),
		String(limit),
		timeoutPath,
		shell,
		...args,
	];
};

/**
 * `spawnSync("sh", args, options)` bounded inside the process: the shell ends
 * after `options.timeout` (150 s by default) however its parent fares.
 */
export const boundedSh = (
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> =>
	spawnSync("sh", wrapperArgs("sh", seconds(options), args), options);

/**
 * `spawnSync("bash", args, options)` with the same bound as `boundedSh` (the
 * `bash` the bounded `sh` finds: Git Bash on Windows, not the WSL launcher).
 */
export const boundedBash = (
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> =>
	spawnSync(
		"sh",
		wrapperArgs(
			// Spelled out on Windows: a `bash` on the PATH can still be WSL's.
			process.platform === "win32" ? "/usr/bin/bash" : "bash",
			seconds(options),
			args,
		),
		options,
	);

// The bound above ends what runs in `timeout`'s process group. A command that
// starts its own session (`wrapCancelableRemoteBuild` runs the build under
// `setsid`) leaves that group, so the deadline, or a wrapper that returns while
// the session still has processes, would leave it running. The pid file the
// session leader writes (`<pgid> <start time> ...`) names that group: a reaper
// started next to `timeout` learns it while the shell runs and kills it once
// `timeout` is gone, and the test process does the same from `afterEach` with
// `killDetachedGroups`. A group is only taken when its leader is alive and has
// the recorded start time, so a stale pid file never names another process.

// Prints the group the pid file $1 names, when its leader is that process.
const READ_GROUP =
	'read -r g st _ < "$1" 2>/dev/null || exit 0; case "$g" in ""|*[!0-9]*|0|1) exit 0;; esac; s=$(sed "s/^.*) //" /proc/$g/stat 2>/dev/null | cut -d" " -f20); [ -n "$s" ] && [ "$s" = "$st" ] && printf %s "$g"';

// $5 the pid file, $6 READ_GROUP. `$$` is the pid that `exec` hands to
// `timeout`; the reaper (outside `timeout`'s group, so the deadline does not
// reach it) polls until that process is gone, capped at the bound plus 10 s,
// then kills the group.
const REAPING_WRAPPER = `n=$1; c=$2; t=$3; s=$4; p=$5; r=$6; shift 6
(
	g=""; i=0; m=$(( (n + 10) * 5 ))
	while [ "$i" -lt "$m" ]; do
		[ -n "$g" ] || g=$(sh -c "$r" sh "$p")
		kill -0 "$$" 2>/dev/null || break
		sleep 0.2; i=$((i + 1))
	done
	[ -n "$g" ] || g=$(sh -c "$r" sh "$p")
	[ -z "$g" ] || kill -s KILL -- "-$g" 2>/dev/null
) </dev/null >/dev/null 2>&1 &
exec "$t" -k 5 "$n" sh -c 'ulimit -t "$0" 2>/dev/null || true; s=$1; shift; exec "$s" "$@"' "$c" "$s" "$@"`;

const detachedGroups = new Set<number>();

/** The group a launcher's pid file names, or 0 (same checks as `READ_GROUP`). */
const readDetachedGroup = (pidFile: string) => {
	try {
		const [group, start] = readFileSync(pidFile, "utf8").trim().split(" ");
		const pgid = Number(group);
		if (!Number.isInteger(pgid) || pgid <= 1) return 0;
		const stat = readFileSync(`/proc/${pgid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[19] === start ? pgid : 0;
	} catch {
		return 0;
	}
};

/**
 * Remembers the detached group named by `pidFile` once it appears (polled for
 * up to `seconds`), for `killDetachedGroups`.
 */
export const trackDetachedGroup = (pidFile: string, seconds = 60) => {
	const deadline = Date.now() + seconds * 1000;
	const poll = setInterval(() => {
		const pgid = readDetachedGroup(pidFile);
		if (pgid) detachedGroups.add(pgid);
		if (pgid || Date.now() > deadline) clearInterval(poll);
	}, 50);
	poll.unref();
	return () => {
		const pgid = readDetachedGroup(pidFile);
		if (pgid) detachedGroups.add(pgid);
		clearInterval(poll);
	};
};

/** SIGKILLs every tracked detached group (for `afterEach`). */
export const killDetachedGroups = () => {
	for (const pgid of detachedGroups) {
		try {
			process.kill(-pgid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	detachedGroups.clear();
};
process.once("exit", killDetachedGroups);

/**
 * `spawn("sh", args, options)` with the same bound, for a shell the test talks
 * to while it runs. `seconds` is the bound (150 s by default); the returned
 * child is the `timeout` process, which passes signals on to the shell and
 * exits with its status.
 *
 * `pidFile`: the shell starts a detached session (`wrapCancelableRemoteBuild`)
 * that writes this pid file. Its group is killed once `timeout` is gone (the
 * deadline, or a wrapper that returned early) and by `killDetachedGroups`. The
 * path must read the same in node and in sh (the setsid tests are Linux-only).
 */
export const boundedShSpawn = (
	args: string[],
	{
		seconds: limit,
		pidFile,
		...options
	}: SpawnOptions & { seconds?: number; pidFile?: string } = {},
): ChildProcess => {
	const bound = limit ?? DEFAULT_SECONDS;
	if (!pidFile) return spawn("sh", wrapperArgs("sh", bound, args), options);
	if (!boundedShellAvailable) {
		throw new Error("No `timeout` in sh: refusing to run a shell unbounded.");
	}
	const child = spawn(
		"sh",
		[
			"-c",
			REAPING_WRAPPER,
			"sh",
			String(bound),
			String(bound),
			timeoutPath,
			"sh",
			pidFile,
			READ_GROUP,
			...args,
		],
		options,
	);
	child.once("exit", trackDetachedGroup(pidFile, bound + 10));
	return child;
};

/**
 * A script piped to `sh -s` in a throwaway `--rm` container, bounded by the
 * `timeout` of the image (coreutils or busybox) and a CPU cap, with a stop
 * timeout for the container itself.
 */
export const boundedDockerSh = (
	image: string,
	options: SpawnSyncOptionsWithStringEncoding & { input: string },
): SpawnSyncReturns<string> => {
	const limit = seconds(options);
	return spawnSync(
		"docker",
		[
			"run",
			"--rm",
			"-i",
			"--stop-timeout",
			"5",
			image,
			"timeout",
			"-k",
			"5",
			String(limit),
			"sh",
			"-s",
		],
		{
			...options,
			input: `ulimit -t ${limit} 2>/dev/null || true\n${options.input}`,
		},
	);
};

const created = new Set<string>();
process.once("exit", () => {
	for (const dir of created) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Held by a process that is still ending: nothing more to do here.
		}
	}
});

/**
 * `mkdtemp` that also removes the directory when the process exits, so a test
 * that timed out (and never reached its `afterAll`) leaves nothing behind.
 */
export const makeTempDir = (prefix: string) => {
	const dir = mkdtempSync(prefix);
	created.add(dir);
	return dir;
};
