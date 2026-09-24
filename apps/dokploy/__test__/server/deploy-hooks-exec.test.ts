import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	HOOK_LOG_CLOSE_TIMEOUT_MS,
	HOOK_LOG_RELAY_MAX_BYTES,
	HOOK_LOG_RETRY_DELAY_MS,
	HOOK_LOG_RETRY_MARKER,
	HOOK_LOG_TRUNCATION_MARKER,
	runDeployHook,
} from "@dokploy/server/utils/docker/hooks";
import * as dockerUtils from "@dokploy/server/utils/docker/utils";
import { ExecError } from "@dokploy/server/utils/process/ExecError";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	execAsyncStream: vi.fn(),
	openRemoteInputSession: vi.fn(),
}));

vi.mock("@dokploy/server/utils/docker/utils", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/docker/utils")
	>("@dokploy/server/utils/docker/utils");
	return {
		...actual,
		// `encodeBase64` stays real — the encoding is the thing under test.
		getServiceContainer: vi.fn(),
	};
});

const LOG_PATH = "/tmp/deploy.log";

const lastLocalCommand = () => {
	const calls = vi.mocked(execProcess.execAsync).mock.calls;
	return String(calls.at(-1)?.[0] ?? "");
};

describe("runDeployHook", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);
		vi.mocked(execProcess.execAsyncRemote).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);
		vi.mocked(dockerUtils.getServiceContainer).mockResolvedValue({
			Id: "label-resolved-container",
		} as any);
	});

	it("execs against an explicit containerId without a label lookup", async () => {
		await runDeployHook({
			kind: "post",
			appName: "test-app",
			serverId: null,
			command: "npm run migrate",
			logPath: LOG_PATH,
			logServerId: null,
			containerId: "task-container-id",
		});

		expect(dockerUtils.getServiceContainer).not.toHaveBeenCalled();
		expect(lastLocalCommand()).toContain('docker exec "task-container-id"');
		expect(lastLocalCommand()).not.toContain("label-resolved-container");
	});

	it("falls back to the label lookup when no containerId is given", async () => {
		await runDeployHook({
			kind: "pre",
			appName: "test-app",
			serverId: null,
			command: "echo hi",
			logPath: LOG_PATH,
			logServerId: null,
		});

		expect(dockerUtils.getServiceContainer).toHaveBeenCalledWith(
			"test-app",
			null,
		);
		expect(lastLocalCommand()).toContain(
			'docker exec "label-resolved-container"',
		);
	});

	it("does nothing when the command is empty or whitespace", async () => {
		for (const command of [null, undefined, "", "   \n\t "]) {
			await runDeployHook({
				kind: "pre",
				appName: "test-app",
				serverId: null,
				command,
				logPath: LOG_PATH,
				logServerId: "build-server-id",
			});
		}

		expect(execProcess.execAsync).not.toHaveBeenCalled();
		expect(execProcess.execAsyncRemote).not.toHaveBeenCalled();
		expect(execProcess.execAsyncStream).not.toHaveBeenCalled();
		expect(execProcess.openRemoteInputSession).not.toHaveBeenCalled();
		expect(dockerUtils.getServiceContainer).not.toHaveBeenCalled();
	});

	// The hook command is attacker-controlled only in the sense that anyone who
	// can edit the application supplies it, but it is interpolated into a shell
	// command that runs on the Dokploy/remote host. Base64-encoding it means the
	// host shell only ever sees `[A-Za-z0-9+/=]`, so the command cannot break
	// out of the wrapper and run on the host — it is decoded into a variable and
	// handed to `docker exec ... sh -c "$hook_cmd"`, i.e. it executes inside the
	// container.
	it("never interpolates the raw command into the host shell", async () => {
		const malicious = '"; touch /tmp/pwned; echo "$(whoami)`id`';

		await runDeployHook({
			kind: "pre",
			appName: "test-app",
			serverId: null,
			command: malicious,
			logPath: LOG_PATH,
			logServerId: null,
			containerId: "c1",
		});

		const wrapper = lastLocalCommand();
		expect(wrapper).not.toContain("touch /tmp/pwned");
		expect(wrapper).not.toContain("whoami");
		expect(wrapper).not.toContain("`id`");

		// The only user-derived material in the wrapper is the base64 blob.
		const encoded = dockerUtils.encodeBase64(malicious);
		expect(wrapper).toContain(`echo "${encoded}" | base64 -d`);
		expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
		// And it is executed inside the container, not on the host.
		expect(wrapper).toContain('docker exec "c1" sh -c "$hook_cmd"');
	});

	it("logs only the command's length, never its contents", async () => {
		const secretish = "export TOKEN=super-secret-value && ./migrate.sh";

		await runDeployHook({
			kind: "post",
			appName: "test-app",
			serverId: null,
			command: secretish,
			logPath: LOG_PATH,
			logServerId: null,
			containerId: "c1",
		});

		const wrapper = lastLocalCommand();
		expect(wrapper).toContain(
			`Running post-deploy hook (length=${secretish.length} chars)`,
		);
		expect(wrapper).not.toContain("super-secret-value");
	});

	it("skips a pre-deploy hook when there is no previous container", async () => {
		vi.mocked(dockerUtils.getServiceContainer).mockResolvedValue(null as any);

		await runDeployHook({
			kind: "pre",
			appName: "test-app",
			serverId: null,
			command: "echo hi",
			logPath: LOG_PATH,
			logServerId: null,
		});

		expect(lastLocalCommand()).toContain("skipping pre-deploy hook");
		expect(lastLocalCommand()).not.toContain("docker exec");
	});

	it("writes the pre-deploy skip notice to the log host, not the app host", async () => {
		vi.mocked(dockerUtils.getServiceContainer).mockResolvedValue(null as any);

		await runDeployHook({
			kind: "pre",
			appName: "test-app",
			serverId: "app-server-id",
			command: "echo hi",
			logPath: LOG_PATH,
			logServerId: "build-server-id",
		});

		expect(dockerUtils.getServiceContainer).toHaveBeenCalledWith(
			"test-app",
			"app-server-id",
		);
		expect(execProcess.execAsyncRemote).toHaveBeenCalledTimes(1);
		expect(execProcess.execAsyncRemote).toHaveBeenCalledWith(
			"build-server-id",
			`echo "===== No previous container found; skipping pre-deploy hook =====" >> "${LOG_PATH}"`,
		);
		expect(execProcess.execAsync).not.toHaveBeenCalled();
	});

	it("fails a post-deploy hook when no container can be resolved", async () => {
		vi.mocked(dockerUtils.getServiceContainer).mockResolvedValue(null as any);

		await expect(
			runDeployHook({
				kind: "post",
				appName: "test-app",
				serverId: null,
				command: "echo hi",
				logPath: LOG_PATH,
				logServerId: null,
			}),
		).rejects.toThrow('no running container found for "test-app"');
	});

	it("runs on the given server over SSH and never locally", async () => {
		await runDeployHook({
			kind: "post",
			appName: "test-app",
			serverId: "app-server-id",
			command: "echo hi",
			logPath: LOG_PATH,
			logServerId: "app-server-id",
			containerId: "c1",
		});

		expect(execProcess.execAsync).not.toHaveBeenCalled();
		expect(execProcess.execAsyncRemote).toHaveBeenCalledWith(
			"app-server-id",
			expect.stringContaining('docker exec "c1"'),
		);
	});
});

