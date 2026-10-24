import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-7344: the prunes inside cleanupAll run one after another. The guarded path
 * (utils/docker/cleanup-job) hands in `shouldAbort` so a deploy that started
 * after the idle check is not run over by the later `--all` prunes. The other
 * callers (the manual "clean all" buttons) pass nothing and are unchanged.
 */

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

import { cleanupAll } from "@dokploy/server/utils/docker/utils";

const ranCommands = (mock: typeof mocks.execAsync) =>
	mock.mock.calls.map(
		(call) =>
			(call[call.length - 1] as string).match(/docker [a-z]+ prune/)?.[0],
	);

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => {});
	mocks.execAsync.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote
		.mockReset()
		.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("cleanupAll", () => {
	it("runs every prune except volumes when nothing asks it to stop", async () => {
		expect(await cleanupAll()).toEqual({ aborted: false });
		expect(ranCommands(mocks.execAsync)).toEqual([
			"docker container prune",
			"docker image prune",
			"docker builder prune",
			"docker system prune",
		]);
	});

	it("runs remotely with a serverId", async () => {
		await cleanupAll("srv-1");
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(4);
		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("srv-1");
	});

	it("checks before every prune but the first, and stops when a deploy appeared", async () => {
		const shouldAbort = vi
			.fn()
			.mockResolvedValueOnce(false) // before images
			.mockResolvedValueOnce(true); // before builders
		const result = await cleanupAll("srv-1", { shouldAbort });
		expect(result).toEqual({ aborted: true });
		expect(shouldAbort).toHaveBeenCalledTimes(2);
		expect(ranCommands(mocks.execAsyncRemote)).toEqual([
			"docker container prune",
			"docker image prune",
		]);
	});

	it("runs everything when the host stays idle", async () => {
		const shouldAbort = vi.fn().mockResolvedValue(false);
		expect(await cleanupAll(undefined, { shouldAbort })).toEqual({
			aborted: false,
		});
		expect(shouldAbort).toHaveBeenCalledTimes(3);
		expect(mocks.execAsync).toHaveBeenCalledTimes(4);
	});

	it("treats a failing check as a reason to stop", async () => {
		const shouldAbort = vi.fn().mockRejectedValue(new Error("db down"));
		expect(await cleanupAll(undefined, { shouldAbort })).toEqual({
			aborted: true,
		});
		expect(ranCommands(mocks.execAsync)).toEqual(["docker container prune"]);
	});

	it("keeps going past a prune that fails", async () => {
		mocks.execAsync.mockRejectedValueOnce(new Error("boom"));
		expect(await cleanupAll()).toEqual({ aborted: false });
		expect(mocks.execAsync).toHaveBeenCalledTimes(4);
	});
});
