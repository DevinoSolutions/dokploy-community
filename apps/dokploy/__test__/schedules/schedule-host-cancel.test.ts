import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A server / dokploy-server run whose script never prints its pid cannot be
 * killed by pid. Past a short grace period its cancel stops it by the run tag
 * instead (the run is tagged like a container run, see runCommand), and a run
 * with nothing to stop ends as cancelled with a line in its log.
 */

const mocks = vi.hoisted(() => ({
	cloud: false,
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	appendFile: vi.fn(),
	set: vi.fn(),
	where: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({
	get IS_CLOUD() {
		return mocks.cloud;
	},
}));

vi.mock("@dokploy/server/services/schedule", () => ({
	findScheduleById: vi.fn(),
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	getServiceContainer: vi.fn(),
	getComposeContainer: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	appendFile: mocks.appendFile,
}));

vi.mock("@dokploy/server/db", () => {
	const chain = {
		set: (values: unknown) => {
			mocks.set(values);
			return chain;
		},
		where: (condition: unknown) => {
			mocks.where(condition);
			return chain;
		},
		returning: async () => [],
		// biome-ignore lint/suspicious/noThenProperty: mimics a drizzle query
		then: (resolve: (value: unknown) => void) => resolve(undefined),
	};
	return { db: { update: () => chain, query: {} } };
});

const {
	SCHEDULE_LAUNCH_SETTLE_MS,
	SCHEDULE_STRANDED_MS,
	cancelHostScheduleRun,
	decideRunWithoutProcess,
} = await import("@dokploy/server/utils/schedules/cancel");
const { SCHEDULE_KILL_SCRIPT, SCHEDULE_NONE_MARKER } = await import(
	"@dokploy/server/utils/schedules/container-run"
);
const { NO_PROCESS_LOG_LINE, STRANDED_LOG_LINE, endScheduleRunWithoutProcess } =
	await import("@dokploy/server/utils/schedules/run-status");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.cloud = false;
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.appendFile.mockResolvedValue(undefined);
});

describe("decideRunWithoutProcess", () => {
	const now = Date.parse("2026-10-14T12:00:00.000Z");
	const before = (ms: number) => new Date(now - ms).toISOString();

	it("a run that was not launched yet keeps its cancel, however slow the connect", () => {
		for (const age of [1_000, 60_000, SCHEDULE_STRANDED_MS - 1]) {
			expect(
				decideRunWithoutProcess({
					launch: undefined,
					startedAt: before(age),
					now,
				}),
			).toBe("claim");
		}
	});

	it("a run launched moments ago is retried, one launched a while ago is gone", () => {
		const launched = (ms: number) =>
			decideRunWithoutProcess({
				launch: { state: "launched", at: now - ms },
				startedAt: before(60 * 60_000),
				now,
			});

		expect(launched(0)).toBe("retry");
		expect(launched(SCHEDULE_LAUNCH_SETTLE_MS - 1)).toBe("retry");
		expect(launched(SCHEDULE_LAUNCH_SETTLE_MS)).toBe("gone");
		expect(launched(5 * 60_000)).toBe("gone");
	});

	it("a run with no launch record that is older than the stranded bound was left behind", () => {
		const stranded = (startedAt: string | null | undefined) =>
			decideRunWithoutProcess({ launch: undefined, startedAt, now });

		expect(stranded(before(SCHEDULE_STRANDED_MS))).toBe("stranded");
		expect(stranded(before(24 * 3600_000))).toBe("stranded");
		expect(stranded(null)).toBe("claim");
		expect(stranded(undefined)).toBe("claim");
		expect(stranded("yesterday-ish")).toBe("claim");
	});

	it("uses bounds that sit well apart: 10 seconds to settle, 10 minutes to strand", () => {
		expect(SCHEDULE_LAUNCH_SETTLE_MS).toBe(10_000);
		expect(SCHEDULE_STRANDED_MS).toBe(600_000);
	});
});

describe("cancelHostScheduleRun", () => {
	it("runs the kill script with the run id as its own argument on the server", async () => {
		await cancelHostScheduleRun("srv-1", "dep_1-A");

		const [serverId, command] = mocks.execAsyncRemote.mock.calls[0] as [
			string,
			string,
		];
		expect(serverId).toBe("srv-1");
		const out = spawnSync(
			"bash",
			["-c", `sh() { printf '%s\\0' "$@"; }\n${command}`],
			{ encoding: "utf8" },
		).stdout;
		expect(out.split("\0").slice(0, -1)).toEqual([
			"-c",
			SCHEDULE_KILL_SCRIPT,
			"sh",
			"dep_1-A",
		]);
	});

	it("runs it on the Dokploy host when there is no server", async () => {
		await cancelHostScheduleRun(null, "dep_1-A");

		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("reports whether anything carried the tag", async () => {
		await expect(cancelHostScheduleRun("srv-1", "dep_1-A")).resolves.toEqual({
			found: true,
		});

		mocks.execAsyncRemote.mockResolvedValue({
			stdout: `${SCHEDULE_NONE_MARKER}\n`,
			stderr: "",
		});
		await expect(cancelHostScheduleRun("srv-1", "dep_1-A")).resolves.toEqual({
			found: false,
		});
	});

	it("refuses a run id that could reach a shell, and the cloud host", async () => {
		await expect(
			cancelHostScheduleRun("srv-1", "x'; reboot; '"),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		mocks.cloud = true;
		await expect(cancelHostScheduleRun(null, "dep_1-A")).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});

describe("endScheduleRunWithoutProcess", () => {
	it("ends the run as cancelled (from running or cancelled) and logs why", async () => {
		await endScheduleRunWithoutProcess("dep-1", null, "/logs/run.log");

		expect(mocks.set).toHaveBeenCalledWith(
			expect.objectContaining({ status: "cancelled" }),
		);
		expect(mocks.appendFile).toHaveBeenCalledWith(
			"/logs/run.log",
			`${NO_PROCESS_LOG_LINE}\n`,
		);
		expect(NO_PROCESS_LOG_LINE).toMatch(/cancelled/i);
	});

	it("says it was left behind for a stranded run", async () => {
		await endScheduleRunWithoutProcess(
			"dep-1",
			null,
			"/logs/run.log",
			STRANDED_LOG_LINE,
		);

		expect(mocks.appendFile).toHaveBeenCalledWith(
			"/logs/run.log",
			`${STRANDED_LOG_LINE}
`,
		);
		expect(STRANDED_LOG_LINE).toMatch(/restart/i);
	});

	it("logs on the server the run lives on", async () => {
		await endScheduleRunWithoutProcess("dep-1", "srv-1", "/logs/run.log");

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"srv-1",
			expect.stringContaining(NO_PROCESS_LOG_LINE),
		);
		expect(mocks.appendFile).not.toHaveBeenCalled();
	});

	it("still ends the run when the log cannot be written", async () => {
		mocks.appendFile.mockRejectedValue(new Error("disk full"));
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		await expect(
			endScheduleRunWithoutProcess("dep-1", null, "/logs/run.log"),
		).resolves.toBeUndefined();

		expect(mocks.set).toHaveBeenCalled();
		spy.mockRestore();
	});

	it("skips the log line when the run has no log", async () => {
		await endScheduleRunWithoutProcess("dep-1", null, null);

		expect(mocks.set).toHaveBeenCalled();
		expect(mocks.appendFile).not.toHaveBeenCalled();
	});
});
