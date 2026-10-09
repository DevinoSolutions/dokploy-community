import { getSafeRegistryLoginCommand } from "@dokploy/server/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

import {
	dockerWithConfig,
	getRegistryConfigDir,
} from "@dokploy/server/utils/process/dockerConfig";
import { runDockerLogin } from "@dokploy/server/utils/process/dockerLogin";

const PASSWORD = "p@ss'w0rd; $(touch /tmp/pwned)";

describe("getSafeRegistryLoginCommand", () => {
	it("keeps the password out of the command and returns it as stdin", () => {
		const login = getSafeRegistryLoginCommand({
			registryType: "cloud",
			registryUrl: "registry.example.com",
			username: "acme",
			password: PASSWORD,
		});

		expect(login.command).toBe(
			"docker login 'registry.example.com' -u 'acme' --password-stdin",
		);
		expect(login.stdin).toBe(PASSWORD);
		expect(login.command).not.toContain("p@ss");
		expect(login.command).not.toContain("printf");
	});

	it("uses the ECR token, not the registry password, for ECR", () => {
		const login = getSafeRegistryLoginCommand({
			registryType: "awsEcr",
			registryUrl: "123.dkr.ecr.us-east-1.amazonaws.com",
			username: "ignored",
			password: "ignored",
			ecrAuthPassword: "ecr-token",
		});

		expect(login.command).toBe(
			"docker login --username AWS --password-stdin '123.dkr.ecr.us-east-1.amazonaws.com'",
		);
		expect(login.stdin).toBe("ecr-token");
	});

	it("quotes the url and the user so they cannot break out of the command", () => {
		const { command } = getSafeRegistryLoginCommand({
			registryType: "selfHosted",
			registryUrl: "reg.example.com'; touch /tmp/pwned; '",
			username: "$(touch /tmp/pwned)",
			password: "x",
		});

		expect(command).toBe(
			"docker login 'reg.example.com'\\''; touch /tmp/pwned; '\\''' -u '$(touch /tmp/pwned)' --password-stdin",
		);
	});

	it("sends an empty stdin when there is no password", () => {
		const { stdin } = getSafeRegistryLoginCommand({
			registryType: "cloud",
			registryUrl: "registry.example.com",
			username: "acme",
		});
		expect(stdin).toBe("");
	});
});

describe("runDockerLogin", () => {
	const data = {
		registryType: "cloud",
		registryUrl: "registry.example.com",
		username: "acme",
		password: PASSWORD,
	} as const;

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	});

	it("runs locally with the password on stdin", async () => {
		await runDockerLogin(data);

		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		const [command, options] = mocks.execAsync.mock.calls[0]!;
		expect(command).not.toContain("p@ss");
		expect(options).toEqual({ stdin: PASSWORD });
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("runs on the server with the password on stdin", async () => {
		await runDockerLogin(data, "srv-1");

		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		const [serverId, command, onData, options] =
			mocks.execAsyncRemote.mock.calls[0]!;
		expect(serverId).toBe("srv-1");
		expect(command).not.toContain("p@ss");
		expect(onData).toBeUndefined();
		expect(options).toEqual({ stdin: PASSWORD });
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("passes a failed login on to the caller", async () => {
		mocks.execAsyncRemote.mockRejectedValue(new Error("unauthorized"));
		await expect(runDockerLogin(data, "srv-1")).rejects.toThrow("unauthorized");
	});
});

describe("per-registry docker config", () => {
	const data = {
		registryType: "cloud" as const,
		registryUrl: "registry.example.com",
		username: "acme",
		password: PASSWORD,
	};

	it("logs in to the given directory, created private, with the password still on stdin", () => {
		const login = getSafeRegistryLoginCommand({
			...data,
			configDir: "/etc/dokploy/docker-config/reg-1",
		});

		expect(login.command).toBe(
			"umask 077 && mkdir -p '/etc/dokploy/docker-config/reg-1' && docker --config '/etc/dokploy/docker-config/reg-1' login 'registry.example.com' -u 'acme' --password-stdin",
		);
		expect(login.stdin).toBe(PASSWORD);
		expect(login.command).not.toContain("p@ss");
	});

	it("derives a directory per registry id and refuses ids that could escape it", () => {
		expect(getRegistryConfigDir("reg-1", true)).toBe(
			"/etc/dokploy/docker-config/reg-1",
		);
		expect(getRegistryConfigDir("reg-2", true)).not.toBe(
			getRegistryConfigDir("reg-1", true),
		);
		expect(() => getRegistryConfigDir("../x; rm -rf /", true)).toThrow(
			"Invalid registry id",
		);
	});

	it("builds docker commands for a config directory, or plain docker without one", () => {
		expect(dockerWithConfig("/etc/dokploy/docker-config/reg-1")).toBe(
			"docker --config /etc/dokploy/docker-config/reg-1",
		);
		expect(dockerWithConfig(undefined)).toBe("docker");
	});

	it("hands a cancel target to the remote login", async () => {
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		const cancelable = { pidFile: "/p.pid", deploymentId: "dep1" };

		await runDockerLogin(data, "srv-1", { cancelable });

		expect(mocks.execAsyncRemote.mock.calls.at(-1)?.[3]).toEqual({
			stdin: PASSWORD,
			cancelable,
		});
	});
});
