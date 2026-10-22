import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
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
	// Where the schedule directories are: the same folder, spelled for the shell
	// (root) or for fs (fsRoot, which Windows resolves).
	base: "",
	fsRoot: "",
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	writeFileRemote: vi.fn(),
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
	paths: () => ({ SCHEDULES_PATH: `${mocks.base}/schedules` }),
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

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	writeFileRemote: mocks.writeFileRemote,
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
mocks.fsRoot = root;
mocks.base = mocks.root;
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
	mocks.base = mocks.root;
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

	it("writes the script into its directory without putting it in a command", async () => {
		const appName = "schedule-run-fast-bus-AbC123";
		mocks.base = mocks.fsRoot;
		mocks.returning.mockResolvedValue([
			row(appName, { script: "export TOKEN=s3cr3t-token-value" }),
		]);

		await updateSchedule({ scheduleId: "sch-1" } as never);

		// Nothing is run through a shell: the script never reaches a command line.
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		const dir = path.join(root, "schedules", appName);
		const scriptFile = path.join(dir, "script.sh");
		expect(existsSync(scriptFile)).toBe(true);
		const content = readFileSync(scriptFile, "utf8");
		expect(content).toContain("export TOKEN=s3cr3t-token-value");
		expect(content).toContain("Schedule ID: sch-1");
		if (process.platform !== "win32") {
			// Owner only, runnable, and the staged file was moved over the script.
			expect(statSync(scriptFile).mode & 0o777).toBe(0o700);
		}
		expect(readdirSync(dir)).toEqual(["script.sh"]);
	});

	it("replaces an existing script in one step", async () => {
		const appName = "schedule-run-fast-bus-DeF456";
		mocks.base = mocks.fsRoot;
		const dir = path.join(root, "schedules", appName);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "script.sh"), "echo old");
		mocks.returning.mockResolvedValue([
			row(appName, { script: "echo new" }),
		]);

		await updateSchedule({ scheduleId: "sch-1" } as never);

		expect(readFileSync(path.join(dir, "script.sh"), "utf8")).toContain(
			"echo new",
		);
		expect(readdirSync(dir)).toEqual(["script.sh"]);
	});

	it("sweeps stale staged scripts of earlier saves, and leaves a fresh one alone", async () => {
		const appName = "schedule-run-fast-bus-GhI789";
		mocks.base = mocks.fsRoot;
		const dir = path.join(root, "schedules", appName);
		mkdirSync(dir, { recursive: true });
		const stale = path.join(dir, ".dokploy-stage-schedule-script-sch-1-old");
		const fresh = path.join(dir, ".dokploy-stage-schedule-script-sch-1-new");
		writeFileSync(stale, "echo stale");
		writeFileSync(fresh, "echo fresh");
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
		utimesSync(stale, twoHoursAgo, twoHoursAgo);
		mocks.returning.mockResolvedValue([row(appName)]);

		await updateSchedule({ scheduleId: "sch-1" } as never);

		expect(readdirSync(dir).sort()).toEqual([
			".dokploy-stage-schedule-script-sch-1-new",
			"script.sh",
		]);
	});

	it("stages the script of a server schedule through SFTP and moves it into place", async () => {
		const secret = "s3cr3t-token-value";
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.writeFileRemote.mockResolvedValue(undefined);
		mocks.returning.mockResolvedValue([
			row("schedule-run-fast-bus-AbC123", {
				scheduleType: "server",
				serverId: "server-1",
				script: `export TOKEN=${secret}`,
			}),
		]);

		await updateSchedule({ scheduleId: "sch-1" } as never);

		expect(mocks.execAsync).not.toHaveBeenCalled();
		// The content goes through SFTP, to a staged file next to the script.
		expect(mocks.writeFileRemote).toHaveBeenCalledTimes(1);
		const [serverId, stagedPath, content] =
			mocks.writeFileRemote.mock.calls[0] ?? [];
		expect(serverId).toBe("server-1");
		expect(stagedPath).toContain(
			"/schedules/schedule-run-fast-bus-AbC123/.dokploy-stage-schedule-script-sch-1",
		);
		expect(content).toContain(secret);
		// No command that is sent carries it, and the staged file ends up as the script.
		const commands = mocks.execAsyncRemote.mock.calls.map(
			(call) => call[1] as string,
		);
		expect(commands.length).toBeGreaterThan(0);
		for (const command of commands) expect(command).not.toContain(secret);
		expect(mocks.execAsyncRemote.mock.calls.every((c) => c[0] === "server-1"))
			.toBe(true);
		const last = commands.at(-1) as string;
		expect(last).toMatch(/^chmod 700 \S+ && mv -f \S+ \S+\/script\.sh$/);
		expect(last).toContain(stagedPath as string);
	});

	it("stages every save under its own name, so concurrent saves do not race", async () => {
		mocks.writeFileRemote.mockResolvedValue(undefined);
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.returning.mockResolvedValue([
			row("schedule-run-fast-bus-AbC123", {
				scheduleType: "server",
				serverId: "server-1",
			}),
		]);

		await Promise.all([
			updateSchedule({ scheduleId: "sch-1" } as never),
			updateSchedule({ scheduleId: "sch-1" } as never),
		]);

		const staged = mocks.writeFileRemote.mock.calls.map((c) => c[1] as string);
		expect(staged).toHaveLength(2);
		expect(new Set(staged).size).toBe(2);
		for (const name of staged) {
			expect(name).toMatch(
				/\.dokploy-stage-schedule-script-sch-1-[0-9a-f-]{36}$/,
			);
		}
		// Each save moves its own file into place.
		const moves = mocks.execAsyncRemote.mock.calls.map((c) => c[1] as string);
		for (const name of staged) {
			expect(moves.some((m) => m.includes(name))).toBe(true);
		}
	});

	it("removes the staged file when it cannot be moved into place", async () => {
		mocks.writeFileRemote.mockResolvedValue(undefined);
		mocks.execAsyncRemote.mockImplementation(async (_id, command: string) => {
			if (command.startsWith("chmod")) throw new Error("mv failed");
			return { stdout: "", stderr: "" };
		});
		mocks.returning.mockResolvedValue([
			row("schedule-run-fast-bus-AbC123", {
				scheduleType: "server",
				serverId: "server-1",
			}),
		]);

		await expect(
			updateSchedule({ scheduleId: "sch-1" } as never),
		).rejects.toThrow("mv failed");

		const commands = mocks.execAsyncRemote.mock.calls.map(
			(call) => call[1] as string,
		);
		expect(commands.at(-1)).toMatch(
			/^rm -f \S+\.dokploy-stage-schedule-script-sch-1-[0-9a-f-]{36}$/,
		);
	});

	it("does nothing for a server schedule without a server", async () => {
		mocks.returning.mockResolvedValue([
			row("schedule-run-fast-bus-AbC123", {
				scheduleType: "server",
				serverId: null,
			}),
		]);

		await updateSchedule({ scheduleId: "sch-1" } as never);

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
	});
});
