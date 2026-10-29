import {
	type ChildProcess,
	type SpawnOptions,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	spawn,
	spawnSync,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";

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
// the session still has processes, would leave it running.
//
// Such leftovers are found by a per-launch token, never by a recorded number:
// the launch gets `DOKPLOY_TEST_LAUNCH=<random uuid>` in its environment, which
// every process it starts inherits, setsid or not. A process is signalled only
// when its own /proc/<pid>/environ holds that token, checked again right before
// the signal (environ is readable only for our own uid, unless root). A pid
// file, a reused pid or a foreign session leader carries no token, so none is
// ever signalled. Nothing is polled while the shell runs, so a leader that
// exits at once is not missed either: the search runs when it is needed.

/** The variable that tags every process of a launch. */
export const LAUNCH_TOKEN_ENV = "DOKPLOY_TEST_LAUNCH";

/** Tokens of launches whose leftovers `killLaunched` still has to remove. */
const liveTokens = new Set<string>();

/** A new launch token, remembered for `killLaunched`. */
export const newLaunchToken = () => {
	const token = randomUUID();
	liveTokens.add(token);
	return token;
};

/** Whether the process `pid` carries one of `entries` in its environment. */
const carries = (pid: string, entries: Set<string>) => {
	let environ: string;
	try {
		environ = readFileSync(`/proc/${pid}/environ`, "latin1");
	} catch {
		// Gone, or not ours: either way not signalled.
		return false;
	}
	return environ.split("\0").some((entry) => entries.has(entry));
};

/**
 * Pids of processes (not this one) that carry one of `entries`, or null on a
 * host without /proc. A killed process is a zombie with an empty environment
 * until it is reaped, so it no longer counts.
 */
const taggedPids = (entries: Set<string>) => {
	let names: string[];
	try {
		names = readdirSync("/proc");
	} catch {
		return null;
	}
	return names.filter(
		(name) =>
			/^\d+$/.test(name) &&
			Number(name) !== process.pid &&
			carries(name, entries),
	);
};

/** Blocks for `ms` (the exit hook cannot wait asynchronously). */
const pause = (ms: number) =>
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * SIGKILLs every process that carries one of the tokens (all live ones by
 * default), checking each one's environment right before its signal, and
 * searches again until none is left. A token is forgotten only then. Throws
 * (failing the test) when tagged processes are still there after `seconds`;
 * their tokens stay, for a later call. On a host without /proc it does nothing.
 */
export const killLaunched = (
	tokens: Iterable<string> = liveTokens,
	seconds = 5,
) => {
	const list = [...tokens];
	if (list.length === 0) return;
	const entries = new Set(list.map((t) => `${LAUNCH_TOKEN_ENV}=${t}`));
	const deadline = Date.now() + seconds * 1000;
	for (;;) {
		const pids = taggedPids(entries);
		if (pids === null || pids.length === 0) {
			for (const token of list) liveTokens.delete(token);
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`${pids.length} process(es) of a test launch still run ${seconds} s after SIGKILL.`,
			);
		}
		for (const pid of pids) {
			// Checked again just before the signal. What is left is accepted: the
			// process would have to be reaped and its number reused (by a process
			// of our own uid, unless root) in the microseconds between this check,
			// which just matched the token, and kill(). Closing that would take a
			// pidfd, which node does not have, or a cgroup per launch.
			if (!carries(pid, entries)) continue;
			try {
				process.kill(Number(pid), "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		pause(50);
	}
};
process.once("exit", () => {
	try {
		killLaunched();
	} catch {
		// Nothing more can be done while the process exits.
	}
});

// $1 seconds, $2 the CPU cap, $3 the absolute `timeout`, $4 the shell, $5 the
// launch token, $6 "reap" or "". The token goes on through `env`, so this shell
// and the reaper it forks do not carry it (it is an argument here, not part of
// their environment). With "reap", the reaper waits until `timeout` (the pid
// `exec` hands it, `$$`) is gone, capped at the bound plus 10 s, then kills what
// still carries the token: the detached session, whatever the deadline or an
// early return left. Each process is checked again right before its signal,
// on a whole NUL-separated entry of its environment (`grep -F` alone would
// also take OTHER_<var>=<token> or <var>=<token>-x), and the search repeats,
// for up to 5 s, until nothing tagged is left. The race left between that
// check and kill() is the one described in `killLaunched`.
const TAGGING_WRAPPER = `n=$1; c=$2; t=$3; s=$4; k=$5; r=$6; shift 6
if [ "$r" = reap ]; then
	(
		v="${LAUNCH_TOKEN_ENV}=$k"; i=0; m=$(( (n + 10) * 5 ))
		while [ "$i" -lt "$m" ] && kill -0 "$$" 2>/dev/null; do sleep 0.2; i=$((i + 1)); done
		j=0
		while [ "$j" -lt 25 ]; do
			# Candidates only (not grep's status: it is 2 when any process ended
			# mid-search); each one is matched exactly below.
			l=$(grep -lsF -- "$v" /proc/[0-9]*/environ 2>/dev/null)
			h=""
			for f in $l; do
				tr '\\000' '\\n' < "$f" 2>/dev/null | grep -qxF -- "$v" || continue
				h=1; p=\${f#/proc/}; p=\${p%/environ}
				kill -s KILL "$p" 2>/dev/null
			done
			[ -n "$h" ] || break
			sleep 0.2; j=$((j + 1))
		done
	) </dev/null >/dev/null 2>&1 &
fi
exec env "${LAUNCH_TOKEN_ENV}=$k" "$t" -k 5 "$n" sh -c 'ulimit -t "$0" 2>/dev/null || true; s=$1; shift; exec "$s" "$@"' "$c" "$s" "$@"`;

/**
 * `spawn("sh", args, options)` with the same bound, for a shell the test talks
 * to while it runs. `seconds` is the bound (150 s by default); the returned
 * child is the `timeout` process, which passes signals on to the shell and
 * exits with its status.
 *
 * `leftovers`, for a shell that starts a detached session
 * (`wrapCancelableRemoteBuild`), which the bound does not reach:
 * - "track": its processes carry a launch token, and `killLaunched` (from
 *   `afterEach`) kills whatever of them is left;
 * - "kill": the same, and also as soon as `timeout` is gone (the deadline, or
 *   a wrapper that returned while its session still runs), with no help from
 *   node. Only for Linux hosts (it searches /proc).
 */
export const boundedShSpawn = (
	args: string[],
	{
		seconds: limit,
		leftovers,
		...options
	}: SpawnOptions & { seconds?: number; leftovers?: "track" | "kill" } = {},
): ChildProcess => {
	const bound = limit ?? DEFAULT_SECONDS;
	if (!leftovers) return spawn("sh", wrapperArgs("sh", bound, args), options);
	if (!boundedShellAvailable) {
		throw new Error("No `timeout` in sh: refusing to run a shell unbounded.");
	}
	return spawn(
		"sh",
		[
			"-c",
			TAGGING_WRAPPER,
			"sh",
			String(bound),
			String(bound),
			timeoutPath,
			"sh",
			newLaunchToken(),
			leftovers === "kill" ? "reap" : "",
			...args,
		],
		options,
	);
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
