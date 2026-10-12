import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A schedule run that a user cancelled (`deployment.killProcess`, see
 * schedule-kill-process.test.ts) ends with a failing exit status, since its
 * process was killed. That is not a failure: the run stays `cancelled` and no
 * failure notification goes out. `finishScheduleRun` is the conditional update
 * that records how a run ended and reports false for a cancelled row.
 */

const mocks = vi.hoisted(() => ({
	findScheduleById: vi.fn(),
	findScheduleOrganizationId: vi.fn(),
	createDeploymentSchedule: vi.fn(),
	updateDeployment: vi.fn(),
	finishScheduleRun: vi.fn(),
	isScheduleRunCancelled: vi.fn(),
	appendFile: vi.fn(),
	getDokployUrl: vi.fn(),
	getServiceContainer: vi.fn(),
	getComposeContainer: vi.fn(),
	spawnAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	sendScheduleFailureNotifications: vi.fn(),
	createWriteStream: vi.fn(),
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

vi.mock("@dokploy/server/utils/schedules/run-status", () => ({
	finishScheduleRun: mocks.finishScheduleRun,
	isScheduleRunCancelled: mocks.isScheduleRunCancelled,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	appendFile: mocks.appendFile,
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

import { runCommand } from "@dokploy/server/utils/schedules/utils";

const schedule = (
	scheduleType: "application" | "compose" | "server" | "dokploy-server",
	serverId: string | null,
) => ({
	scheduleId: "sch-1",
	name: "Nightly",
	scheduleType,
	command: "sleep 600",
	shellType: "bash",
	appName: "my-schedule",
	serviceName: scheduleType === "compose" ? "web" : null,
	serverId: scheduleType === "server" ? serverId : null,
	compose:
		scheduleType === "compose"
			? {
					appName: "my-compose",
					composeType: "docker-compose",
					serverId,
					environment: { project: { name: "Project" } },
				}
			: null,
	application:
		scheduleType === "application"
			? {
					appName: "my-app",
					serverId,
					environment: { project: { name: "Project" } },
				}
			: null,
});

const logWrite = vi.fn();

const killed = () =>
	Object.assign(new Error("Remote command failed with exit code 137"), {
		exitCode: 137,
	});

// The run is cancelled while it executes: finishing it is refused.
const cancelledMeanwhile = () => {
	mocks.finishScheduleRun.mockResolvedValue("cancelled");
	mocks.isScheduleRunCancelled.mockResolvedValue(true);
};

const CANCEL_LINE = "Run cancelled by user";
// What was written to the log of the run, wherever it lives.
const logged = () =>
	[
		...mocks.appendFile.mock.calls.map((call) => String(call[1])),
		...mocks.execAsyncRemote.mock.calls.map((call) => String(call[1])),
		...logWrite.mock.calls.map((call) => String(call[0])),
	].join("\n");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createDeploymentSchedule.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "run.log",
	});
	mocks.updateDeployment.mockResolvedValue(undefined);
	mocks.finishScheduleRun.mockResolvedValue("recorded");
	mocks.isScheduleRunCancelled.mockResolvedValue(false);
	mocks.appendFile.mockResolvedValue(undefined);
	mocks.findScheduleOrganizationId.mockResolvedValue("org-1");
	mocks.getDokployUrl.mockResolvedValue("https://dokploy.test");
	mocks.sendScheduleFailureNotifications.mockResolvedValue(undefined);
	mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });
	mocks.getComposeContainer.mockResolvedValue({ Id: "cont-2" });
	mocks.createWriteStream.mockReturnValue({
		write: logWrite,
		end: vi.fn(),
		writable: true,
	});
});

