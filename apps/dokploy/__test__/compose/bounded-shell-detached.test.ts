import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	shSingleQuote,
	wrapCancelableRemoteBuild,
} from "@dokploy/server/utils/builders/remote-build-cancel";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	boundedSh,
	boundedShellAvailable,
	boundedShSpawn,
	killLaunched,
	LAUNCH_TOKEN_ENV,
	makeTempDir,
} from "./helpers/bounded-shell";

/**
 * `wrapCancelableRemoteBuild` starts the build in a session of its own
 * (`setsid`), outside the process group the bound of `boundedShSpawn` kills.
 * With `leftovers`, that session must not outlive the bound: not when the
 * deadline ends the shell, and not when the wrapper returns while a process of
 * the session still runs, however fast. And only processes of the launch are
 * ever signalled, whatever its pid file says.
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

/** Processes a test started itself (not through a launch), always stopped. */
const bystanders: Array<ReturnType<typeof spawn>> = [];
afterEach(() => {
	// Every launch here is tagged, so this also ends the untracked-gap one.
	killLaunched();
	for (const child of bystanders.splice(0)) child.kill("SIGKILL");
});

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
	} catch (error) {
		// EPERM: it exists, it just is not ours (pid 1 for a non-root run).
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
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

/** Reads a pid the shell wrote to `path` (bounded wait). */
const pidIn = async (path: string) => {
	expect(
		await waitUntil(
			() => existsSync(path) && readFileSync(path, "utf8").trim() !== "",
		),
	).toBe(true);
	const pid = Number(readFileSync(path, "utf8").trim());
	expect(Number.isInteger(pid) && pid > 1).toBe(true);
	return pid;
};

/**
 * Runs `body` through the cancel wrapper in a bounded shell. The body starts a
 * descendant in the detached session that writes its pid to `marker`.
 */
const launch = (
	name: string,
	body: (marker: string, pidFile: string) => string,
	{ seconds, leftovers }: { seconds: number; leftovers: "track" | "kill" },
) => {
	const marker = join(root, `${name}.descendant`);
	const target = { pidFile: join(root, `${name}.pid`), deploymentId: name };
	const child = boundedShSpawn(
		["-c", wrapCancelableRemoteBuild(body(marker, target.pidFile), target)],
		{
			env: { ...process.env, SHELL: "/bin/sh" },
			stdio: "ignore",
			seconds,
			leftovers,
		},
	);
	// The exit code, or the signal when `timeout` itself was killed.
	const exited = new Promise<number | string | null>((resolve) =>
		child.on("close", (code, signal) => resolve(code ?? signal)),
	);
	return { exited, descendant: () => pidIn(marker) };
};

// The session leader waits on a descendant that ignores the TERM of a cancel
// and would outlive the deadline by far.
const waitsPastDeadline = (marker: string) =>
	`sh -c 'trap "" TERM; exec sleep 120' & echo $! > ${shSingleQuote(marker)}; wait`;
// The session leader returns at once, its descendant stays behind.
const returnsAtOnce = (marker: string) =>
	`sleep 120 >/dev/null 2>&1 & echo $! > ${shSingleQuote(marker)}`;

// Not on Windows: Git Bash has no setsid sessions, so there is nothing detached to clean up.
describe.skipIf(!hasSetsid)("detached sessions under a bounded shell", () => {
	it("tracked only, a descendant in the session outlives the deadline (the gap)", {
		timeout: 30_000,
	}, async () => {
		const run = launch("gap", waitsPastDeadline, {
			seconds: 2,
			leftovers: "track",
		});
		const pid = await run.descendant();
		// The deadline ends the shell (124 or, after the -k grace, 137)...
		expect(await run.exited).not.toBe(0);
		// ...and the session's descendant is still there (afterEach ends it).
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(isAlive(pid)).toBe(true);
	});

	it("the deadline also kills the detached session", {
		timeout: 30_000,
	}, async () => {
		const run = launch("deadline", waitsPastDeadline, {
			seconds: 2,
			leftovers: "kill",
		});
		const pid = await run.descendant();
		expect(await run.exited).not.toBe(0);
		// The reaper next to `timeout` kills it, with no help from node.
		expect(await waitUntil(() => !isAlive(pid))).toBe(true);
	});

	it("a wrapper that returns at once does not leave its session running", {
		timeout: 30_000,
	}, async () => {
		const run = launch("early", returnsAtOnce, {
			seconds: 60,
			leftovers: "kill",
		});
		// The wrapper ends on its own, well before its 60 s bound, and its pid
		// file is gone by then: nothing had to see it.
		expect(await run.exited).toBe(0);
		expect(existsSync(join(root, "early.pid"))).toBe(false);
		const pid = await run.descendant();
		expect(await waitUntil(() => !isAlive(pid))).toBe(true);
	});

	it("killLaunched ends a tracked session while the shell is still running", {
		timeout: 30_000,
	}, async () => {
		const run = launch("teardown", waitsPastDeadline, {
			seconds: 60,
			leftovers: "track",
		});
		const pid = await run.descendant();
		killLaunched();
		expect(await waitUntil(() => !isAlive(pid))).toBe(true);
		// `timeout` carries the token too: the whole launch is gone.
		expect(await run.exited).not.toBe(0);
	});

	it("a pid file that names another process gets it no signal", {
		timeout: 30_000,
	}, async () => {
		// Not part of any launch: what a reused pid or a forged pid file names.
		const bystander = spawn("sleep", ["60"], { stdio: "ignore" });
		bystanders.push(bystander);
		const foreign = bystander.pid as number;
		const stat = readFileSync(`/proc/${foreign}/stat`, "utf8");
		const foreignStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		// The body rewrites its own pid file to name the bystander (with its real
		// start time), then leaves a descendant behind and returns.
		const run = launch(
			"forged",
			(marker, pidFile) =>
				`printf '%s %s forged\\n' ${foreign} ${foreignStart} > ${shSingleQuote(pidFile)}; ${returnsAtOnce(marker)}; cp ${shSingleQuote(pidFile)} ${shSingleQuote(`${pidFile}.seen`)}`,
			{ seconds: 60, leftovers: "kill" },
		);
		expect(await run.exited).toBe(0);
		expect(readFileSync(join(root, "forged.pid.seen"), "utf8")).toContain(
			String(foreign),
		);
		const pid = await run.descendant();
		expect(await waitUntil(() => !isAlive(pid))).toBe(true);
		// The teardown from node, too, leaves it alone.
		writeFileSync(join(root, "forged.pid"), `${foreign} ${foreignStart} x\n`);
		killLaunched();
		expect(isAlive(foreign)).toBe(true);
		expect(isAlive(process.ppid)).toBe(true);
		expect(isAlive(1)).toBe(true);
	});

	it("only a whole environment entry with the token counts, not one that contains it", {
		timeout: 30_000,
	}, async () => {
		const go = join(root, "variants.go");
		// Leaves a descendant behind and returns once the bystanders exist.
		const run = launch(
			"variants",
			(marker) =>
				`${returnsAtOnce(marker)}; i=0; while [ ! -e ${shSingleQuote(go)} ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done`,
			{ seconds: 60, leftovers: "kill" },
		);
		const pid = await run.descendant();
		const entry = readFileSync(`/proc/${pid}/environ`, "latin1")
			.split("\0")
			.find((e) => e.startsWith(`${LAUNCH_TOKEN_ENV}=`));
		expect(entry).toBeDefined();
		const token = (entry as string).slice(LAUNCH_TOKEN_ENV.length + 1);
		// Processes that hold the token, but not as the launch's own entry.
		const variants = [
			{ [`OTHER_${LAUNCH_TOKEN_ENV}`]: token },
			{ [LAUNCH_TOKEN_ENV]: `${token}-suffix` },
			{ [LAUNCH_TOKEN_ENV]: `prefix-${token}` },
			{ NOTE: `${LAUNCH_TOKEN_ENV}=${token}` },
		].map((extra) => {
			const child = spawn("sleep", ["60"], {
				env: { PATH: process.env.PATH, ...extra },
				stdio: "ignore",
			});
			bystanders.push(child);
			return child.pid as number;
		});
		expect(await waitUntil(() => variants.every(isAlive))).toBe(true);

		writeFileSync(go, "");
		expect(await run.exited).toBe(0);
		// The reaper takes the descendant and leaves every variant alone...
		expect(await waitUntil(() => !isAlive(pid))).toBe(true);
		expect(variants.filter((p) => !isAlive(p))).toEqual([]);
		// ...and so does the teardown from node.
		killLaunched();
		expect(variants.filter((p) => !isAlive(p))).toEqual([]);
	});
});
