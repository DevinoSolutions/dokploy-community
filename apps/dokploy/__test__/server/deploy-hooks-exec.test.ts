import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	HOOK_LOG_APPEND_CHUNK_BYTES,
	HOOK_LOG_FLUSH_INTERVAL_MS,
	HOOK_LOG_RELAY_MAX_BYTES,
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
const APPEND_RE = /^echo "([A-Za-z0-9+/=]*)" \| base64 -d >> "([^"]*)"$/;

/** The `execAsyncRemote` calls that append to the log on the build server. */
const appendCalls = () =>
	vi
		.mocked(execProcess.execAsyncRemote)
		.mock.calls.filter(([host]) => host === BUILD_SERVER)
		.map(([, command]) => String(command));

/** What the append commands would leave in the remote log, decoded. */
const relayedLog = () =>
	Buffer.concat(
		appendCalls().map((command) => {
			const match = APPEND_RE.exec(command);
			expect(match, `unexpected append command: ${command}`).not.toBeNull();
			expect(match![2]).toBe(LOG_PATH);
			return Buffer.from(match![1]!, "base64");
		}),
	).toString("utf8");

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
		const [, command, onData] = hookCalls[0]!;
		expect(command).toContain('docker exec "c1"');
		expect(command).toMatch(/\) 2>&1$/);
		expect(command).not.toContain(LOG_PATH);
		expect(onData).toBeTypeOf("function");
	});

	it("relays the output, stdout and stderr alike, to the log on the build server", async () => {
		hookOnAppServerPrints([
			"===== Running post-deploy hook (length=16 chars) =====\n",
			"Installing dependencies\n",
			"warning: something on stderr\n",
			"===== post-deploy hook finished =====\n",
		]);

		await runRelayedHook();

		expect(relayedLog()).toBe(
			"===== Running post-deploy hook (length=16 chars) =====\n" +
				"Installing dependencies\n" +
				"warning: something on stderr\n" +
				"===== post-deploy hook finished =====\n",
		);
		expect(execProcess.execAsync).not.toHaveBeenCalled();
	});

	it("keeps multi-byte characters intact", async () => {
		hookOnAppServerPrints(["héllo wörld ✓ 日本\n"]);

		await runRelayedHook();

		expect(relayedLog()).toBe("héllo wörld ✓ 日本\n");
	});

	it.each([
		["one 300 KiB burst", 1],
		["many small chunks", 300],
	])(
		"appends 300 KiB of output in bounded chunks (%s)",
		async (_name, parts) => {
			const line = `${"x".repeat(1023)}\n`;
			const output = line.repeat(300);
			const chunks = Array.from({ length: parts }, (_, i) =>
				output.slice(
					(i * output.length) / parts,
					((i + 1) * output.length) / parts,
				),
			);
			hookOnAppServerPrints(chunks);

			await runRelayedHook();

			const commands = appendCalls();
			// A single `echo "<base64>"` of 300 KiB would be ~400 KiB, over both
			// MAX_ARG_STRLEN (128 KiB) and OpenSSH's request limits.
			expect(commands.length).toBeGreaterThanOrEqual(
				Math.ceil(output.length / HOOK_LOG_APPEND_CHUNK_BYTES),
			);
			for (const command of commands) {
				expect(command.length).toBeLessThan(64 * 1024);
			}
			expect(relayedLog()).toBe(output);
		},
	);

	it("caps relayed output and marks the log as truncated", async () => {
		const chunk = "y".repeat(1024 * 1024);
		hookOnAppServerPrints(Array.from({ length: 9 }, () => chunk));

		await runRelayedHook();

		const log = relayedLog();
		expect(log).toBe(
			"y".repeat(HOOK_LOG_RELAY_MAX_BYTES) + HOOK_LOG_TRUNCATION_MARKER,
		);
		for (const command of appendCalls()) {
			expect(command.length).toBeLessThan(64 * 1024);
		}
	});

	it("flushes output while a long hook is still running", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let appendedWhileRunning = "";
		vi.mocked(execProcess.execAsyncRemote).mockImplementation(
			async (host, _command, onData) => {
				if (host === APP_SERVER) {
					onData?.("step 1 done\n");
					await vi.advanceTimersByTimeAsync(HOOK_LOG_FLUSH_INTERVAL_MS);
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

	it("does not mask a failing hook's error when the log append also fails", async () => {
		const hookError = new ExecError("Remote command failed with exit code 42", {
			command: "hook",
			exitCode: 42,
			serverId: APP_SERVER,
		});
		const appendError = new Error("SSH connection error: build server down");
		vi.mocked(execProcess.execAsyncRemote).mockImplementation(
			async (host, _command, onData) => {
				if (host === APP_SERVER) {
					onData?.("some output\n");
					throw hookError;
				}
				throw appendError;
			},
		);

		await expect(runRelayedHook()).rejects.toBe(hookError);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to relay deploy hook output"),
			appendError,
		);
	});

	it("does not fail a successful hook when the log append fails", async () => {
		const appendError = new Error("SSH connection error: build server down");
		vi.mocked(execProcess.execAsyncRemote).mockImplementation(
			async (host, _command, onData) => {
				if (host === APP_SERVER) {
					// Two flushes' worth: the relay must stop after the first failure.
					onData?.("a".repeat(HOOK_LOG_APPEND_CHUNK_BYTES));
					onData?.("b".repeat(HOOK_LOG_APPEND_CHUNK_BYTES));
					return { stdout: "", stderr: "" };
				}
				throw appendError;
			},
		);

		await expect(runRelayedHook()).resolves.toBeUndefined();
		expect(appendCalls()).toHaveLength(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it("runs a local hook through the streaming exec when the log is remote", async () => {
		vi.mocked(execProcess.execAsyncStream).mockImplementation(
			async (_command, onData) => {
				onData?.("local hook output\n");
				return { stdout: "", stderr: "" };
			},
		);
		vi.mocked(execProcess.execAsyncRemote).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);

		await runRelayedHook({ serverId: null });

		const [command, , options] = vi.mocked(execProcess.execAsyncStream).mock
			.calls[0]!;
		expect(command).toContain('docker exec "c1"');
		expect(command).not.toContain(LOG_PATH);
		// exec's 1 MiB default would kill a chatty hook that used to succeed.
		expect(options?.maxBuffer).toBeGreaterThan(1024 * 1024);
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
