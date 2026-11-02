import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dbSet: vi.fn(),
	dbWhere: vi.fn(),
	released: vi.fn(() => false),
}));

vi.mock("@dokploy/server/db", () => {
	const chain: any = {
		set: vi.fn((values: unknown) => {
			mocks.dbSet(values);
			return chain;
		}),
		where: vi.fn((condition: unknown) => {
			mocks.dbWhere(condition);
			return Promise.resolve([{}]);
		}),
	};
	return { db: { update: vi.fn(() => chain) } };
});

vi.mock("@dokploy/server/utils/process/execAsync", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/process/execAsync")
	>("@dokploy/server/utils/process/execAsync");
	return { ...actual, execAsync: vi.fn(), execAsyncRemote: vi.fn() };
});

vi.mock("@dokploy/server/utils/process/job-context", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/process/job-context")
	>("@dokploy/server/utils/process/job-context");
	return {
		...actual,
		skipWriteOfReleasedJob: (what: string, deploymentId?: string) =>
			mocks.released() || actual.skipWriteOfReleasedJob(what, deploymentId),
	};
});

import { writeDeploymentErrorLog } from "@dokploy/server/services/deployment";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";

const deployment = {
	deploymentId: "deployment-1",
	logPath: "/etc/dokploy/logs/app-abc/app-abc.log",
};

const keepaliveTimeout = () =>
	new ExecError("SSH connection error: Keepalive timeout", {
		command: "docker build .",
		serverId: "server-1",
		originalError: new Error("Keepalive timeout"),
	});

describe("writeDeploymentErrorLog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.released.mockReturnValue(false);
	});

	it("writes the error text and the closing line on the local host", async () => {
		await writeDeploymentErrorLog(
			deployment,
			null,
			new Error("clone failed"),
		);

		expect(execAsyncRemote).not.toHaveBeenCalled();
		const command = vi.mocked(execAsync).mock.calls[0]![0];
		expect(command).toContain("base64 -d");
		expect(command).toContain("Error occurred");
		expect(command).toContain(deployment.logPath);
		expect(mocks.dbSet).not.toHaveBeenCalled();
	});

	it("writes through the server when the deployment lives on one", async () => {
		await writeDeploymentErrorLog(
			deployment,
			"server-1",
			new Error("clone failed"),
		);

		expect(execAsync).not.toHaveBeenCalled();
		expect(execAsyncRemote).toHaveBeenCalledWith(
			"server-1",
			expect.stringContaining("Error occurred"),
		);
	});

	it("skips the error text for ExecError and keeps extra lines before the closing one", async () => {
		await writeDeploymentErrorLog(
			deployment,
			null,
			new ExecError("Command failed", { command: "docker build .", exitCode: 1 }),
			"echo extra-line;",
		);

		const command = vi.mocked(execAsync).mock.calls[0]![0];
		expect(command).not.toContain("base64 -d");
		expect(command.indexOf("extra-line")).toBeGreaterThanOrEqual(0);
		expect(command.indexOf("extra-line")).toBeLessThan(
			command.indexOf("Error occurred"),
		);
	});

	it("does not throw and stores the reason when the server cannot be reached", async () => {
		vi.mocked(execAsyncRemote).mockRejectedValue(keepaliveTimeout());

		await expect(
			writeDeploymentErrorLog(deployment, "server-1", keepaliveTimeout()),
		).resolves.toBeUndefined();

		expect(mocks.dbSet).toHaveBeenCalledWith({
			errorMessage: "SSH connection error: Keepalive timeout",
		});
	});

	it("leaves a deployment the watchdog released alone", async () => {
		vi.mocked(execAsyncRemote).mockRejectedValue(keepaliveTimeout());
		mocks.released.mockReturnValue(true);

		await expect(
			writeDeploymentErrorLog(deployment, "server-1", keepaliveTimeout()),
		).resolves.toBeUndefined();

		expect(mocks.dbSet).not.toHaveBeenCalled();
	});

	it("never lets a failing row update hide the deploy error", async () => {
		vi.mocked(execAsyncRemote).mockRejectedValue(keepaliveTimeout());
		mocks.dbWhere.mockImplementationOnce(() => {
			throw new Error("db down");
		});

		await expect(
			writeDeploymentErrorLog(deployment, "server-1", keepaliveTimeout()),
		).resolves.toBeUndefined();
	});
});