describe("a schedule run that was killed by a user cancel", () => {
	it.each([
		["application on a remote server", "application", "srv-1", "remote"],
		["application on the Dokploy host", "application", null, "local"],
		["compose on a remote server", "compose", "srv-1", "remote"],
		["compose on the Dokploy host", "compose", null, "local"],
		["server", "server", "srv-1", "remote"],
		["dokploy-server", "dokploy-server", null, "local"],
	] as const)(
		"%s stays cancelled and sends no failure notification",
		async (_label, scheduleType, serverId, where) => {
			mocks.findScheduleById.mockResolvedValue(schedule(scheduleType, serverId));
			(where === "remote" ? mocks.execAsyncRemote : mocks.spawnAsync)
				.mockRejectedValue(killed());
			cancelledMeanwhile();

			await expect(runCommand("sch-1")).resolves.toMatchObject({
				deploymentId: "dep-1",
				status: "cancelled",
			});

			expect(mocks.finishScheduleRun).toHaveBeenCalledTimes(1);
			expect(mocks.finishScheduleRun).toHaveBeenCalledWith("dep-1", "error");
			expect(mocks.sendScheduleFailureNotifications).not.toHaveBeenCalled();
			expect(mocks.findScheduleOrganizationId).not.toHaveBeenCalled();
		},
	);

	it("logs that the run was cancelled, with no failure text, for an application on the Dokploy host", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("application", null));
		mocks.spawnAsync.mockRejectedValue(killed());
		cancelledMeanwhile();

		await runCommand("sch-1");

		expect(logged()).toContain(CANCEL_LINE);
		expect(logged()).not.toContain("Command failed");
		expect(logged()).not.toContain("exit code 137");
		expect(mocks.appendFile).toHaveBeenCalledWith(
			"run.log",
			expect.stringContaining(CANCEL_LINE),
		);
	});

	it("logs it on the server the run lives on", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("server", "srv-1"));
		mocks.execAsyncRemote.mockRejectedValueOnce(killed());
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		cancelledMeanwhile();

		await runCommand("sch-1");

		expect(mocks.execAsyncRemote).toHaveBeenLastCalledWith(
			"srv-1",
			expect.stringContaining(CANCEL_LINE),
		);
		expect(mocks.appendFile).not.toHaveBeenCalled();
	});

	it("still ends the run cancelled when the log cannot be written", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("dokploy-server", null));
		mocks.spawnAsync.mockRejectedValue(killed());
		mocks.appendFile.mockRejectedValue(new Error("disk full"));
		cancelledMeanwhile();
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "cancelled",
		});

		consoleErrorSpy.mockRestore();
	});

	it.each([
		["application", "application", "srv-1", "remote"],
		["server", "server", "srv-1", "remote"],
		["dokploy-server", "dokploy-server", null, "local"],
	] as const)(
		"a %s command that traps the signal and exits 0 does not overwrite cancelled",
		async (_label, scheduleType, serverId, where) => {
			mocks.findScheduleById.mockResolvedValue(schedule(scheduleType, serverId));
			(where === "remote" ? mocks.execAsyncRemote : mocks.spawnAsync)
				.mockResolvedValue({ stdout: "", stderr: "" });
			cancelledMeanwhile();

			await expect(runCommand("sch-1")).resolves.toMatchObject({
				status: "cancelled",
			});

			expect(mocks.finishScheduleRun).toHaveBeenCalledTimes(1);
			expect(mocks.finishScheduleRun).toHaveBeenCalledWith("dep-1", "done");
			expect(mocks.sendScheduleFailureNotifications).not.toHaveBeenCalled();
		},
	);
});

describe("a schedule run that was not cancelled", () => {
	it.each([
		["application", "application", "srv-1", "remote"],
		["server", "server", "srv-1", "remote"],
		["dokploy-server", "dokploy-server", null, "local"],
	] as const)(
		"a failing %s run still ends as error and notifies",
		async (_label, scheduleType, serverId, where) => {
			mocks.findScheduleById.mockResolvedValue(schedule(scheduleType, serverId));
			(where === "remote" ? mocks.execAsyncRemote : mocks.spawnAsync)
				.mockRejectedValue(new Error("exit 1"));

			await expect(runCommand("sch-1")).resolves.toMatchObject({
				status: "error",
			});

			expect(mocks.finishScheduleRun).toHaveBeenCalledWith("dep-1", "error");
			expect(mocks.finishScheduleRun).not.toHaveBeenCalledWith("dep-1", "done");
			expect(mocks.sendScheduleFailureNotifications).toHaveBeenCalledTimes(1);
			expect(mocks.sendScheduleFailureNotifications).toHaveBeenCalledWith(
				expect.objectContaining({
					scheduleName: "Nightly",
					scheduleType,
					errorMessage: "exit 1",
				}),
			);
		},
	);

	it.each([
		["application", "application", "srv-1", "remote"],
		["server", "server", "srv-1", "remote"],
		["dokploy-server", "dokploy-server", null, "local"],
	] as const)(
		"a failing %s run whose row is gone still notifies, it was not cancelled",
		async (_label, scheduleType, serverId, where) => {
			mocks.findScheduleById.mockResolvedValue(schedule(scheduleType, serverId));
			(where === "remote" ? mocks.execAsyncRemote : mocks.spawnAsync)
				.mockRejectedValue(new Error("exit 1"));
			mocks.finishScheduleRun.mockResolvedValue("missing");

			await expect(runCommand("sch-1")).resolves.toMatchObject({
				status: "error",
			});

			expect(mocks.sendScheduleFailureNotifications).toHaveBeenCalledTimes(1);
			expect(logged()).not.toContain(CANCEL_LINE);
		},
	);

	it("a successful run whose row is gone is reported done", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("application", "srv-1"));
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.finishScheduleRun.mockResolvedValue("missing");

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "done",
		});
		expect(logged()).not.toContain(CANCEL_LINE);
	});

	it("still writes the failure text to the log of a local application run that failed", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("application", null));
		mocks.spawnAsync.mockRejectedValue(new Error("exit 1"));

		await runCommand("sch-1");

		expect(logged()).toContain("Command failed");
		expect(logged()).toContain("exit 1");
		expect(mocks.appendFile).not.toHaveBeenCalled();
	});

	it("still ends a successful run as done", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("application", "srv-1"));
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "done",
		});

		expect(mocks.finishScheduleRun).toHaveBeenCalledWith("dep-1", "done");
		expect(mocks.sendScheduleFailureNotifications).not.toHaveBeenCalled();
	});

	it("still notifies for a missing container", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("application", "srv-1"));
		mocks.getServiceContainer.mockResolvedValue(null);
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "error",
		});

		expect(mocks.finishScheduleRun).toHaveBeenCalledWith("dep-1", "error");
		expect(mocks.sendScheduleFailureNotifications).toHaveBeenCalledTimes(1);
	});
});
