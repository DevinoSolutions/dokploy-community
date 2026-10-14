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
	endScheduleRunCancelled: vi.fn(),
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
	endScheduleRunCancelled: mocks.endScheduleRunCancelled,
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

// The run is cancelled while it executes (it was not yet when it was about to
// start): finishing it is refused.
const cancelledMeanwhile = () => {
	mocks.finishScheduleRun.mockResolvedValue("cancelled");
	mocks.isScheduleRunCancelled
		.mockResolvedValueOnce(false)
		.mockResolvedValue(true);
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
	mocks.endScheduleRunCancelled.mockResolvedValue(undefined);
	// Also drops the answers a test queued and did not use.
	mocks.isScheduleRunCancelled.mockReset();
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
			mocks.findScheduleById.mockResolvedValue(
				schedule(scheduleType, serverId),
			);
			(where === "remote"
				? mocks.execAsyncRemote
				: mocks.spawnAsync
			).mockRejectedValue(killed());
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

	it.each([
		["server", "srv-1"],
		["dokploy-server", null],
	] as const)(
		"a %s run cancelled before its script started never starts it",
		async (scheduleType, serverId) => {
			mocks.findScheduleById.mockResolvedValue(
				schedule(scheduleType, serverId),
			);
			mocks.isScheduleRunCancelled.mockResolvedValue(true);

			await expect(runCommand("sch-1")).resolves.toMatchObject({
				status: "cancelled",
			});

			expect(mocks.spawnAsync).not.toHaveBeenCalled();
			expect(mocks.execAsyncRemote).not.toHaveBeenCalledWith(
				"srv-1",
				expect.stringContaining("script.sh"),
				expect.anything(),
			);
			expect(mocks.endScheduleRunCancelled).toHaveBeenCalledWith("dep-1");
			expect(mocks.sendScheduleFailureNotifications).not.toHaveBeenCalled();
		},
	);

	it("tags a dokploy-server run with its id, so a cancel can find it without a pid", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("dokploy-server", null));
		mocks.spawnAsync.mockResolvedValue({});

		await runCommand("sch-1");

		expect(mocks.spawnAsync).toHaveBeenCalledWith(
			"bash",
			["-c", "./script.sh"],
			expect.any(Function),
			expect.objectContaining({
				env: expect.objectContaining({ DOKPLOY_SCHEDULE_RUN: "dep-1" }),
			}),
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
			mocks.findScheduleById.mockResolvedValue(
				schedule(scheduleType, serverId),
			);
			(where === "remote"
				? mocks.execAsyncRemote
				: mocks.spawnAsync
			).mockResolvedValue({ stdout: "", stderr: "" });
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
			mocks.findScheduleById.mockResolvedValue(
				schedule(scheduleType, serverId),
			);
			(where === "remote"
				? mocks.execAsyncRemote
				: mocks.spawnAsync
			).mockRejectedValue(new Error("exit 1"));

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
			mocks.findScheduleById.mockResolvedValue(
				schedule(scheduleType, serverId),
			);
			(where === "remote"
				? mocks.execAsyncRemote
				: mocks.spawnAsync
			).mockRejectedValue(new Error("exit 1"));
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

// The shell scripts of a remote application/compose run and of a server run
// leave the failure line to runCommand: only it knows if the non-zero exit is a
// failure or the kill of a cancel.
describe("the failure line of a remote run", () => {
	const FAILED_LINE = "❌ Command failed";
	const remoteCalls = () =>
		mocks.execAsyncRemote.mock.calls.map(
			(call) => [call[0], String(call[1])] as const,
		);
	const failedLineCalls = () =>
		remoteCalls().filter(([, command]) => command.includes(FAILED_LINE));

	it.each([
		["application", "application"],
		["compose", "compose"],
		["server", "server"],
	] as const)(
		"a %s run killed by a cancel has no failure line, only the cancel line",
		async (_label, scheduleType) => {
			mocks.findScheduleById.mockResolvedValue(schedule(scheduleType, "srv-1"));
			mocks.execAsyncRemote.mockRejectedValueOnce(killed());
			mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
			cancelledMeanwhile();

			await expect(runCommand("sch-1")).resolves.toMatchObject({
				status: "cancelled",
			});

			expect(failedLineCalls()).toEqual([]);
			expect(remoteCalls()).toHaveLength(2);
			expect(remoteCalls()[1]).toEqual([
				"srv-1",
				expect.stringContaining(CANCEL_LINE),
			]);
		},
	);

	it.each([
		["application", "application"],
		["compose", "compose"],
		["server", "server"],
	] as const)(
		"a %s run that really fails still gets the failure line, once, on its server",
		async (_label, scheduleType) => {
			mocks.findScheduleById.mockResolvedValue(schedule(scheduleType, "srv-1"));
			mocks.execAsyncRemote.mockRejectedValueOnce(new Error("exit 1"));
			mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

			await expect(runCommand("sch-1")).resolves.toMatchObject({
				status: "error",
			});

			expect(failedLineCalls()).toHaveLength(1);
			const [serverId, command] = failedLineCalls()[0] as readonly [
				string,
				string,
			];
			expect(serverId).toBe("srv-1");
			// Quoted for the shell, appended to the log of the run.
			expect(command).toMatch(/^echo .*Command failed.* >> run\.log$/);
			expect(failedLineCalls()[0]).toEqual(remoteCalls().at(-1));
			expect(logged()).not.toContain(CANCEL_LINE);
			expect(mocks.sendScheduleFailureNotifications).toHaveBeenCalledTimes(1);
		},
	);

	it("a failing run whose row is gone still gets the failure line", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("server", "srv-1"));
		mocks.execAsyncRemote.mockRejectedValueOnce(new Error("exit 1"));
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.finishScheduleRun.mockResolvedValue("missing");

		await runCommand("sch-1");

		expect(failedLineCalls()).toHaveLength(1);
	});

	it("a run that succeeds gets neither line", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("application", "srv-1"));
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

		await runCommand("sch-1");

		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		expect(failedLineCalls()).toEqual([]);
	});

	it("a run that succeeded but could not be recorded gets no failure line", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("server", "srv-1"));
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.finishScheduleRun.mockRejectedValueOnce(new Error("db down"));
		mocks.finishScheduleRun.mockResolvedValue("recorded");

		await runCommand("sch-1");

		expect(failedLineCalls()).toEqual([]);
	});

	it("a missing container keeps its own line and gets no second one", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("application", "srv-1"));
		mocks.getServiceContainer.mockResolvedValue(null);
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "error",
		});

		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		expect(remoteCalls()[0]?.[1]).toContain("Container not found");
		expect(failedLineCalls()).toEqual([]);
	});

	it("does not lose the real failure when the failure line cannot be written", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("server", "srv-1"));
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh down"));
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "error",
		});

		expect(mocks.sendScheduleFailureNotifications).toHaveBeenCalledTimes(1);
		consoleErrorSpy.mockRestore();
	});
});

