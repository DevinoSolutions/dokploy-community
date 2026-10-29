import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapCancelableRemoteBuild } from "@dokploy/server/utils/builders/remote-build-cancel";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	boundedSh,
	boundedShellAvailable,
	boundedShSpawn,
	killDetachedGroups,
	makeTempDir,
} from "./helpers/bounded-shell";

/**
 * `wrapCancelableRemoteBuild` starts the build in a session of its own
 * (`setsid`), outside the process group the bound of `boundedShSpawn` kills.
 * With `pidFile`, that session must not outlive the bound: not when the
 * deadline ends the shell, and not when the wrapper returns while a process of
 * the session is still running.
 */

const hasSetsid =
	process.platform !== "win32" &&
	boundedShellAvailable &&
	boundedSh(["-c", "command -v setsid && [ -d /proc/self ]"], {
		encoding: "utf8",
		timeout: 30_000,
	}).status === 0;

const root = makeTempDir(join(tmpdir(), "dokploy-detached-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * What a test started, killed whatever happens: the descendant (`pid`) and
 * its session (`-pgid`), including the untracked one of the gap test.
 */
const strays: number[] = [];
afterEach(() => {
	killDetachedGroups();
	for (const pid of strays.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
});

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	// A killed process nobody reaped yet (no init in a container) is a zombie.
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
	} catch {
		return false;
	}
};

/** Polls (bounded) until `check` holds; returns whether it did. */
const waitUntil = async (check: () => boolean, ms = 15_000) => {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return true;
};

/**
 * Runs `body` through the cancel wrapper in a bounded shell. The body starts a
 * descendant in the detached session that writes its pid to a marker file and
 * would sleep for 120 s.
 */
const launch = (
	name: string,
	body: (marker: string) => string,
	{ seconds, track }: { seconds: number; track: boolean },
) => {
	const marker = join(root, `${name}.descendant`);
	const target = { pidFile: join(root, `${name}.pid`), deploymentId: name };
	const child = boundedShSpawn(
		["-c", wrapCancelableRemoteBuild(body(marker), target)],
		{
			env: { ...process.env, SHELL: "/bin/sh" },
			stdio: "ignore",
			seconds,
			...(track ? { pidFile: target.pidFile } : {}),
		},
	);
	const exited = new Promise<number | null>((resolve) =>
		child.on("close", (code) => resolve(code)),
	);
	const descendant = async () => {
		expect(
			await waitUntil(
				() => existsSync(marker) && readFileSync(marker, "utf8").trim() !== "",
			),
		).toBe(true);
		const pid = Number(readFileSync(marker, "utf8").trim());
		expect(Number.isInteger(pid) && pid > 1).toBe(true);
		strays.push(pid);
		// The launcher wrote the pid file before it ran the body.
		try {
			const pgid = Number(readFileSync(target.pidFile, "utf8").split(" ")[0]);
			if (Number.isInteger(pgid) && pgid > 1) strays.push(-pgid);
		} catch {
			// Already removed by a wrapper that returned.
		}
		return pid;
	};
	return { exited, descendant };
};

// The session leader waits on a descendant that ignores the TERM of a cancel
// and would outlive the deadline by far.
const waitsPastDeadline = (marker: string) =>
	`sh -c 'trap "" TERM; exec sleep 120' & echo $! > ${marker}; wait`;
// The session leader returns after a second, its descendant stays behind.
const returnsEarly = (marker: string) =>
	`sleep 120 >/dev/null 2>&1 & echo $! > ${marker}; sleep 1`;

describe.skipIf(!hasSetsid)("detached sessions under a bounded shell", () => {
	it("without the pid file, a descendant in the session outlives the deadline (the gap)", {
		timeout: 30_000,
	}, async () => {
		const run = launch("gap", waitsPastDeadline, { seconds: 2, track: false });
		const pid = await run.descendant();
		// The deadline ends the shell (124 or, after the -k grace, 137)...
		expect(await run.exited).not.toBe(0);
		// ...and the session's descendant is still there.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(isAlive(pid)).toBe(true);
	});

	it("with the pid file, the deadline also kills the detached session", {
		timeout: 30_000,
	}, async () => {
		const run = launch("deadline", waitsPastDeadline, {
			seconds: 2,
			track: true,
		});
		const pid = await run.descendant();
		expect(await run.exited).not.toBe(0);
		// The reaper next to `timeout` kills the group, with no help from node.
		expect(await waitUntil(() => !isAlive(pid))).toBe(true);
	});

	it("with the pid file, a wrapper that returns early does not leave its session running", {
		timeout: 30_000,
	}, async () => {
		const run = launch("early", returnsEarly, { seconds: 60, track: true });
		const pid = await run.descendant();
		// The wrapper ends on its own, well before its 60 s bound.
		expect(await run.exited).toBe(0);
		expect(await waitUntil(() => !isAlive(pid))).toBe(true);
	});

	it("killDetachedGroups ends a tracked session while the shell is still running", {
		timeout: 30_000,
	}, async () => {
		const run = launch("teardown", waitsPastDeadline, {
			seconds: 60,
			track: true,
		});
		const pid = await run.descendant();
		// The tracker polls every 50 ms; give it time to see the pid file.
		await new Promise((resolve) => setTimeout(resolve, 500));
		killDetachedGroups();
		expect(await waitUntil(() => !isAlive(pid))).toBe(true);
		// With its session gone, the wrapper (and so `timeout`) returns too.
		expect(await run.exited).not.toBeNull();
	});
});
