import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The progress marks written to a deployment log while one of its long steps
 * runs (T-11843): what they are, where they go, and that they never change
 * what the step does.
 */

const mocks = vi.hoisted(() => ({
	appendFile: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ appendFile: mocks.appendFile }));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

import {
	appendDeployLogLine,
	DEPLOY_HEARTBEAT_INTERVAL_MS,
	DEPLOY_HEARTBEAT_SETTLE_MS,
	deployLogHasLine,
	getBuildStartCommand,
	getBuildStartLine,
	getDeployHeartbeatLine,
	withDeployHeartbeat,
	withDeployLogHeartbeat,
} from "@dokploy/server/services/deployment-heartbeat";
import { MIN_WATCHDOG_IDLE_MINUTES } from "@dokploy/server/utils/deployments/watchdog-config";

const MIN = 60_000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	mocks.appendFile.mockResolvedValue(undefined);
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("withDeployHeartbeat", () => {
	it("marks progress more often than the smallest idle limit the watchdog accepts", () => {
		expect(DEPLOY_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(
			(MIN_WATCHDOG_IDLE_MINUTES * MIN) / 3,
		);
	});

	it("writes a line every interval while the step runs, and none after it ends", async () => {
		const write = vi.fn();
		let finish: () => void = () => {};
		const step = withDeployHeartbeat(
			() => new Promise<string>((resolve) => (finish = () => resolve("ok"))),
			{ label: "The push", write },
		);

		await vi.advanceTimersByTimeAsync(DEPLOY_HEARTBEAT_INTERVAL_MS - 1);
		expect(write).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(write).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2 * DEPLOY_HEARTBEAT_INTERVAL_MS);
		expect(write).toHaveBeenCalledTimes(3);
		expect(write.mock.calls[2]?.[0]).toBe(
			getDeployHeartbeatLine("The push", 3 * DEPLOY_HEARTBEAT_INTERVAL_MS),
		);

		finish();
		await expect(step).resolves.toBe("ok");
		await vi.advanceTimersByTimeAsync(10 * DEPLOY_HEARTBEAT_INTERVAL_MS);
		expect(write).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("hands back the failure of the step and stops marking", async () => {
		const write = vi.fn();
		const boom = new Error("push failed");
		const step = withDeployHeartbeat(
			() =>
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(boom), 7 * MIN),
				),
			{ label: "The push", write },
		);
		const caught = step.catch((error) => error);

		await vi.advanceTimersByTimeAsync(7 * MIN);
		expect(await caught).toBe(boom);
		expect(write).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30 * MIN);
		expect(write).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never lets a failed or slow write change the step", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const write = vi.fn().mockRejectedValue(new Error("host unreachable"));
		const step = withDeployHeartbeat(
			() =>
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("ok"), 12 * MIN),
				),
			{ label: "The push", write },
		);

		await vi.advanceTimersByTimeAsync(12 * MIN);
		await expect(step).resolves.toBe("ok");
		expect(write).toHaveBeenCalledTimes(2);
	});

	it("does not start a write while the previous one is still pending", async () => {
		let release: () => void = () => {};
		const write = vi.fn(
			() => new Promise<void>((resolve) => (release = resolve)),
		);
		const step = withDeployHeartbeat(
			() => new Promise<void>((resolve) => setTimeout(resolve, 21 * MIN)),
			{ label: "The push", write },
		);

		await vi.advanceTimersByTimeAsync(16 * MIN);
		expect(write).toHaveBeenCalledTimes(1);
		release();
		await vi.advanceTimersByTimeAsync(5 * MIN);
		expect(write).toHaveBeenCalledTimes(2);
		// The end of the step waits for the mark that is being written.
		release();
		await step;
	});

	it("stops marking a step that outlives the bound, without ending the step", async () => {
		const write = vi.fn();
		const step = withDeployHeartbeat(
			() =>
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("late"), 60 * MIN),
				),
			{ label: "The push", write, intervalMs: 5 * MIN, maxMs: 20 * MIN },
		);

		await vi.advanceTimersByTimeAsync(60 * MIN);
		await expect(step).resolves.toBe("late");
		expect(write).toHaveBeenCalledTimes(4);
	});
});

