import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
	updateDeploymentStatus: vi.fn(),
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
	updateDeploymentStatus: mocks.updateDeploymentStatus,
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
	SCHEDULE_RUN_WRAPPER,
} from "@dokploy/server/utils/schedules/container-run";
import { runCommand } from "@dokploy/server/utils/schedules/utils";

const MARKER = "__DOKPLOY_SCHEDULE_PID__";

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

// Runs a generated shell command with `docker` replaced by a function that
// prints its arguments, to see exactly what docker would be called with.
const dockerArgs = (command: string) => {
	const result = spawnSync(
		"bash",
		["-c", `docker() { printf '%s\\0' "$@"; }\n${command}`],
		{ encoding: "utf8" },
	);
	return result.stdout.split("\0").slice(0, -1);
};

const loggedOutput = () =>
	mocks.logWrite.mock.calls.map((call) => String(call[0])).join("");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createDeploymentSchedule.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "/dev/null",
	});
	mocks.updateDeploymentStatus.mockResolvedValue(undefined);
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
		expect(command).toContain("| tee -a /dev/null");
		expect(command).toContain("Command executed successfully");
		expect(options).toEqual({ streamOnly: true });
		// What docker receives once the shell has unquoted the command: the user
		// command is a positional argument of the wrapper, never part of it.
		expect(dockerArgs(command)).toEqual([
			"exec",
			"-e",
			"DOKPLOY_SCHEDULE_RUN=dep-1",
			"cont-1",
			"bash",
			"-c",
			SCHEDULE_RUN_WRAPPER,
			"bash",
			`echo "it's $HOME"`,
		]);
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
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
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

describe("runCommand pid capture on the Dokploy host", () => {
	it("passes the run tag to docker exec, records the pid and keeps the marker out of the log", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule(null));
		mocks.spawnAsync.mockImplementation(async (_cmd, _args, onData) => {
			onData(`${MARKER}=31\nhello\n`);
			onData("PID: 99\n");
			onData(`${MARKER}=8\n`);
		});

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "done",
		});

		expect(mocks.spawnAsync).toHaveBeenCalledWith(
			"docker",
			[
				"exec",
				"-e",
				"DOKPLOY_SCHEDULE_RUN=dep-1",
				"cont-1",
				"bash",
				"-c",
				SCHEDULE_RUN_WRAPPER,
				"bash",
				`echo "it's $HOME"`,
			],
			expect.any(Function),
		);
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
				const run = spawn(
					shell,
					[
						"-c",
						SCHEDULE_RUN_WRAPPER,
						shell,
						'sleep 300 & echo "CHILD=$!"; sleep 301 & echo "CHILD=$!"; echo "PID: 99"; wait',
					],
					{ env: { ...process.env, DOKPLOY_SCHEDULE_RUN: RUN_ID } },
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
				await exited;

				expect(
					await until(() =>
						[run.pid as number, ...children].every((p) => !alive(p)),
					),
				).toBe(true);
				expect(alive(unrelated.pid as number)).toBe(true);
			},
		);

		it("the kill script leaves a run with another tag alone", async () => {
			const run = spawn("sh", ["-c", SCHEDULE_RUN_WRAPPER, "sh", "sleep 300"], {
				env: { ...process.env, DOKPLOY_SCHEDULE_RUN: `${RUN_ID}x` },
			});
			spawned.push(run.pid as number);
			await until(() => alive(run.pid as number));

			for (const id of [RUN_ID, "test"]) {
				expect(
					spawnSync("sh", ["-c", SCHEDULE_KILL_SCRIPT, "sh", id]).status,
				).toBe(0);
			}
			await new Promise((resolve) => setTimeout(resolve, 200));

			expect(alive(run.pid as number)).toBe(true);
		});
	},
);
