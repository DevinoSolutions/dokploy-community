import {
	backupCurrentDeployment,
	didRollbackSucceed,
} from "@dokploy/server/services/compose";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { PRE_DEPLOY_COMPOSE_BAK } from "@dokploy/server/utils/builders/compose";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	return {
		...actual,
		execAsync: vi.fn(),
		execAsyncRemote: vi.fn(),
	};
});

const local = {
	appName: "my-app",
	sourceType: "github",
	composePath: "./docker-compose.yml",
	serverId: null,
};
const remote = { ...local, serverId: "srv_1" };

const mockedExecAsync = vi.mocked(execAsync);
const mockedExecAsyncRemote = vi.mocked(execAsyncRemote);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("didRollbackSucceed", () => {
	it("reports the service as still live when the marker is present", async () => {
		mockedExecAsync.mockResolvedValue({ stdout: "LIVE_OK\n", stderr: "" } as any);

		await expect(
			didRollbackSucceed(local as any, "/var/log/dep.log", "dep_123"),
		).resolves.toBe(true);
	});

	it("reports the service as broken when the marker is missing", async () => {
		mockedExecAsync.mockResolvedValue({
			stdout: "LIVE_FAILED\n",
			stderr: "",
		} as any);

		await expect(
			didRollbackSucceed(local as any, "/var/log/dep.log", "dep_123"),
		).resolves.toBe(false);
	});

	it("fails closed when the probe itself cannot run", async () => {
		mockedExecAsync.mockRejectedValue(new Error("ssh down"));

		await expect(
			didRollbackSucceed(local as any, "/var/log/dep.log", "dep_123"),
		).resolves.toBe(false);
	});

	it("greps the log on the remote server for remote services", async () => {
		mockedExecAsyncRemote.mockResolvedValue({
			stdout: "LIVE_OK",
			stderr: "",
		} as any);

		await expect(
			didRollbackSucceed(remote as any, "/var/log/dep.log", "dep_123"),
		).resolves.toBe(true);
		expect(mockedExecAsync).not.toHaveBeenCalled();
		expect(mockedExecAsyncRemote).toHaveBeenCalledWith(
			"srv_1",
			expect.stringContaining("dep_123"),
		);
	});
});

describe("backupCurrentDeployment", () => {
	it("appends the snapshot output to the deployment log", async () => {
		mockedExecAsync.mockResolvedValue({ stdout: "", stderr: "" } as any);

		await backupCurrentDeployment(local as any, "/var/log/dep.log");

		const command = mockedExecAsync.mock.calls[0]?.[0] as string;
		expect(command).toContain(">> /var/log/dep.log 2>&1");
		expect(command).toContain(PRE_DEPLOY_COMPOSE_BAK);
	});

	it("runs on the remote server for remote services", async () => {
		mockedExecAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" } as any);

		await backupCurrentDeployment(remote as any, "/var/log/dep.log");

		expect(mockedExecAsync).not.toHaveBeenCalled();
		expect(mockedExecAsyncRemote).toHaveBeenCalledWith(
			"srv_1",
			expect.stringContaining(PRE_DEPLOY_COMPOSE_BAK),
		);
	});

	it("propagates a snapshot failure so the deploy aborts before mutating code/", async () => {
		mockedExecAsync.mockRejectedValue(new Error("disk full"));

		await expect(
			backupCurrentDeployment(local as any, "/var/log/dep.log"),
		).rejects.toThrow("disk full");
	});
});
