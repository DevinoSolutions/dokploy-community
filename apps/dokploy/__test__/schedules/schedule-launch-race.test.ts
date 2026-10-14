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

import {
	forgetScheduleRunLaunch,
	getScheduleRunLaunchedAt,
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
		expect(getScheduleRunLaunchedAt("dep-1")).toBeUndefined();

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

	it("records the launch before it looks at the cancel", async () => {
		mocks.findScheduleById.mockResolvedValue(remoteRun("srv-1"));
		const seenAtCheck: Array<number | undefined> = [];
		mocks.isScheduleRunCancelled.mockImplementation(async () => {
			seenAtCheck.push(getScheduleRunLaunchedAt("dep-1"));
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

		// The early check precedes the launch; the launch point's does not.
		expect(seenAtCheck[0]).toBeUndefined();
		expect(seenAtCheck.at(-1)).toBeTypeOf("number");
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
				expect(getScheduleRunLaunchedAt("dep-1")).toBeTypeOf("number");
				return { stdout: "", stderr: "" };
			},
		);

		await runCommand("sch-1");

		expect(getScheduleRunLaunchedAt("dep-1")).toBeUndefined();
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

		expect(getScheduleRunLaunchedAt("dep-1")).toBeUndefined();
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
			expect(getScheduleRunLaunchedAt("dep-1")).toBeTypeOf("number");
			return {};
		});

		await expect(runCommand("sch-1")).resolves.toMatchObject({
			status: "done",
		});
		expect(mocks.spawnAsync).toHaveBeenCalledTimes(1);
	});
});
