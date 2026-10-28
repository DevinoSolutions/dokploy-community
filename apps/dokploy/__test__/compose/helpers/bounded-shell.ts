import {
	type ChildProcess,
	type SpawnOptions,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	spawn,
	spawnSync,
} from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";

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

/**
 * `spawn("sh", args, options)` with the same bound, for a shell the test talks
 * to while it runs. `seconds` is the bound (150 s by default); the returned
 * child is the `timeout` process, which passes signals on to the shell and
 * exits with its status.
 */
export const boundedShSpawn = (
	args: string[],
	{ seconds: limit, ...options }: SpawnOptions & { seconds?: number } = {},
): ChildProcess =>
	spawn("sh", wrapperArgs("sh", limit ?? DEFAULT_SECONDS, args), options);

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
