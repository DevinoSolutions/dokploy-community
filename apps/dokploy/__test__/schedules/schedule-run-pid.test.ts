import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Application and compose schedule runs record the in-container pid of their
 * command, so that `deployment.killProcess` can stop them (see
 * schedule-kill-process.test.ts). The pid comes from a marker line that the
 * wrapper prints before it execs the command; only the first one counts.
 */

const mocks = vi.hoisted(() => ({
	findScheduleById: vi.fn(),
	findScheduleOrganizationId: vi.fn(),
	createDeploymentSchedule: vi.fn(),
	updateDeployment: vi.fn(),
	finishScheduleRun: vi.fn(),
	getDokployUrl: vi.fn(),
	getServiceContainer: vi.fn(),
	getComposeContainer: vi.fn(),
	spawnAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	sendScheduleFailureNotifications: vi.fn(),
	createWriteStream: vi.fn(),
	logWrite: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({
	IS_CLOUD: false,
	paths: () => ({ SCHEDULES_PATH: "/tmp/schedules" }),
}));

vi.mock("@dokploy/server/services/schedule", () => ({
	findScheduleById: mocks.findScheduleById,
	findScheduleOrganizationId: mocks.findScheduleOrganizationId,
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeploymentSchedule: mocks.createDeploymentSchedule,
	updateDeployment: mocks.updateDeployment,
}));

// How a run ends is recorded by a conditional update (see run-status.ts); it is
// covered by schedule-run-cancelled.test.ts.
vi.mock("@dokploy/server/utils/schedules/run-status", () => ({
	finishScheduleRun: mocks.finishScheduleRun,
	isScheduleRunCancelled: vi.fn(async () => false),
}));

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: mocks.getDokployUrl,
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	getServiceContainer: mocks.getServiceContainer,
	getComposeContainer: mocks.getComposeContainer,
}));

vi.mock("@dokploy/server/utils/process/spawnAsync", () => ({
	spawnAsync: mocks.spawnAsync,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/utils/notifications/schedule-failure", () => ({
	sendScheduleFailureNotifications: mocks.sendScheduleFailureNotifications,
}));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	createWriteStream: mocks.createWriteStream,
}));

vi.mock("node-schedule", () => ({
	scheduleJob: vi.fn(),
	scheduledJobs: {},
}));

import {
	createSchedulePidCapture,
	SCHEDULE_KILL_SCRIPT,
	SCHEDULE_NONE_MARKER,
	SCHEDULE_RUN_WRAPPER,
} from "@dokploy/server/utils/schedules/container-run";
import { runCommand } from "@dokploy/server/utils/schedules/utils";

const MARKER = "__DOKPLOY_SCHEDULE_PID__";
const LOG_FILE = "run.log";

const schedule = (serverId: string | null) => ({
	scheduleId: "sch-1",
	name: "Nightly",
	scheduleType: "application" as const,
	command: `echo "it's $HOME"`,
	shellType: "bash",
	appName: "my-app",
	serviceName: null,
	serverId: null,
	compose: null,
	application: {
		appName: "my-app",
		serverId,
		environment: { project: { name: "Project" } },
	},
});

// Runs a generated remote command in bash, in a scratch directory, with
// `docker` replaced by a function body. Returns what ssh would hand back
// (stdout), the exit status and the content of the deployment log.
let workDir = "";
const runRemote = (command: string, dockerBody: string) => {
	const result = spawnSync(
		"bash",
		[
			"-c",
			`docker() { ${dockerBody}; }
${command}`,
		],
		{
			encoding: "utf8",
			cwd: workDir,
		},
	);
	const logFile = join(workDir, LOG_FILE);
	return {
		stdout: result.stdout,
		status: result.status,
		log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "",
	};
};

// What docker would be called with, once the shell has unquoted the command.
const dockerArgs = (command: string) => {
	runRemote(command, String.raw`printf '%s\0' "$@" > args.bin`);
	return readFileSync(join(workDir, "args.bin"), "utf8")
		.split("\0")
		.slice(0, -1);
};

