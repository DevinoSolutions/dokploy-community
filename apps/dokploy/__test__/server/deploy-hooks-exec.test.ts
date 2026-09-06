import { runDeployHook } from "@dokploy/server/utils/docker/hooks";
import * as dockerUtils from "@dokploy/server/utils/docker/utils";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
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
			});
		}

		expect(execProcess.execAsync).not.toHaveBeenCalled();
		expect(execProcess.execAsyncRemote).not.toHaveBeenCalled();
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
		});

		expect(lastLocalCommand()).toContain("skipping pre-deploy hook");
		expect(lastLocalCommand()).not.toContain("docker exec");
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
			containerId: "c1",
		});

		expect(execProcess.execAsync).not.toHaveBeenCalled();
		expect(execProcess.execAsyncRemote).toHaveBeenCalledWith(
			"app-server-id",
			expect.stringContaining('docker exec "c1"'),
		);
	});
});