describe("a step that is only marked from a point on (T-11843)", () => {
	it("writes nothing while the point has not been reached, then marks from the tick that sees it", async () => {
		const write = vi.fn();
		let reached = false;
		const ready = vi.fn(async () => reached);
		const step = withDeployHeartbeat(
			() => new Promise<void>((resolve) => setTimeout(resolve, 60 * MIN)),
			{ label: "The build", write, ready },
		);

		// A clone that hangs: the point is never reached, so nothing is written
		// and the idle limit of the watchdog still sees a silent log.
		await vi.advanceTimersByTimeAsync(20 * MIN);
		expect(write).not.toHaveBeenCalled();
		expect(ready).toHaveBeenCalledTimes(4);

		reached = true;
		// The tick that sees the point writes the first mark itself: the log is
		// silent for at most one interval after the point, not two.
		await vi.advanceTimersByTimeAsync(5 * MIN);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenLastCalledWith(
			getDeployHeartbeatLine("The build", 0),
		);
		await vi.advanceTimersByTimeAsync(5 * MIN);
		expect(write).toHaveBeenCalledTimes(2);
		expect(write).toHaveBeenLastCalledWith(
			getDeployHeartbeatLine("The build", 5 * MIN),
		);
		// Once seen, the point is not looked for again.
		expect(ready).toHaveBeenCalledTimes(5);

		await vi.advanceTimersByTimeAsync(30 * MIN);
		await step;
	});

	it("treats a check that fails as not reached", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const write = vi.fn();
		const step = withDeployHeartbeat(
			() => new Promise<void>((resolve) => setTimeout(resolve, 30 * MIN)),
			{
				label: "The build",
				write,
				ready: async () => {
					throw new Error("host unreachable");
				},
			},
		);
		await vi.advanceTimersByTimeAsync(30 * MIN);
		await step;
		expect(write).not.toHaveBeenCalled();
	});
});

describe("a step whose deployment stops running (T-11843)", () => {
	it("stops marking for good once the deployment is no longer running", async () => {
		const write = vi.fn();
		let running = true;
		const step = withDeployHeartbeat(
			() => new Promise<void>((resolve) => setTimeout(resolve, 60 * MIN)),
			{ label: "The build", write, isActive: async () => running },
		);

		await vi.advanceTimersByTimeAsync(10 * MIN);
		expect(write).toHaveBeenCalledTimes(2);
		// The watchdog failed the deploy, but its process could not be stopped.
		running = false;
		await vi.advanceTimersByTimeAsync(5 * MIN);
		running = true;
		await vi.advanceTimersByTimeAsync(50 * MIN);
		expect(write).toHaveBeenCalledTimes(2);
		await step;
	});

	it("keeps marking when the status cannot be read", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const write = vi.fn();
		const step = withDeployHeartbeat(
			() => new Promise<void>((resolve) => setTimeout(resolve, 10 * MIN)),
			{
				label: "The build",
				write,
				isActive: async () => {
					throw new Error("database down");
				},
			},
		);
		await vi.advanceTimersByTimeAsync(10 * MIN);
		await step;
		expect(write).toHaveBeenCalledTimes(2);
	});
});