// A cancel that is accepted before `docker exec` starts finds nothing to kill,
// so the run must not go on to start the command.
describe("a run cancelled before its command starts", () => {
	const cancelledBeforeStart = () => {
		mocks.finishScheduleRun.mockResolvedValue("cancelled");
		mocks.isScheduleRunCancelled.mockResolvedValue(true);
	};

	it.each([
		["application", "application"],
		["compose", "compose"],
	] as const)(
		"a %s run on a remote server never runs the command and ends cancelled",
		async (_label, scheduleType) => {
			mocks.findScheduleById.mockResolvedValue(schedule(scheduleType, "srv-1"));
			mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
			cancelledBeforeStart();

			await expect(runCommand("sch-1")).resolves.toMatchObject({
				status: "cancelled",
			});

			// Only the cancel line was sent: no script, so no `docker exec`.
			expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
			expect(String(mocks.execAsyncRemote.mock.calls[0]?.[1])).toContain(
				CANCEL_LINE,
			);
			expect(logged()).not.toContain("docker exec");
			expect(logged()).not.toContain("Command failed");
			expect(mocks.endScheduleRunCancelled).toHaveBeenCalledWith("dep-1");
			expect(mocks.finishScheduleRun).not.toHaveBeenCalled();
			expect(mocks.sendScheduleFailureNotifications).not.toHaveBeenCalled();
		},
	);

	it("an application run on the Dokploy host never runs the command and ends cancelled", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("application", null));
		cancelledBeforeStart();

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "cancelled",
		});

		expect(mocks.spawnAsync).not.toHaveBeenCalled();
		expect(logged()).toContain(CANCEL_LINE);
		expect(logged()).not.toContain("docker exec");
		expect(logged()).not.toContain("Command failed");
		expect(mocks.sendScheduleFailureNotifications).not.toHaveBeenCalled();
	});

	it("starts the command when the run is not cancelled", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("application", "srv-1"));
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "done",
		});

		expect(String(mocks.execAsyncRemote.mock.calls[0]?.[1])).toContain(
			"docker exec",
		);
	});
});