const remoteCommand = () => mocks.execAsyncRemote.mock.calls[0]?.[1] as string;

const loggedOutput = () =>
	mocks.logWrite.mock.calls.map((call) => String(call[0])).join("");

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "schedule-run-pid-"));
	vi.clearAllMocks();
	mocks.createDeploymentSchedule.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: LOG_FILE,
	});
	mocks.finishScheduleRun.mockResolvedValue("recorded");
	mocks.updateDeployment.mockResolvedValue(undefined);
	mocks.findScheduleOrganizationId.mockResolvedValue("org-1");
	mocks.getDokployUrl.mockResolvedValue("https://dokploy.test");
	mocks.sendScheduleFailureNotifications.mockResolvedValue(undefined);
	mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });
	mocks.createWriteStream.mockReturnValue({
		write: mocks.logWrite,
		end: vi.fn(),
		writable: true,
	});
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("runCommand pid capture on a remote server", () => {
	it("runs the command tagged with the run id and records the pid from the marker line", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("srv-1"));
		mocks.execAsyncRemote.mockImplementation(
			async (_serverId, _command, onData) => {
				onData(`${MARKER}=77\nhello\n`);
				return { stdout: "", stderr: "" };
			},
		);

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "done",
		});

		expect(mocks.updateDeployment).toHaveBeenCalledTimes(1);
		expect(mocks.updateDeployment).toHaveBeenCalledWith("dep-1", { pid: "77" });

		const [serverId, command, , options] = mocks.execAsyncRemote.mock
			.calls[0] as [string, string, unknown, unknown];
		expect(serverId).toBe("srv-1");
		expect(command).toContain("set -o pipefail");
		expect(command).not.toContain("tee");
		expect(command).toContain("Command executed successfully");
		// The user command is the stdin of the ssh channel, not part of the script.
		expect(options).toEqual({ streamOnly: true, stdin: `echo "it's $HOME"` });
		expect(command).not.toContain("it's");
		// What docker receives once the shell has unquoted the command: the user
		// command is on its stdin (-i), never an argument.
		expect(dockerArgs(command)).toEqual([
			"exec",
			"-i",
			"-e",
			"DOKPLOY_SCHEDULE_RUN=dep-1",
			"cont-1",
			"bash",
			"-c",
			SCHEDULE_RUN_WRAPPER,
			"bash",
		]);
	});

	it("keeps a secret and a script larger than one shell argument out of the command", async () => {
		const secret = "s3cr3t-token-value";
		const big = `export TOKEN=${secret}\n${"echo padding\n".repeat(30_000)}`;
		mocks.findScheduleById.mockResolvedValue({
			...schedule("srv-1"),
			command: big,
		});
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

		await runCommand("sch-1");

		const [, command, , options] = mocks.execAsyncRemote.mock.calls[0] as [
			string,
			string,
			unknown,
			{ stdin?: string },
		];
		expect(command).not.toContain(secret);
		expect(command.length).toBeLessThan(2_000);
		expect(options.stdin).toBe(big);
	});

	describe("output of the generated remote command", () => {
		const prime = async () => {
			mocks.findScheduleById.mockResolvedValue(schedule("srv-1"));
			mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
			await runCommand("sch-1");
			return remoteCommand();
		};

		it("sends only the pid line over ssh and writes everything else to the log", async () => {
			const command = await prime();

			const run = runRemote(
				command,
				String.raw`printf '${MARKER}=7\nhello\n'; echo oops >&2`,
			);

			expect(run.stdout).toBe(`${MARKER}=7
`);
			expect(run.status).toBe(0);
			expect(run.log).not.toContain(MARKER);
			expect(run.log).toContain("hello\n");
			expect(run.log).toContain("oops\n");
			expect(run.log).toContain("Running scheduled command");
			expect(run.log).toContain("✅ Command executed successfully");
		});

		it("fails with exit 1 and no command output on stdout when the command fails", async () => {
			const command = await prime();

			const run = runRemote(
				command,
				String.raw`printf '${MARKER}=7\nsecret output\n'; echo secret error >&2; return 3`,
			);

			expect(run.status).toBe(1);
			expect(run.stdout).toBe(`${MARKER}=7
`);
			expect(run.stdout).not.toContain("secret");
			expect(run.log).toContain("secret output\n");
			expect(run.log).toContain("secret error\n");
			// The failure line is left to runCommand, which knows whether the run was
			// cancelled (see schedule-run-cancelled.test.ts).
			expect(run.log).not.toContain("Command failed");
			expect(run.log).not.toContain("✅");
		});

		it("logs a first line that is not the marker, such as a docker error, instead of sending it", async () => {
			const command = await prime();

			const run = runRemote(
				command,
				"echo 'Error response from daemon: boom' >&2; return 1",
			);

			expect(run.status).toBe(1);
			expect(run.stdout).toBe("");
			expect(run.log).toContain("Error response from daemon: boom\n");
			expect(run.log).not.toContain("Command failed");
		});

		it("still finds the pid line when docker delivers a stderr line ahead of it", async () => {
			const command = await prime();

			const run = runRemote(
				command,
				`echo early >&2; printf '${MARKER}=7\\nhello\\n${MARKER}=9\\n'`,
			);

			expect(run.stdout).toBe(`${MARKER}=7\n`);
			expect(run.log).toContain("early\n");
			expect(run.log).toContain("hello\n");
			// A later marker line is the command's own output: logged, never sent.
			expect(run.log).toContain(`${MARKER}=9\n`);
			expect(run.log).not.toContain(`${MARKER}=7`);
			expect(run.status).toBe(0);
		});

		it("keeps a last line that has no newline", async () => {
			const command = await prime();

			const run = runRemote(command, `printf '${MARKER}=7\npartial'`);

			expect(run.log).toContain("partial");
			expect(run.log).not.toContain(MARKER);
			expect(run.status).toBe(0);
		});

		it("keeps output that has no newline at all", async () => {
			const command = await prime();

			const run = runRemote(command, "printf 'no newline'");

			expect(run.stdout).toBe("");
			expect(run.log).toContain("no newline");
		});
	});

	it("keeps the first pid when the command prints PID: lines or another marker", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("srv-1"));
		mocks.execAsyncRemote.mockImplementation(
			async (_serverId, _command, onData) => {
				onData(`${MARKER}=77\n`);
				onData("PID: 99\n");
				onData(`${MARKER}=5\nPID: 12\n`);
				return { stdout: "", stderr: "" };
			},
		);

		await runCommand("sch-1");

		expect(mocks.updateDeployment).toHaveBeenCalledTimes(1);
		expect(mocks.updateDeployment).toHaveBeenCalledWith("dep-1", { pid: "77" });
	});

	it("records no pid from output that only looks like one", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("srv-1"));
		mocks.execAsyncRemote.mockImplementation(
			async (_serverId, _command, onData) => {
				onData("PID: 99\n");
				onData(`echo ${MARKER}=5 is not a marker line\n`);
				return { stdout: "", stderr: "" };
			},
		);

		await runCommand("sch-1");

		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});

	it("still fails the run when the command fails", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("srv-1"));
		mocks.execAsyncRemote.mockImplementation(
			async (_serverId, _command, onData) => {
				onData(`${MARKER}=77\n`);
				throw new Error("exit 1");
			},
		);

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "error",
		});

		expect(mocks.updateDeployment).toHaveBeenCalledWith("dep-1", { pid: "77" });
		expect(mocks.finishScheduleRun).toHaveBeenCalledWith("dep-1", "error");
		expect(mocks.sendScheduleFailureNotifications).toHaveBeenCalledTimes(1);
	});

	it("does not fail the run when the pid cannot be stored", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("srv-1"));
		mocks.updateDeployment.mockRejectedValue(new Error("db down"));
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		mocks.execAsyncRemote.mockImplementation(
			async (_serverId, _command, onData) => {
				onData(`${MARKER}=77\n`);
				return { stdout: "", stderr: "" };
			},
		);

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "done",
		});
		consoleErrorSpy.mockRestore();
	});
});

