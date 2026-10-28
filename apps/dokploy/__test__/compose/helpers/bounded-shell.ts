import {
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
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

const WRAPPER =
	'n=$1; c=$2; shift 2; exec timeout -k 5 "$n" sh -c \'ulimit -t "$0" 2>/dev/null || true; exec sh "$@"\' "$c" "$@"';

/** Whether `timeout` exists for `sh` (looked up by the shell, not by node: on Windows node finds an unrelated `timeout.exe`). */
export const boundedShellAvailable = (() => {
	const probe = spawnSync(
		"sh",
		["-c", "command -v timeout >/dev/null 2>&1 && timeout -k 1 10 true"],
		{ timeout: 30_000 },
	);
	if (probe.status !== 0) {
		console.warn(
			"Skipping the resolver shell tests: `timeout` is not available in sh, and they never run without a bound.",
		);
	}
	return probe.status === 0;
})();

const seconds = (options: SpawnSyncOptionsWithStringEncoding) =>
	options.timeout ? Math.ceil(options.timeout / 1000) : DEFAULT_SECONDS;

/**
 * `spawnSync("sh", args, options)` bounded inside the process: the shell ends
 * after `options.timeout` (150 s by default) however its parent fares.
 */
export const boundedSh = (
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> => {
	if (!boundedShellAvailable) {
		throw new Error("No `timeout` in sh: refusing to run a shell unbounded.");
	}
	const limit = seconds(options);
	return spawnSync(
		"sh",
		["-c", WRAPPER, "sh", String(limit), String(limit), ...args],
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
