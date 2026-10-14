import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A cancel that comes in while a server / dokploy-server run is still being
 * set up (a slow ssh connect) must not be lost. The run records its launch
 * right before the command is handed over and looks at the cancel again at
 * that exact point, so the command never starts and the row stays cancelled.
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

import { decideRunWithoutProcess } from "@dokploy/server/utils/schedules/cancel";
import {
	forgetScheduleRunLaunch,
	getScheduleRunLaunch,
} from "@dokploy/server/utils/schedules/launch";
import { runCommand } from "@dokploy/server/utils/schedules/utils";

const remoteRun = (serverId: string | null) => ({
	scheduleId: "sch-1",
	name: "Nightly",
	scheduleType: "server",
	command: "",
	shellType: "bash",
	appName: "my-schedule",
	serviceName: null,
	serverId,
	compose: null,
	application: null,
});

beforeEach(() => {
	vi.clearAllMocks();
	forgetScheduleRunLaunch("dep-1");
	mocks.createDeploymentSchedule.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "run.log",
	});
	mocks.updateDeployment.mockResolvedValue(undefined);
	mocks.finishScheduleRun.mockResolvedValue("recorded");
	mocks.endScheduleRunCancelled.mockResolvedValue(undefined);
	mocks.isScheduleRunCancelled.mockReset();
	mocks.isScheduleRunCancelled.mockResolvedValue(false);
	mocks.appendFile.mockResolvedValue(undefined);
	mocks.findScheduleOrganizationId.mockResolvedValue("org-1");
	mocks.createWriteStream.mockReturnValue({
		write: vi.fn(),
		end: vi.fn(),
		writable: true,
	});
});