// Stands in for the stdin of the `docker exec` child.
const hostStdin = () => {
	let text = "";
	let finished = false;
	const stream = new Writable({
		write(chunk, _encoding, done) {
			text += chunk.toString();
			done();
		},
		final(done) {
			finished = true;
			done();
		},
	});
	return { stream, received: () => text, ended: () => finished };
};

describe("runCommand pid capture on the Dokploy host", () => {
	it("keeps the command out of the arguments of docker exec on the host", async () => {
		const secret = "s3cr3t-token-value";
		mocks.findScheduleById.mockResolvedValue({
			...schedule(null),
			command: `export TOKEN=${secret}`,
		});
		const stdin = hostStdin();
		mocks.spawnAsync.mockImplementation(() =>
			Object.assign(Promise.resolve({}), { child: { stdin: stdin.stream } }),
		);

		await runCommand("sch-1");

		const args = mocks.spawnAsync.mock.calls[0]?.[1] as string[];
		expect(args.join(" ")).not.toContain(secret);
		expect(stdin.received()).toBe(`export TOKEN=${secret}`);
	});

	it("does not write the command into the run log", async () => {
		const secret = "s3cr3t-token-value";
		mocks.findScheduleById.mockResolvedValue({
			...schedule(null),
			command: `export TOKEN=${secret}`,
		});
		const stdin = hostStdin();
		mocks.spawnAsync.mockImplementation(() =>
			Object.assign(Promise.resolve({}), { child: { stdin: stdin.stream } }),
		);

		await runCommand("sch-1");

		const log = loggedOutput();
		expect(log).toContain("docker exec cont-1 bash");
		expect(log).not.toContain(secret);
		expect(log).not.toContain("-c export");
	});

	it("passes the run tag to docker exec, records the pid and keeps the marker out of the log", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule(null));
		const stdin = hostStdin();
		mocks.spawnAsync.mockImplementation((_cmd, _args, onData) =>
			Object.assign(
				(async () => {
					onData(`${MARKER}=31\nhello\n`);
					onData("PID: 99\n");
					onData(`${MARKER}=8\n`);
				})(),
				{ child: { stdin: stdin.stream } },
			),
		);

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "done",
		});

		expect(mocks.spawnAsync).toHaveBeenCalledWith(
			"docker",
			[
				"exec",
				"-i",
				"-e",
				"DOKPLOY_SCHEDULE_RUN=dep-1",
				"cont-1",
				"bash",
				"-c",
				SCHEDULE_RUN_WRAPPER,
				"bash",
			],
			expect.any(Function),
		);
		// The command is written to the stdin of docker exec, which is then closed.
		expect(stdin.received()).toBe(`echo "it's $HOME"`);
		expect(stdin.ended()).toBe(true);
		expect(mocks.updateDeployment).toHaveBeenCalledTimes(1);
		expect(mocks.updateDeployment).toHaveBeenCalledWith("dep-1", { pid: "31" });

		const log = loggedOutput();
		expect(log).toContain("hello\n");
		expect(log).toContain("PID: 99\n");
		// Only the pid line of the wrapper is hidden; the run's own output stays.
		expect(log).not.toContain(`${MARKER}=31`);
		expect(log).toContain(`${MARKER}=8`);
		expect(log).toContain("Command executed successfully");
	});
});