// When the log is on the host the hook runs on, the output must keep streaming
// straight into the log (a redirect), exactly as before relaying existed.
describe("runDeployHook - log on the hook's own host", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);
		vi.mocked(execProcess.execAsyncRemote).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);
	});

	it("redirects into the log on a remote server with a single command", async () => {
		await runDeployHook({
			kind: "post",
			appName: "test-app",
			serverId: "app-server-id",
			command: "php artisan migrate",
			logPath: LOG_PATH,
			logServerId: "app-server-id",
			containerId: "c1",
		});

		const calls = vi.mocked(execProcess.execAsyncRemote).mock.calls;
		expect(calls).toHaveLength(1);
		const [host, command, onData] = calls[0]!;
		expect(host).toBe("app-server-id");
		expect(command).toMatch(/\) >> "\/tmp\/deploy\.log" 2>&1$/);
		// Nothing is captured in memory: the shell writes to the log directly.
		expect(onData).toBeUndefined();
		expect(execProcess.execAsyncStream).not.toHaveBeenCalled();
	});

	it.each([
		[null, null],
		[undefined, null],
		["", null],
		[null, undefined],
		[undefined, ""],
		["", undefined],
	])(
		"treats serverId=%j and logServerId=%j as the same local host",
		async (serverId, logServerId) => {
			await runDeployHook({
				kind: "post",
				appName: "test-app",
				serverId,
				command: "echo hi",
				logPath: LOG_PATH,
				logServerId,
				containerId: "c1",
			});

			expect(execProcess.execAsync).toHaveBeenCalledTimes(1);
			expect(lastLocalCommand()).toMatch(/\) >> "\/tmp\/deploy\.log" 2>&1$/);
			expect(execProcess.execAsyncRemote).not.toHaveBeenCalled();
			expect(execProcess.execAsyncStream).not.toHaveBeenCalled();
		},
	);
});