// The end of a failed run is recorded, logged and notified in that order, and
// a status that cannot be written hides none of it.
describe("a run cancelled before it started, whose cancel was undone meanwhile", () => {
	// The kill found nothing and reverted the claim before the run looked at its
	// row again: it reads as running at the end, but it never started.
	const revertedMeanwhile = () => {
		mocks.isScheduleRunCancelled
			.mockResolvedValueOnce(true)
			.mockResolvedValue(false);
		mocks.finishScheduleRun.mockResolvedValue("recorded");
	};

	it.each([
		["application on a remote server", "application", "srv-1"],
		["compose on a remote server", "compose", "srv-1"],
		["application on the Dokploy host", "application", null],
	] as const)(
		"%s ends cancelled, with the cancel line and no failure alert",
		async (_label, scheduleType, serverId) => {
			mocks.findScheduleById.mockResolvedValue(
				schedule(scheduleType, serverId),
			);
			mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
			revertedMeanwhile();

			await expect(runCommand("sch-1")).resolves.toMatchObject({
				status: "cancelled",
			});

			expect(mocks.endScheduleRunCancelled).toHaveBeenCalledWith("dep-1");
			expect(mocks.finishScheduleRun).not.toHaveBeenCalled();
			expect(mocks.sendScheduleFailureNotifications).not.toHaveBeenCalled();
			expect(mocks.findScheduleOrganizationId).not.toHaveBeenCalled();
			expect(mocks.spawnAsync).not.toHaveBeenCalled();
			expect(logged()).toContain(CANCEL_LINE);
			expect(logged()).not.toContain("Command failed");
			expect(logged()).not.toContain("docker exec");
		},
	);

	it("still ends cancelled when the row cannot be updated", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("application", "srv-1"));
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		revertedMeanwhile();
		mocks.endScheduleRunCancelled.mockRejectedValue(new Error("db down"));
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "cancelled",
		});

		expect(mocks.sendScheduleFailureNotifications).not.toHaveBeenCalled();
		consoleErrorSpy.mockRestore();
	});
});

describe("the end of a failed run", () => {
	it("logs the failure line before the failure notification goes out", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("server", "srv-1"));
		mocks.execAsyncRemote.mockRejectedValueOnce(new Error("exit 1"));
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

		await runCommand("sch-1");

		const failedLine = mocks.execAsyncRemote.mock.calls.findIndex((call) =>
			String(call[1]).includes("Command failed"),
		);
		expect(failedLine).toBeGreaterThan(-1);
		expect(
			mocks.execAsyncRemote.mock.invocationCallOrder[failedLine],
		).toBeLessThan(
			mocks.sendScheduleFailureNotifications.mock
				.invocationCallOrder[0] as number,
		);
	});

	it.each([
		["server", "server", "srv-1", "remote"],
		["application", "application", "srv-1", "remote"],
		["dokploy-server", "dokploy-server", null, "local"],
	] as const)(
		"a failing %s run whose status cannot be written is still logged and notified, with its own error",
		async (_label, scheduleType, serverId, where) => {
			mocks.findScheduleById.mockResolvedValue(
				schedule(scheduleType, serverId),
			);
			if (where === "remote") {
				mocks.execAsyncRemote.mockRejectedValueOnce(new Error("exit 1"));
				mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
			} else {
				mocks.spawnAsync.mockRejectedValue(new Error("exit 1"));
			}
			mocks.finishScheduleRun.mockRejectedValue(new Error("db down"));
			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);

			await expect(runCommand("sch-1")).resolves.toMatchObject({
				status: "error",
			});

			expect(mocks.sendScheduleFailureNotifications).toHaveBeenCalledTimes(1);
			expect(mocks.sendScheduleFailureNotifications).toHaveBeenCalledWith(
				expect.objectContaining({ errorMessage: "exit 1" }),
			);
			if (where === "remote") {
				expect(logged()).toContain("Command failed");
			}
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("dep-1"),
				expect.objectContaining({ message: "db down" }),
			);
			consoleErrorSpy.mockRestore();
		},
	);

	it("a failing run is still logged and notified when the status write fails after the failure line", async () => {
		mocks.findScheduleById.mockResolvedValue(schedule("server", "srv-1"));
		mocks.execAsyncRemote.mockRejectedValueOnce(new Error("exit 1"));
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.finishScheduleRun.mockRejectedValue(new Error("db down"));
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await runCommand("sch-1");

		// Not the DB error: the line of the command that failed.
		expect(
			mocks.execAsyncRemote.mock.calls.filter((call) =>
				String(call[1]).includes("Command failed"),
			),
		).toHaveLength(1);
		consoleErrorSpy.mockRestore();
	});
});
