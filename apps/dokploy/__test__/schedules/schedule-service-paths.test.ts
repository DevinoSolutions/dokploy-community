import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A schedule's app name is the directory its script and logs live in. Rows
 * written before the name stopped being client input can hold anything, so the
 * service must refuse to build paths from them, and must quote the ones it
 * does build.
 */

const mocks = vi.hoisted(() => ({
	root: "",
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findFirst: vi.fn(),
	deleteWhere: vi.fn(),
	returning: vi.fn(),
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

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { schedules: { findFirst: mocks.findFirst } },
		delete: () => ({ where: mocks.deleteWhere }),
		update: () => ({
			set: () => ({ where: () => ({ returning: mocks.returning }) }),
		}),
	},
}));

vi.mock("@dokploy/server/services/permission", () => ({
	findMemberByUserId: vi.fn(),
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(),
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	encodeBase64: (content: string) => Buffer.from(content).toString("base64"),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

import {
	deleteSchedule,
	updateSchedule,
} from "@dokploy/server/services/schedule";

// Git Bash on Windows wants /c/Users/... instead of C:\Users\...
const toPosix = (value: string) =>
	value
		.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
		.split(String.fromCharCode(92))
		.join("/");

const root = mkdtempSync(path.join(tmpdir(), "dokploy-schedule-svc-"));
mocks.root = toPosix(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const row = (appName: string, extra: Record<string, unknown> = {}) => ({
	scheduleId: "sch-1",
	appName,
	scheduleType: "dokploy-server",
	serverId: null,
	script: "echo hello",
	application: null,
	compose: null,
	...extra,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.deleteWhere.mockResolvedValue({ rowCount: 1 });
});

describe("deleteSchedule", () => {
	it("removes the schedule directory with a quoted path", async () => {
		mocks.findFirst.mockResolvedValue(row("schedule-run-fast-bus-AbC123"));

		await deleteSchedule("sch-1");

		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		expect(mocks.execAsync.mock.calls[0]?.[0]).toBe(
			`rm -rf ${mocks.root}/schedules/schedule-run-fast-bus-AbC123`,
		);
		expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
	});

	it.each([
		"..",
		".",
		"x$(touch pwned)",
		"x`touch pwned`",
		"x;touch pwned",
		"x y",
		"../../etc",
		"",
	])("never turns app name %j into a path to delete", async (appName) => {
		mocks.findFirst.mockResolvedValue(row(appName));

		await deleteSchedule("sch-1");

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		// the row itself is still removed so it does not linger
		expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
	});
});

describe("updateSchedule script handling", () => {
	it("rejects a stored app name that is not a plain directory name", async () => {
		mocks.returning.mockResolvedValue([row("x$(touch pwned)")]);

		await expect(
			updateSchedule({ scheduleId: "sch-1" } as never),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("writes the script into its directory", async () => {
		const appName = "schedule-run-fast-bus-AbC123";
		mocks.returning.mockResolvedValue([row(appName)]);

		await updateSchedule({ scheduleId: "sch-1" } as never);

		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		execFileSync("bash", ["-c", mocks.execAsync.mock.calls[0]?.[0] as string], {
			cwd: root,
			stdio: "ignore",
		});

		const scriptFile = path.join(root, "schedules", appName, "script.sh");
		expect(existsSync(scriptFile)).toBe(true);
		expect(readFileSync(scriptFile, "utf8")).toContain("echo hello");
		if (process.platform !== "win32") {
			expect(statSync(scriptFile).mode & 0o111).not.toBe(0);
		}
	}, 30_000);

	it("sends the script to the remote server for server schedules", async () => {
		mocks.returning.mockResolvedValue([
			row("schedule-run-fast-bus-AbC123", {
				scheduleType: "server",
				serverId: "server-1",
			}),
		]);

		await updateSchedule({ scheduleId: "sch-1" } as never);

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("server-1");
	});
});