const APP_SERVER = "app-server-id";
const BUILD_SERVER = "build-server-id";

interface FakeSession {
	host: string;
	command: string;
	writes: Buffer[];
	ended: boolean;
	aborted: boolean;
}

/** SSH sessions the relay opened to the build server, in order. */
let sessions: FakeSession[] = [];

/**
 * Fake `openRemoteInputSession`. `failWrite(session, n)` can make the n-th
 * write (0-based) of the i-th session fail, as a lost connection would.
 */
const fakeSessions = (
	opts: {
		failWrite?: (sessionIndex: number, writeIndex: number) => Error | null;
		failEnd?: Error;
		// The log host never confirms: end() waits until the session is aborted.
		hangEnd?: boolean;
		// How long connecting to the log host takes.
		openDelayMs?: number;
	} = {},
) => {
	vi.mocked(execProcess.openRemoteInputSession).mockImplementation(
		async (host, command) => {
			if (opts.openDelayMs) {
				await new Promise((resolve) => setTimeout(resolve, opts.openDelayMs));
			}
			const session: FakeSession = {
				host,
				command,
				writes: [],
				ended: false,
				aborted: false,
			};
			const index = sessions.push(session) - 1;
			let abort = () => {};
			const aborted = new Promise<never>((_, reject) => {
				abort = () => reject(new Error("Remote command was aborted"));
			});
			aborted.catch(() => {});
			return {
				write: async (data: Buffer) => {
					// A failed write never reaches the log.
					const error = opts.failWrite?.(index, session.writes.length);
					if (error) throw error;
					session.writes.push(Buffer.from(data));
				},
				end: async () => {
					session.ended = true;
					if (opts.hangEnd) await aborted;
					if (opts.failEnd) throw opts.failEnd;
				},
				abort: () => {
					session.aborted = true;
					abort();
				},
			};
		},
	);
};

/** What the sessions left in the log on the build server. */
const relayedLog = () =>
	Buffer.concat(sessions.flatMap((session) => session.writes)).toString("utf8");

/** Make the hook on the app server print `chunks`, then succeed or fail. */
const hookOnAppServerPrints = (chunks: string[], failWith?: Error) => {
	vi.mocked(execProcess.execAsyncRemote).mockImplementation(
		async (host, _command, onData) => {
			if (host === APP_SERVER) {
				for (const chunk of chunks) onData?.(chunk);
				if (failWith) throw failWith;
			}
			return { stdout: "", stderr: "" };
		},
	);
};

