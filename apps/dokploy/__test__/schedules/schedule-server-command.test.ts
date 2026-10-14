import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * The script of a server schedule runs on the server through a command built
 * from the schedule's app name and the run's log path. Both must reach the
 * shell as single literal arguments.
 */

const mocks = vi.hoisted(() => ({
	root: "",
	findScheduleById: vi.fn(),
	findScheduleOrganizationId: vi.fn(),
	createDeploymentSchedule: vi.fn(),
	updateDeployment: vi.fn(),
	finishScheduleRun: vi.fn(async () => "recorded"),
	getDokployUrl: vi.fn(),
	getServiceContainer: vi.fn(),
	getComposeContainer: vi.fn(),
	spawnAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	sendScheduleFailureNotifications: vi.fn(),
	scheduleJobNode: vi.fn(),
}));

// Commands run in bash, so the code under test must join paths with forward
// slashes even when the suite runs on Windows.
vi.mock("node:path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:path")>();
	return { ...actual.posix, default: actual.posix };
});

vi.mock("@dokploy/server/constants", () => ({
	IS_CLOUD: false,
	paths: () => ({ SCHEDULES_PATH: `${mocks.root}/schedules` }),
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

vi.mock("node-schedule", () => ({
	scheduleJob: mocks.scheduleJobNode,
	scheduledJobs: {},
}));

import { runCommand } from "@dokploy/server/utils/schedules/utils";

// Git Bash on Windows wants /c/Users/... instead of C:\Users\...
const toPosix = (value: string) =>
	value
		.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
		.split(String.fromCharCode(92))
		.join("/");

const root = mkdtempSync(path.join(tmpdir(), "dokploy-schedule-inject-"));
mocks.root = toPosix(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("server schedule command", () => {
	it("runs the script and logs to a hostile log path without evaluating it", async () => {
		const appName = "schedule-hack-open-source-bus-AbC123";
		mkdirSync(path.join(root, "schedules", appName), { recursive: true });
		mkdirSync(path.join(root, "logs"), { recursive: true });
		const scriptFile = path.join(root, "schedules", appName, "script.sh");
		writeFileSync(scriptFile, "#!/bin/bash\necho script-ran\n");
		chmodSync(scriptFile, 0o755);
		const logName = "a$(touch pwned)`touch pwned`;touch pwned.log";
		const logPath = `${mocks.root}/logs/${logName}`;

		mocks.findScheduleById.mockResolvedValue({
			scheduleId: "sch-1",
			name: "Server task",
			scheduleType: "server",
			command: "",
			shellType: "bash",
			appName,
			serviceName: null,
			serverId: "server-1",
			application: null,
			compose: null,
		});
		mocks.createDeploymentSchedule.mockResolvedValue({
			deploymentId: "dep-1",
			logPath,
		});
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

		await runCommand("sch-1");

		const command = mocks.execAsyncRemote.mock.calls[0]?.[1] as string;
		expect(command).toBeTypeOf("string");
		execFileSync("bash", ["-c", command], { cwd: root, stdio: "ignore" });

		// The run is tagged so a cancel can find it when it never prints a pid.
		expect(command).toContain("export DOKPLOY_SCHEDULE_RUN=dep-1");
		expect(existsSync(path.join(root, "pwned"))).toBe(false);
		const log = readFileSync(path.join(root, "logs", logName), "utf8");
		expect(log).toContain("Running script");
		expect(log).toContain("script-ran");
		expect(log).toContain("Command executed successfully");
	}, 30_000);

	it("leaves the failure line to runCommand: the script of a failing run exits 1 without logging it", async () => {
		const appName = "schedule-failing-AbC123";
		mkdirSync(path.join(root, "schedules", appName), { recursive: true });
		const scriptFile = path.join(root, "schedules", appName, "script.sh");
		writeFileSync(scriptFile, "#!/bin/bash\necho before-failure\nexit 3\n");
		chmodSync(scriptFile, 0o755);
		const logPath = `${mocks.root}/failing.log`;

		mocks.findScheduleById.mockResolvedValue({
			scheduleId: "sch-1",
			name: "Server task",
			scheduleType: "server",
			command: "",
			shellType: "bash",
			appName,
			serviceName: null,
			serverId: "server-1",
			application: null,
			compose: null,
		});
		mocks.createDeploymentSchedule.mockResolvedValue({
			deploymentId: "dep-2",
			logPath,
		});
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

		await runCommand("sch-1");

		const command = mocks.execAsyncRemote.mock.calls.at(-1)?.[1] as string;
		expect(() =>
			execFileSync("bash", ["-c", command], { cwd: root, stdio: "ignore" }),
		).toThrow();

		const log = readFileSync(path.join(root, "failing.log"), "utf8");
		expect(log).toContain("before-failure");
		expect(log).not.toContain("Command failed");
		expect(log).not.toContain("Command executed successfully");
	}, 30_000);
});