describe("createSchedulePidCapture", () => {
	const capture = () => {
		const onPid = vi.fn();
		return { feed: createSchedulePidCapture(onPid), onPid };
	};

	it("takes the pid of the first marker line only", () => {
		const { feed, onPid } = capture();
		expect(feed(`${MARKER}=12\nout\n`)).toBe("out\n");
		feed(`${MARKER}=13\n`);
		expect(onPid).toHaveBeenCalledTimes(1);
		expect(onPid).toHaveBeenCalledWith("12");
	});

	it("passes output through untouched until the marker shows up", () => {
		const { feed, onPid } = capture();
		expect(feed("warning\n")).toBe("warning\n");
		expect(feed(`${MARKER}=12\r\n`)).toBe("");
		expect(onPid).toHaveBeenCalledWith("12");
	});

	it("waits for the end of the line before taking the pid", () => {
		const { feed, onPid } = capture();
		feed(`${MARKER}=1`);
		expect(onPid).not.toHaveBeenCalled();
		feed("2\n");
		expect(onPid).toHaveBeenCalledWith("12");
	});

	it("gives up looking once a lot of output went by without it", () => {
		const { feed, onPid } = capture();
		feed("x".repeat(9000));
		feed(`${MARKER}=12\n`);
		expect(onPid).not.toHaveBeenCalled();
	});
});

