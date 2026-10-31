import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The progress marks written to a deployment log while one of its long steps
 * runs (T-11843): what they are, where they go, and that they never change
 * what the step does.
 */

const mocks = vi.hoisted(() => ({
	appendFile: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ appendFile: mocks.appendFile }));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: mocks.execAsyncRemote,
}));

import {
	appendDeployLogLine,
	DEPLOY_HEARTBEAT_INTERVAL_MS,
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
			() => new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 12 * MIN)),
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
		await step;
		expect(write).toHaveBeenCalledTimes(2);
	});

	it("stops marking a step that outlives the bound, without ending the step", async () => {
		const write = vi.fn();
		const step = withDeployHeartbeat(
			() => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 60 * MIN)),
			{ label: "The push", write, intervalMs: 5 * MIN, maxMs: 20 * MIN },
		);

		await vi.advanceTimersByTimeAsync(60 * MIN);
		await expect(step).resolves.toBe("late");
		expect(write).toHaveBeenCalledTimes(4);
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
});