describe("the end of a step and a mark that is being written (T-11843)", () => {
	it("waits for the mark in flight, so none follows the lines written after the step", async () => {
		const order: string[] = [];
		let finishWrite: () => void = () => {};
		const write = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishWrite = () => {
						order.push("mark");
						resolve();
					};
				}),
		);
		const step = withDeployHeartbeat(
			() => new Promise<void>((resolve) => setTimeout(resolve, 5 * MIN + 100)),
			{ label: "The build", write },
		).then(() => order.push("after the step"));

		// The step ends while the mark of minute 5 is still being written.
		await vi.advanceTimersByTimeAsync(5 * MIN + 100);
		expect(write).toHaveBeenCalledTimes(1);
		expect(order).toEqual([]);
		finishWrite();
		await step;
		expect(order).toEqual(["mark", "after the step"]);
	});

	it("does not wait longer than the bound for a host that hangs", async () => {
		const write = vi.fn(() => new Promise<void>(() => {}));
		let ended = false;
		const step = withDeployHeartbeat(
			() => new Promise<void>((resolve) => setTimeout(resolve, 5 * MIN + 100)),
			{ label: "The build", write },
		).then(() => {
			ended = true;
		});

		await vi.advanceTimersByTimeAsync(5 * MIN + 100);
		expect(ended).toBe(false);
		await vi.advanceTimersByTimeAsync(DEPLOY_HEARTBEAT_SETTLE_MS);
		await step;
		expect(ended).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("deployLogHasLine", () => {
	it("asks the server that holds the log, and reads the count of lines", async () => {
		mocks.execAsyncRemote.mockResolvedValueOnce({ stdout: "1\n", stderr: "" });
		await expect(
			deployLogHasLine(
				{ serverId: "build-1", logPath: "/logs/dep.log" },
				getBuildStartLine("dep-1"),
			),
		).resolves.toBe(true);
		const [serverId, command] = mocks.execAsyncRemote.mock.calls[0] as [
			string,
			string,
		];
		expect(serverId).toBe("build-1");
		// The whole line, as a fixed string.
		expect(command).toContain("grep -cxF --");
		expect(command).toContain("/logs/dep.log");
		expect(command.replaceAll("\\", "")).toContain(getBuildStartLine("dep-1"));
		expect(mocks.execAsync).not.toHaveBeenCalled();

		mocks.execAsyncRemote.mockResolvedValueOnce({ stdout: "0\n", stderr: "" });
		await expect(
			deployLogHasLine(
				{ serverId: "build-1", logPath: "/logs/dep.log" },
				getBuildStartLine("dep-1"),
			),
		).resolves.toBe(false);
	});

	it("reads a local log on the Dokploy host, and an unreadable log as not there", async () => {
		mocks.execAsync.mockResolvedValueOnce({ stdout: "2\n", stderr: "" });
		await expect(
			deployLogHasLine({ serverId: null, logPath: "/logs/dep.log" }, "x"),
		).resolves.toBe(true);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();

		mocks.execAsync.mockResolvedValueOnce({ stdout: "", stderr: "no file" });
		await expect(
			deployLogHasLine({ serverId: null, logPath: "/logs/dep.log" }, "x"),
		).resolves.toBe(false);
		await expect(
			deployLogHasLine({ serverId: null, logPath: "" }, "x"),
		).resolves.toBe(false);
	});

	it("is the line the deploy script echoes where the build starts, on a line of its own", () => {
		const command = getBuildStartCommand("dep-1");
		// An empty line first, so a git progress line that was left open (it ends
		// in a carriage return) cannot swallow the marker, then the marker.
		expect(command).toBe(
			"echo;echo '--- Dokploy: the build of dep-1 starts here ---';",
		);
	});

	it("names the deployment, so another deployment's line is a different line", () => {
		expect(getBuildStartLine("dep-1")).toContain("dep-1");
		expect(getBuildStartLine("dep-1")).not.toBe(getBuildStartLine("dep-2"));
	});
});

describe("appendDeployLogLine", () => {
	it("appends to a local log", async () => {
		await appendDeployLogLine(
			{ serverId: null, logPath: "/etc/dokploy/logs/app/dep.log" },
			"mark",
		);
		expect(mocks.appendFile).toHaveBeenCalledWith(
			"/etc/dokploy/logs/app/dep.log",
			"mark\n",
		);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("appends to the log on the server that holds it", async () => {
		await appendDeployLogLine(
			{ serverId: "srv-1", logPath: "/etc/dokploy/logs/app/dep:1.log" },
			"mark",
		);
		expect(mocks.appendFile).not.toHaveBeenCalled();
		const [serverId, command] = mocks.execAsyncRemote.mock.calls[0] as [
			string,
			string,
		];
		expect(serverId).toBe("srv-1");
		const encoded = command.match(/echo "([A-Za-z0-9+/=]+)"/)?.[1] ?? "";
		expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("mark\n");
		expect(command).toContain(">> ");
		expect(command).toContain("dep");
	});

	it("writes nothing without a log path", async () => {
		await appendDeployLogLine({ serverId: null, logPath: "" }, "mark");
		await appendDeployLogLine({ serverId: "srv-1", logPath: "." }, "mark");
		expect(mocks.appendFile).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});

describe("withDeployLogHeartbeat", () => {
	it("writes the marks to the log of the deployment", async () => {
		const step = withDeployLogHeartbeat(
			{ serverId: "srv-1", logPath: "/logs/dep.log" },
			"The compose release step",
			() => new Promise<void>((resolve) => setTimeout(resolve, 11 * MIN)),
		);

		await vi.advanceTimersByTimeAsync(11 * MIN);
		await step;
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(2);
		const command = mocks.execAsyncRemote.mock.calls[0]?.[1] as string;
		const encoded = command.match(/echo "([A-Za-z0-9+/=]+)"/)?.[1] ?? "";
		expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(
			`${getDeployHeartbeatLine("The compose release step", 5 * MIN)}\n`,
		);
	});

	it("marks an application only once its log holds the line of the build start", async () => {
		let started = false;
		mocks.execAsyncRemote.mockImplementation(
			async (_server: string, command: string) =>
				command.includes("grep -cxF")
					? { stdout: started ? "1\n" : "0\n", stderr: "" }
					: { stdout: "", stderr: "" },
		);
		const step = withDeployLogHeartbeat(
			{ serverId: "build-1", logPath: "/logs/dep.log" },
			"The build",
			() => new Promise<void>((resolve) => setTimeout(resolve, 40 * MIN)),
			{ startsAfterLogLine: getBuildStartLine("dep-1") },
		);
		const appends = () =>
			mocks.execAsyncRemote.mock.calls.filter(([, command]) =>
				String(command).includes("base64 -d"),
			);

		await vi.advanceTimersByTimeAsync(15 * MIN);
		expect(appends()).toHaveLength(0);
		started = true;
		await vi.advanceTimersByTimeAsync(25 * MIN);
		await step;
		expect(appends().length).toBeGreaterThanOrEqual(4);
		expect(appends().every(([server]) => server === "build-1")).toBe(true);
	});

	it("stops marking once the deployment is no longer running", async () => {
		let running = true;
		const step = withDeployLogHeartbeat(
			{ serverId: "srv-1", logPath: "/logs/dep.log" },
			"The compose release step",
			() => new Promise<void>((resolve) => setTimeout(resolve, 40 * MIN)),
			{ isRunning: () => running },
		);
		await vi.advanceTimersByTimeAsync(10 * MIN);
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(2);
		running = false;
		await vi.advanceTimersByTimeAsync(30 * MIN);
		await step;
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(2);
	});
});