const runRelayedHook = (
	overrides: Partial<Parameters<typeof runDeployHook>[0]> = {},
) =>
	runDeployHook({
		kind: "post",
		appName: "test-app",
		serverId: APP_SERVER,
		command: "composer install",
		logPath: LOG_PATH,
		logServerId: BUILD_SERVER,
		containerId: "c1",
		...overrides,
	});

// #221: builds on a separate server keep the deployment log there, so the
// hook's output has to be carried over from the app server.
describe("runDeployHook - log on a different host (build server)", () => {
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		sessions = [];
		fakeSessions();
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		errorSpy.mockRestore();
		vi.useRealTimers();
	});

	it("runs the hook on the app server without touching the log path there", async () => {
		hookOnAppServerPrints(["hello\n"]);

		await runRelayedHook();

		const hookCalls = vi
			.mocked(execProcess.execAsyncRemote)
			.mock.calls.filter(([host]) => host === APP_SERVER);
		expect(hookCalls).toHaveLength(1);
		const [, command, onData, options] = hookCalls[0]!;
		expect(command).toContain('docker exec "c1"');
		expect(command).toMatch(/\) 2>&1$/);
		expect(command).not.toContain(LOG_PATH);
		expect(onData).toBeTypeOf("function");
		// The relay has the output, so the exec helper must not pile it up too.
		expect(options).toEqual({ streamOnly: true });
	});

	it("relays the output, stdout and stderr alike, over one session into the log", async () => {
		hookOnAppServerPrints([
			"===== Running post-deploy hook (length=16 chars) =====\n",
			"Installing dependencies\n",
			"warning: something on stderr\n",
			"===== post-deploy hook finished =====\n",
		]);

		await runRelayedHook();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			host: BUILD_SERVER,
			command: `cat >> "${LOG_PATH}"`,
			ended: true,
		});
		expect(relayedLog()).toBe(
			"===== Running post-deploy hook (length=16 chars) =====\n" +
				"Installing dependencies\n" +
				"warning: something on stderr\n" +
				"===== post-deploy hook finished =====\n",
		);
		expect(execProcess.execAsync).not.toHaveBeenCalled();
		// Nothing is appended through one-off commands any more.
		expect(
			vi
				.mocked(execProcess.execAsyncRemote)
				.mock.calls.filter(([host]) => host === BUILD_SERVER),
		).toHaveLength(0);
	});

	it("keeps multi-byte characters intact", async () => {
		hookOnAppServerPrints(["héllo wörld ✓ 日本\n"]);

		await runRelayedHook();

		expect(relayedLog()).toBe("héllo wörld ✓ 日本\n");
	});

	it.each([
		["one 5 MiB burst", 1],
		["many small chunks", 5000],
	])(
		"uses a single connection however much output there is (%s)",
		async (_name, parts) => {
			const line = `${"x".repeat(1023)}\n`;
			const output = line.repeat(5 * 1024);
			const chunks = Array.from({ length: parts }, (_, i) =>
				output.slice(
					(i * output.length) / parts,
					((i + 1) * output.length) / parts,
				),
			);
			hookOnAppServerPrints(chunks);

			await runRelayedHook();

			expect(execProcess.openRemoteInputSession).toHaveBeenCalledTimes(1);
			expect(relayedLog()).toBe(output);
		},
	);

	it("caps relayed output and marks the log as truncated", async () => {
		const chunk = "y".repeat(1024 * 1024);
		hookOnAppServerPrints(Array.from({ length: 9 }, () => chunk));

		await runRelayedHook();

		expect(relayedLog()).toBe(
			"y".repeat(HOOK_LOG_RELAY_MAX_BYTES) + HOOK_LOG_TRUNCATION_MARKER,
		);
	});

	it("writes output to the log while a long hook is still running", async () => {
		let appendedWhileRunning = "";
		vi.mocked(execProcess.execAsyncRemote).mockImplementation(
			async (host, _command, onData) => {
				if (host === APP_SERVER) {
					onData?.("step 1 done\n");
					await vi.waitFor(() => expect(relayedLog()).not.toBe(""));
					appendedWhileRunning = relayedLog();
					onData?.("step 2 done\n");
				}
				return { stdout: "", stderr: "" };
			},
		);

		await runRelayedHook();

		expect(appendedWhileRunning).toBe("step 1 done\n");
		expect(relayedLog()).toBe("step 1 done\nstep 2 done\n");
	});

	it("restarts a lost session once, after a pause, and marks the gap in the log", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const lost = new Error("SSH connection closed before the command finished");
		fakeSessions({
			failWrite: (session, write) =>
				session === 0 && write === 1 ? lost : null,
		});
		let sessionsBeforePause = 0;
		vi.mocked(execProcess.execAsyncRemote).mockImplementation(
			async (host, _command, onData) => {
				if (host === APP_SERVER) {
					onData?.("one\n");
					await vi.advanceTimersByTimeAsync(0);
					onData?.("two\n");
					await vi.advanceTimersByTimeAsync(HOOK_LOG_RETRY_DELAY_MS - 1);
					sessionsBeforePause = sessions.length;
					await vi.advanceTimersByTimeAsync(1);
					onData?.("three\n");
				}
				return { stdout: "", stderr: "" };
			},
		);

		await expect(runRelayedHook()).resolves.toBeUndefined();

		// The restart waits instead of hammering a host that just failed.
		expect(sessionsBeforePause).toBe(1);
		expect(sessions).toHaveLength(2);
		expect(sessions[1]!.ended).toBe(true);
		expect(relayedLog()).toBe(`one\n${HOOK_LOG_RETRY_MARKER}two\nthree\n`);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("retries a connection that could not be opened without marking a gap", async () => {
		const refused = new Error("SSH connection error: connect ECONNREFUSED");
		const openSession = vi.mocked(execProcess.openRemoteInputSession);
		openSession.mockRejectedValueOnce(refused);
		hookOnAppServerPrints(["hello\n"]);

		await runRelayedHook();

		expect(openSession).toHaveBeenCalledTimes(2);
		expect(relayedLog()).toBe("hello\n");
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("rethrows a failing hook's own error after relaying its output", async () => {
		const hookError = new ExecError(
			"Remote command failed with exit code 42: boom",
			{
				command: "hook",
				stdout: "partial output\nboom\n",
				exitCode: 42,
				serverId: APP_SERVER,
			},
		);
		hookOnAppServerPrints(["partial output\n", "boom\n"], hookError);

		const result = runRelayedHook();

		await expect(result).rejects.toBe(hookError);
		// Streamed output is relayed exactly once; the error's copy is not added.
		expect(relayedLog()).toBe("partial output\nboom\n");
		expect(sessions[0]!.ended).toBe(true);
	});

	it("falls back to the error's captured output when nothing was streamed", async () => {
		const hookError = new ExecError("Command execution failed", {
			command: "hook",
			stdout: "out\n",
			stderr: "err\n",
			exitCode: 42,
		});
		hookOnAppServerPrints([], hookError);

		await expect(runRelayedHook()).rejects.toBe(hookError);
		expect(relayedLog()).toBe("out\nerr\n");
	});

	it("does not mask a failing hook's error when the log host is unreachable", async () => {
		const hookError = new ExecError("Remote command failed with exit code 42", {
			command: "hook",
			exitCode: 42,
			serverId: APP_SERVER,
		});
		const appendError = new Error("SSH connection error: build server down");
		vi.mocked(execProcess.openRemoteInputSession).mockRejectedValue(
			appendError,
		);
		hookOnAppServerPrints(["some output\n"], hookError);

		await expect(runRelayedHook()).rejects.toBe(hookError);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to relay deploy hook output"),
			appendError,
		);
	});

	it("does not fail a successful hook when the relay keeps failing", async () => {
		const appendError = new Error("SSH connection error: build server down");
		fakeSessions({ failWrite: () => appendError });
		hookOnAppServerPrints(["a\n", "b\n"]);

		await expect(runRelayedHook()).resolves.toBeUndefined();
		// One reconnect, then the relay gives up and reports it once.
		expect(execProcess.openRemoteInputSession).toHaveBeenCalledTimes(2);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to relay deploy hook output"),
			appendError,
		);
	});

	it("reports, without failing the deploy, when the log host rejects the output", async () => {
		const catFailed = new ExecError(
			"Remote command failed with exit code 1: cat: can't open '/tmp/deploy.log'",
			{ command: 'cat >> "/tmp/deploy.log"', exitCode: 1 },
		);
		fakeSessions({ failEnd: catFailed });
		hookOnAppServerPrints(["hello\n"]);

		await expect(runRelayedHook()).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to relay deploy hook output"),
			catFailed,
		);
	});

	it("gives up on a log host that never confirms instead of holding the deploy", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		fakeSessions({ hangEnd: true });
		hookOnAppServerPrints(["hello\n"]);
		let settled = false;

		const result = runRelayedHook().finally(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(HOOK_LOG_CLOSE_TIMEOUT_MS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBeUndefined();
		expect(sessions[0]!.aborted).toBe(true);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to relay deploy hook output"),
			expect.objectContaining({
				message: expect.stringContaining("waiting for the log host"),
			}),
		);
	});

	it("drops a session that opens only after the relay gave up", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		fakeSessions({ openDelayMs: HOOK_LOG_CLOSE_TIMEOUT_MS + 5_000 });
		hookOnAppServerPrints(["hello\n"]);

		const result = runRelayedHook();
		await vi.advanceTimersByTimeAsync(HOOK_LOG_CLOSE_TIMEOUT_MS);
		await expect(result).resolves.toBeUndefined();
		await vi.advanceTimersByTimeAsync(5_000);

		// Nothing reaches the log after runDeployHook returned.
		expect(sessions).toHaveLength(1);
		expect(sessions[0]!.aborted).toBe(true);
		expect(relayedLog()).toBe("");
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it("runs a local hook through the streaming exec when the log is remote", async () => {
		vi.mocked(execProcess.execAsyncStream).mockImplementation(
			async (_command, onData) => {
				onData?.("local hook output\n");
				return { stdout: "", stderr: "" };
			},
		);

		await runRelayedHook({ serverId: null });

		const [command, , options] = vi.mocked(execProcess.execAsyncStream).mock
			.calls[0]!;
		expect(command).toContain('docker exec "c1"');
		expect(command).not.toContain(LOG_PATH);
		// Stream-only: no maxBuffer that would kill a chatty hook, and the output
		// is not kept a second time in memory.
		expect(options).toEqual({ streamOnly: true });
		expect(execProcess.execAsync).not.toHaveBeenCalled();
		expect(relayedLog()).toBe("local hook output\n");
	});

	describe("with the log on the Dokploy host", () => {
		let dir: string;
		let logPath: string;

		beforeEach(() => {
			dir = mkdtempSync(path.join(tmpdir(), "deploy-hook-relay-"));
			logPath = path.join(dir, "deploy.log");
			writeFileSync(logPath, "Initializing deployment\n");
		});

		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		it("appends a remote hook's output to the local log file", async () => {
			const big = "z".repeat(300 * 1024);
			hookOnAppServerPrints(["remote output\n", big]);

			await runRelayedHook({ logPath, logServerId: null });

			expect(readFileSync(logPath, "utf8")).toBe(
				`Initializing deployment\nremote output\n${big}`,
			);
			// No shell is involved, so there is no command size to worry about.
			expect(execProcess.execAsync).not.toHaveBeenCalled();
		});
	});
});