describe("a server run cancelled during a slow connect", () => {
	it("never sends its command: the launch point sees the cancel and the row ends cancelled", async () => {
		mocks.findScheduleById.mockResolvedValue(remoteRun("srv-1"));
		let release: () => void = () => {};
		const connected = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sent = vi.fn();
		mocks.execAsyncRemote.mockImplementation(
			async (
				_serverId: string,
				command: string,
				_onData: unknown,
				options?: { beforeExec?: () => Promise<void> },
			) => {
				// The ssh connect takes its time; the channel is then ready.
				await connected;
				await options?.beforeExec?.();
				if (command.includes("script.sh")) sent(command);
				return { stdout: "", stderr: "" };
			},
		);

		const run = runCommand("sch-1");
		await vi.waitFor(() => expect(mocks.execAsyncRemote).toHaveBeenCalled());
		// Not launched yet: nothing in the registry for a cancel to find.
		expect(getScheduleRunLaunch("dep-1")).toBeUndefined();

		// The user cancels, long after the run started, while it is connecting.
		mocks.isScheduleRunCancelled.mockResolvedValue(true);
		release();

		await expect(run).resolves.toMatchObject({ status: "cancelled" });
		expect(sent).not.toHaveBeenCalled();
		expect(mocks.endScheduleRunCancelled).toHaveBeenCalledWith("dep-1");
		expect(mocks.sendScheduleFailureNotifications).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).toHaveBeenLastCalledWith(
			"srv-1",
			expect.stringContaining("Run cancelled by user"),
		);
	});

	it("marks the run as checking while it looks at the cancel, and as launched once that passed", async () => {
		mocks.findScheduleById.mockResolvedValue(remoteRun("srv-1"));
		const seenAtCheck: Array<ReturnType<typeof getScheduleRunLaunch>> = [];
		mocks.isScheduleRunCancelled.mockImplementation(async () => {
			seenAtCheck.push(getScheduleRunLaunch("dep-1"));
			return false;
		});
		mocks.execAsyncRemote.mockImplementation(
			async (
				_serverId: string,
				_command: string,
				_onData: unknown,
				options?: { beforeExec?: () => Promise<void> },
			) => {
				await options?.beforeExec?.();
				return { stdout: "", stderr: "" };
			},
		);

		await runCommand("sch-1");

		// The early check precedes the launch point; the launch point's own look
		// happens while the run is marked as checking.
		expect(seenAtCheck[0]).toBeUndefined();
		expect(seenAtCheck.at(-1)).toEqual({ state: "checking" });
		expect(getScheduleRunLaunch("dep-1")).toBeUndefined();
	});

	it("is already launched when the command is handed over", async () => {
		mocks.findScheduleById.mockResolvedValue(remoteRun("srv-1"));
		let atHandoff: ReturnType<typeof getScheduleRunLaunch>;
		mocks.execAsyncRemote.mockImplementation(
			async (
				_serverId: string,
				command: string,
				_onData: unknown,
				options?: { beforeExec?: () => Promise<void> },
			) => {
				await options?.beforeExec?.();
				if (command.includes("script.sh")) {
					atHandoff = getScheduleRunLaunch("dep-1");
				}
				return { stdout: "", stderr: "" };
			},
		);

		await runCommand("sch-1");

		expect(atHandoff).toEqual({ state: "launched", at: expect.any(Number) });
	});

	it("a cancel that arrives while the last look stalls for more than 10 s never ends the run behind the command's back", async () => {
		vi.useFakeTimers();
		try {
			mocks.findScheduleById.mockResolvedValue(remoteRun("srv-1"));
			let releaseCheck: (cancelled: boolean) => void = () => {};
			let checks = 0;
			mocks.isScheduleRunCancelled.mockImplementation(() => {
				checks++;
				// The early check answers at once; the launch point's stalls.
				if (checks === 1) return Promise.resolve(false);
				return new Promise<boolean>((resolve) => {
					releaseCheck = resolve;
				});
			});
			const sent = vi.fn();
			mocks.execAsyncRemote.mockImplementation(
				async (
					_serverId: string,
					command: string,
					_onData: unknown,
					options?: { beforeExec?: () => Promise<void> },
				) => {
					await options?.beforeExec?.();
					if (command.includes("script.sh")) sent(command);
					return { stdout: "", stderr: "" };
				},
			);

			const run = runCommand("sch-1");
			await vi.advanceTimersByTimeAsync(0);
			expect(getScheduleRunLaunch("dep-1")).toEqual({ state: "checking" });

			// A cancel comes in and finds no process, well after 10 s of stalling:
			// the run is still undecided, which is not "launched long ago".
			await vi.advanceTimersByTimeAsync(30_000);
			expect(
				decideRunWithoutProcess({
					launch: getScheduleRunLaunch("dep-1"),
					startedAt: new Date(Date.now() - 30_000).toISOString(),
				}),
			).toBe("retry");
			expect(sent).not.toHaveBeenCalled();

			// The look finally answers: the claim was committed, so it says cancelled.
			releaseCheck(true);
			await expect(run).resolves.toMatchObject({ status: "cancelled" });
			expect(sent).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("forgets the launch when the run is over", async () => {
		mocks.findScheduleById.mockResolvedValue(remoteRun("srv-1"));
		mocks.execAsyncRemote.mockImplementation(
			async (
				_serverId: string,
				_command: string,
				_onData: unknown,
				options?: { beforeExec?: () => Promise<void> },
			) => {
				await options?.beforeExec?.();
				expect(getScheduleRunLaunch("dep-1")).toMatchObject({
					state: "launched",
				});
				return { stdout: "", stderr: "" };
			},
		);

		await runCommand("sch-1");

		expect(getScheduleRunLaunch("dep-1")).toBeUndefined();
	});

	it("also forgets it when the run fails", async () => {
		mocks.findScheduleById.mockResolvedValue(remoteRun("srv-1"));
		mocks.execAsyncRemote.mockImplementation(
			async (
				_serverId: string,
				_command: string,
				_onData: unknown,
				options?: { beforeExec?: () => Promise<void> },
			) => {
				await options?.beforeExec?.();
				throw new Error("exit 1");
			},
		);
		mocks.getDokployUrl.mockResolvedValue("https://dokploy.test");

		await runCommand("sch-1");

		expect(getScheduleRunLaunch("dep-1")).toBeUndefined();
	});
});

describe("a dokploy-server run cancelled before the spawn", () => {
	it("records its launch right before the local spawn and never spawns when cancelled by then", async () => {
		mocks.findScheduleById.mockResolvedValue({
			...remoteRun(null),
			scheduleType: "dokploy-server",
		});
		mocks.isScheduleRunCancelled.mockResolvedValue(true);

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "cancelled",
		});

		expect(mocks.spawnAsync).not.toHaveBeenCalled();
	});

	it("spawns once the launch point lets it through, with the launch on record", async () => {
		mocks.findScheduleById.mockResolvedValue({
			...remoteRun(null),
			scheduleType: "dokploy-server",
		});
		mocks.spawnAsync.mockImplementation(async () => {
			expect(getScheduleRunLaunch("dep-1")).toMatchObject({
				state: "launched",
			});
			return {};
		});

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "done",
		});
		expect(mocks.spawnAsync).toHaveBeenCalledTimes(1);
	});
});