// The wrapper and the kill script run inside the container, so they are run for
// real here (this needs /proc, i.e. Linux; CI is).
describe.skipIf(process.platform !== "linux")(
	"wrapper and kill script in a real shell",
	() => {
		const RUN_ID = `testrun${process.pid}`;
		const spawned: number[] = [];

		const alive = (pid: number) => {
			try {
				const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
				return (
					stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !==
					"Z"
				);
			} catch {
				return false;
			}
		};
		const until = async (condition: () => boolean, timeoutMs = 5000) => {
			const start = Date.now();
			while (!condition() && Date.now() - start < timeoutMs) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			return condition();
		};

		afterEach(() => {
			for (const pid of spawned.splice(0)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		});

		it.each(["sh", "bash"])(
			"%s: prints the pid of the command and the kill script stops it and its children, and only them",
			async (shell) => {
				if (spawnSync(shell, ["-c", "true"]).error) return;
				const run = spawn(shell, ["-c", SCHEDULE_RUN_WRAPPER, shell], {
					env: { ...process.env, DOKPLOY_SCHEDULE_RUN: RUN_ID },
				});
				run.stdin.end(
					'sleep 300 & echo "CHILD=$!"; sleep 301 & echo "CHILD=$!"; echo "PID: 99"; wait',
				);
				const unrelated = spawn("sleep", ["300"]);
				spawned.push(run.pid as number, unrelated.pid as number);
				let output = "";
				run.stdout.on("data", (data) => {
					output += data.toString();
				});
				const exited = new Promise<void>((resolve) =>
					run.on("close", () => resolve()),
				);

				expect(await until(() => output.split("CHILD=").length > 2)).toBe(true);
				const lines = output.split("\n");
				expect(lines[0]).toBe(`${MARKER}=${run.pid}`);
				const children = [...output.matchAll(/CHILD=(\d+)/g)].map((m) =>
					Number(m[1]),
				);
				spawned.push(...children);
				expect(children).toHaveLength(2);

				const kill = spawnSync(shell, [
					"-c",
					SCHEDULE_KILL_SCRIPT,
					shell,
					RUN_ID,
				]);
				expect(kill.status).toBe(0);
				// It found the run, so it does not say there was nothing to stop.
				expect(kill.stdout.toString()).not.toContain(SCHEDULE_NONE_MARKER);
				await exited;

				expect(
					await until(() =>
						[run.pid as number, ...children].every((p) => !alive(p)),
					),
				).toBe(true);
				expect(alive(unrelated.pid as number)).toBe(true);
			},
		);

		// Runs the wrapper like `docker exec -i` does: the command is the stdin.
		const runWrapper = (
			shell: string,
			command: string,
			env: Record<string, string> = {},
		) =>
			spawnSync(shell, ["-c", SCHEDULE_RUN_WRAPPER, shell], {
				input: command,
				encoding: "utf8",
				env: { ...process.env, ...env },
				maxBuffer: 64 * 1024 * 1024,
			});

		it.each(["sh", "bash"])(
			"%s: runs a command read from stdin, as the same process, and leaves no file behind",
			(shell) => {
				if (spawnSync(shell, ["-c", "true"]).error) return;
				const tmp = mkdtempSync(join(tmpdir(), "schedule-wrapper-"));
				try {
					const run = runWrapper(
						shell,
						'echo "ran $$"\necho "stdin:[$(cat)]"\nls -A "$TMPDIR" | wc -l\nexit 7',
						{ TMPDIR: tmp },
					);

					expect(run.status).toBe(7);
					const [marker, ran, stdin, files] = run.stdout.split("\n");
					const pid = marker?.split("=")[1];
					expect(marker).toBe(`${MARKER}=${pid}`);
					// exec keeps the pid, so the marker names the process the kill script finds.
					expect(ran).toBe(`ran ${pid}`);
					// The command's own stdin is at its end: the script went through it.
					expect(stdin).toBe("stdin:[]");
					// The file is unlinked once open, so even the running command sees none.
					expect(files?.trim()).toBe("0");
					expect(readdirSync(tmp)).toEqual([]);
				} finally {
					rmSync(tmp, { recursive: true, force: true });
				}
			},
		);

		it("runs a command larger than one shell argument and keeps it off the command line", () => {
			const big = `echo start\n${"echo padding\n".repeat(30_000)}echo end\n`;
			// Linux caps a single argument at 128 KB: this one could not be passed.
			expect(big.length).toBeGreaterThan(128 * 1024);
			expect(SCHEDULE_RUN_WRAPPER.length).toBeLessThan(2_000);

			const run = runWrapper("sh", big);

			expect(run.status).toBe(0);
			const lines = run.stdout.split("\n");
			expect(lines[1]).toBe("start");
			expect(lines.at(-2)).toBe("end");
			expect(lines.filter((l) => l === "padding")).toHaveLength(30_000);
		});

		it("does not show the command in the process list of the shell that runs it", () => {
			const secret = "s3cr3t-token-value";
			const run = runWrapper(
				"sh",
				`: ${secret}\ntr '\\0' ' ' < /proc/$$/cmdline\n`,
			);

			expect(run.status).toBe(0);
			expect(run.stdout).not.toContain(secret);
		});

		it("falls back to passing the command as one argument when the temp directory cannot be written", () => {
			const run = runWrapper("sh", 'echo "fallback ok"\nexit 3', {
				TMPDIR: "/nonexistent-dokploy-dir",
			});

			expect(run.status).toBe(3);
			expect(run.stdout).toContain("fallback ok\n");
		});

		const FALLBACK_LINE =
			"dokploy: could not stage the schedule command in a file, running it as a -c argument";

		it("falls back to -c and says so on stderr, without the command, when /dev/fd is not readable", () => {
			const secret = "s3cr3t-token-value";
			// Same wrapper, with a descriptor path that cannot be read.
			const wrapper = SCHEDULE_RUN_WRAPPER.replace(
				"[ -r /dev/fd/3 ]",
				"[ -r /dev/fd/no-such-fd ]",
			);
			expect(wrapper).not.toBe(SCHEDULE_RUN_WRAPPER);

			const run = spawnSync("sh", ["-c", wrapper, "sh"], {
				input: `echo "ran ${secret}"\nexit 4`,
				encoding: "utf8",
			});

			expect(run.status).toBe(4);
			expect(run.stdout).toContain(`ran ${secret}\n`);
			expect(run.stderr).toContain(FALLBACK_LINE);
			expect(run.stderr).not.toContain(secret);
		});

		it("prints no fallback line when the command runs from the file", () => {
			const run = runWrapper("sh", "exit 0");

			expect(run.status).toBe(0);
			expect(run.stderr).not.toContain(FALLBACK_LINE);
		});

		it.each([
			["bash", ["-C"]],
			["bash", ["-o", "noclobber"]],
		])(
			"%s %j: stages through the file even when the shell inherited noclobber",
			(shell, flags) => {
				if (spawnSync(shell, ["-c", "true"]).error) return;
				const tmp = mkdtempSync(join(tmpdir(), "schedule-wrapper-"));
				try {
					const run = spawnSync(
						shell,
						[...flags, "-c", SCHEDULE_RUN_WRAPPER, shell],
						{
							input: 'echo "ran from $0"\nexit 6',
							encoding: "utf8",
							env: { ...process.env, TMPDIR: tmp },
						},
					);

					expect(run.status).toBe(6);
					expect(run.stdout).toContain("ran from /dev/fd/3\n");
					expect(run.stderr).not.toContain(FALLBACK_LINE);
					expect(readdirSync(tmp)).toEqual([]);
				} finally {
					rmSync(tmp, { recursive: true, force: true });
				}
			},
		);

		it("stages through the pid named file when mktemp fails", () => {
			const bin = mkdtempSync(join(tmpdir(), "schedule-bin-"));
			const tmp = mkdtempSync(join(tmpdir(), "schedule-tmp-"));
			try {
				// A mktemp that fails, so the pid named file is used.
				writeFileSync(join(bin, "mktemp"), "#!/bin/sh\nexit 1\n", {
					mode: 0o755,
				});
				const run = runWrapper("sh", "exit 2", {
					TMPDIR: tmp,
					PATH: `${bin}:${process.env.PATH}`,
				});

				expect(run.status).toBe(2);
				expect(run.stderr).not.toContain(FALLBACK_LINE);
				expect(readdirSync(tmp)).toEqual([]);
			} finally {
				rmSync(bin, { recursive: true, force: true });
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		describe("sweep of leftover run files", () => {
			const setup = () => {
				const tmp = mkdtempSync(join(tmpdir(), "schedule-sweep-"));
				const old = new Date(Date.now() - 2 * 60 * 60_000);
				const oldRun = join(tmp, ".dokploy-schedule-AbCdEf");
				const oldOther = join(tmp, "unrelated-old-file");
				const freshRun = join(tmp, ".dokploy-schedule-fresh1");
				for (const file of [oldRun, oldOther, freshRun]) {
					writeFileSync(file, "echo left");
				}
				utimesSync(oldRun, old, old);
				utimesSync(oldOther, old, old);
				return { tmp, oldRun, oldOther, freshRun };
			};

			it.each(["sh", "bash"])(
				"%s: removes run files older than an hour and nothing else, silently",
				(shell) => {
					if (spawnSync(shell, ["-c", "true"]).error) return;
					const { tmp, oldRun, oldOther, freshRun } = setup();
					try {
						const run = runWrapper(shell, "exit 0", { TMPDIR: tmp });

						expect(run.status).toBe(0);
						expect(run.stderr).toBe("");
						expect(existsSync(oldRun)).toBe(false);
						expect(existsSync(oldOther)).toBe(true);
						expect(existsSync(freshRun)).toBe(true);
					} finally {
						rmSync(tmp, { recursive: true, force: true });
					}
				},
			);

			it("runs the command normally when there is no find", () => {
				const { tmp, oldRun } = setup();
				const bin = mkdtempSync(join(tmpdir(), "schedule-bin-"));
				try {
					// A PATH with the tools the wrapper needs, and no find.
					for (const tool of ["cat", "mktemp", "rm"]) {
						const found = spawnSync("sh", ["-c", `command -v ${tool}`], {
							encoding: "utf8",
						}).stdout.trim();
						if (found) symlinkSync(found, join(bin, tool));
					}
					const sh = spawnSync("sh", ["-c", "command -v sh"], {
						encoding: "utf8",
					}).stdout.trim();
					const run = runWrapper(sh, "exit 4", { TMPDIR: tmp, PATH: bin });

					expect(run.status).toBe(4);
					expect(run.stderr).toBe("");
					expect(existsSync(oldRun)).toBe(true);
				} finally {
					rmSync(tmp, { recursive: true, force: true });
					rmSync(bin, { recursive: true, force: true });
				}
			});
		});

		it("closes fd 3 first, so the command does not inherit the script", () => {
			const run = runWrapper(
				"sh",
				'if [ -e /proc/$$/fd/3 ]; then echo "fd3 open"; else echo "fd3 closed"; fi',
			);

			expect(run.status).toBe(0);
			expect(run.stdout).toContain("fd3 closed\n");
			expect(run.stdout).not.toContain("fd3 open");
		});

		it("makes the first line of the run file close fd 3", () => {
			const run = runWrapper("sh", 'echo "$0"\nexit 0');

			expect(run.stdout.split("\n")[1]).toBe("/dev/fd/3");
			expect(SCHEDULE_RUN_WRAPPER).toContain(String.raw`printf 'exec 3<&-\n%s\n'`);
		});

		describe("temp file name", () => {
			const realMktemp = spawnSync("sh", ["-c", "command -v mktemp"], {
				encoding: "utf8",
			}).stdout?.trim() ?? "";

			it.skipIf(!realMktemp)(
				"uses mktemp for an unpredictable name",
				() => {
					const bin = mkdtempSync(join(tmpdir(), "schedule-bin-"));
					const tmp = mkdtempSync(join(tmpdir(), "schedule-tmp-"));
					try {
						const calls = join(bin, "calls");
						writeFileSync(
							join(bin, "mktemp"),
							`#!/bin/sh\necho "$@" >> '${calls}'\nexec '${realMktemp}' "$@"\n`,
							{ mode: 0o755 },
						);
						const run = runWrapper("sh", "exit 5", {
							TMPDIR: tmp,
							PATH: `${bin}:${process.env.PATH}`,
						});

						expect(run.status).toBe(5);
						expect(readFileSync(calls, "utf8")).toContain(
							`${tmp}/.dokploy-schedule-XXXXXX`,
						);
						expect(readdirSync(tmp)).toEqual([]);
					} finally {
						rmSync(bin, { recursive: true, force: true });
						rmSync(tmp, { recursive: true, force: true });
					}
				},
			);

			it("still runs from the file, under the pid based name, when there is no mktemp", () => {
				const bin = mkdtempSync(join(tmpdir(), "schedule-bin-"));
				const tmp = mkdtempSync(join(tmpdir(), "schedule-tmp-"));
				try {
					// A PATH with the tools the wrapper needs, and no mktemp.
					for (const tool of ["cat", "rm"]) {
						const found = spawnSync("sh", ["-c", `command -v ${tool}`], {
							encoding: "utf8",
						}).stdout.trim();
						symlinkSync(found, join(bin, tool));
					}
					const sh = spawnSync("sh", ["-c", "command -v sh"], {
						encoding: "utf8",
					}).stdout.trim();
					const run = spawnSync(sh, ["-c", SCHEDULE_RUN_WRAPPER, sh], {
						input: 'echo "ran $0"\nexit 6',
						encoding: "utf8",
						env: { ...process.env, PATH: bin, TMPDIR: tmp },
					});

					expect(run.status).toBe(6);
					expect(run.stdout).toContain("ran /dev/fd/3\n");
					expect(run.stderr).not.toContain("could not stage");
					expect(readdirSync(tmp)).toEqual([]);

				} finally {
					rmSync(bin, { recursive: true, force: true });
					rmSync(tmp, { recursive: true, force: true });
				}
			});
		});

		it("the kill script leaves a run with another tag alone", async () => {
			const run = spawn("sh", ["-c", SCHEDULE_RUN_WRAPPER, "sh"], {
				env: { ...process.env, DOKPLOY_SCHEDULE_RUN: `${RUN_ID}x` },
			});
			run.stdin.end("sleep 300");
			spawned.push(run.pid as number);
			await until(() => alive(run.pid as number));

			for (const id of [RUN_ID, "test"]) {
				const kill = spawnSync("sh", ["-c", SCHEDULE_KILL_SCRIPT, "sh", id]);
				expect(kill.status).toBe(0);
				// Nothing carries this tag: said apart from a kill that found the run.
				expect(kill.stdout.toString()).toContain(SCHEDULE_NONE_MARKER);
			}
			await new Promise((resolve) => setTimeout(resolve, 200));

			expect(alive(run.pid as number)).toBe(true);
		});
	},
);
