import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The watchdog's host and database access: how log idleness is read (a local
 * file's mtime, a remote file's mtime against the remote clock), and how the
 * row is closed without overwriting a failure the deploy flow already
 * recorded.
 */

const mocks = vi.hoisted(() => ({
	stat: vi.fn(),
	execAsyncRemote: vi.fn(),
	resolveDeploymentLogHost: vi.fn(),
	updateRows: [] as Array<{ set: unknown; returned: unknown[] }>,
	returnQueue: [] as unknown[][],
	sendBuildErrorNotifications: vi.fn(),
	getDeploymentErrorMessage: vi.fn(),
	restoreServiceStatusIfUnchanged: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ stat: mocks.stat }));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: mocks.execAsyncRemote,
}));
vi.mock("@dokploy/server/services/deployment-log-host", () => ({
	resolveDeploymentLogHost: mocks.resolveDeploymentLogHost,
}));
vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: vi.fn(async () => "https://dokploy.test"),
}));
vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: vi.fn(),
}));
vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: vi.fn(),
}));
vi.mock("@dokploy/server/services/preview-deployment", () => ({
	findPreviewDeploymentById: vi.fn(),
}));
vi.mock("@dokploy/server/services/deployment-cancel", () => ({
	restoreServiceStatusIfUnchanged: mocks.restoreServiceStatusIfUnchanged,
}));
vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: mocks.sendBuildErrorNotifications,
}));
vi.mock("@dokploy/server/services/deployment", () => ({
	getDeploymentErrorMessage: mocks.getDeploymentErrorMessage,
}));
vi.mock("@dokploy/server/db", () => ({
	db: {
		update: () => ({
			set: (set: unknown) => ({
				where: () => ({
					returning: () => {
						const returned = mocks.returnQueue.shift() ?? [];
						mocks.updateRows.push({ set, returned });
						return Promise.resolve(returned);
					},
					// The second statement of markDeploymentFailedByWatchdog is awaited
					// without .returning().
					// biome-ignore lint/suspicious/noThenProperty: a thenable stands in for the query builder
					then: (resolve: (value: unknown) => void) => {
						mocks.updateRows.push({ set, returned: [] });
						resolve([]);
					},
				}),
			}),
		}),
		query: { deployments: { findMany: vi.fn(async () => []) } },
	},
}));

import {
	markDeploymentFailedByWatchdog,
	readLogIdleMs,
	sendWatchdogFailureNotification,
} from "@dokploy/server/services/deployment-watchdog";

const base = {
	logPath: "/etc/dokploy/logs/app/app-2026.log",
	serverId: null as string | null,
	buildServerId: null as string | null,
	previewDeploymentId: null as string | null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.updateRows.length = 0;
	mocks.returnQueue.length = 0;
	mocks.resolveDeploymentLogHost.mockResolvedValue(null);
});

describe("readLogIdleMs on the Dokploy host", () => {
	it("is the time since the log file last changed", async () => {
		mocks.stat.mockResolvedValue({ mtimeMs: 1_000_000 });

		const idle = await readLogIdleMs(base, () => 1_000_000 + 25 * 60_000);

		expect(idle).toBe(25 * 60_000);
		expect(mocks.stat).toHaveBeenCalledWith(base.logPath);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("never goes negative when the clock moved", async () => {
		mocks.stat.mockResolvedValue({ mtimeMs: 2_000_000 });

		expect(await readLogIdleMs(base, () => 1_000_000)).toBe(0);
	});

	it("is unknown when the log is gone", async () => {
		mocks.stat.mockRejectedValue(new Error("ENOENT"));

		expect(await readLogIdleMs(base)).toBeNull();
	});

	it("is unknown for a row with no log path", async () => {
		expect(await readLogIdleMs({ ...base, logPath: "" })).toBeNull();
		expect(await readLogIdleMs({ ...base, logPath: "." })).toBeNull();
		expect(mocks.stat).not.toHaveBeenCalled();
	});
});

describe("readLogIdleMs on a remote log host", () => {
	it("asks the host that holds the log, and compares with that host's clock", async () => {
		mocks.resolveDeploymentLogHost.mockResolvedValue("srv-build");
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "1700000000\n1700001500\n",
			stderr: "",
		});

		const idle = await readLogIdleMs({ ...base, buildServerId: "srv-build" });

		expect(idle).toBe(1500 * 1000);
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		const [serverId, command] = mocks.execAsyncRemote.mock.calls[0] as [
			string,
			string,
		];
		expect(serverId).toBe("srv-build");
		expect(command).toContain("stat -c %Y");
		expect(command).toContain("date +%s");
		expect(mocks.stat).not.toHaveBeenCalled();
	});

	it("quotes the log path", async () => {
		mocks.resolveDeploymentLogHost.mockResolvedValue("srv-1");
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "1\n2\n",
			stderr: "",
		});

		await readLogIdleMs({ ...base, logPath: "/logs/a b; rm -rf x.log" });

		const command = (mocks.execAsyncRemote.mock.calls[0] as string[])[1];
		expect(command).toContain("'/logs/a b; rm -rf x.log'");
	});

	it("skips a login banner before the answer", async () => {
		mocks.resolveDeploymentLogHost.mockResolvedValue("srv-1");
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "Welcome to Ubuntu 22.04\nLast login: 12\n100\n400\n",
			stderr: "",
		});

		expect(await readLogIdleMs(base)).toBe(300_000);
	});

	it("is unknown when the host cannot be reached", async () => {
		mocks.resolveDeploymentLogHost.mockResolvedValue("srv-1");
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh: timeout"));

		expect(await readLogIdleMs(base)).toBeNull();
	});

	it("is unknown when the answer is not two numbers", async () => {
		mocks.resolveDeploymentLogHost.mockResolvedValue("srv-1");
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "garbage", stderr: "" });

		expect(await readLogIdleMs(base)).toBeNull();
	});

	it("is unknown when the log host cannot be told", async () => {
		mocks.resolveDeploymentLogHost.mockResolvedValue(undefined);

		expect(await readLogIdleMs(base)).toBeNull();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.stat).not.toHaveBeenCalled();
	});
});

describe("markDeploymentFailedByWatchdog", () => {
	it("sets error with the reason and a finish time on a row that was running", async () => {
		mocks.returnQueue.push([{ deploymentId: "dep-1" }]);

		const changed = await markDeploymentFailedByWatchdog(
			"dep-1",
			"Watchdog: exceeded 90 min",
		);

		expect(changed).toBe(true);
		expect(mocks.updateRows).toHaveLength(1);
		expect(mocks.updateRows[0]?.set).toMatchObject({
			status: "error",
			errorMessage: "Watchdog: exceeded 90 min",
			finishedAt: expect.any(String),
		});
	});

	it("only adds the reason to a row the deploy flow already failed", async () => {
		mocks.returnQueue.push([]);

		const changed = await markDeploymentFailedByWatchdog("dep-1", "reason");

		expect(changed).toBe(false);
		expect(mocks.updateRows).toHaveLength(2);
		// The second statement does not touch status or the finish time.
		expect(mocks.updateRows[1]?.set).toEqual({ errorMessage: "reason" });
	});
});

describe("sendWatchdogFailureNotification", () => {
	const context = {
		organizationId: "org-1",
		serviceName: "My App",
		appName: "app-abc123",
		projectName: "Proj",
		serviceType: "application" as const,
		serviceId: "app-1",
		buildLink: "https://dokploy.test/x",
	};

	it("sends the existing deployment-failed notification with the end of the log", async () => {
		mocks.getDeploymentErrorMessage.mockResolvedValue(
			"...Watchdog: marked failed",
		);

		await sendWatchdogFailureNotification(
			{ logPath: "/l.log" },
			"srv-build",
			context,
			"fallback",
		);

		expect(mocks.getDeploymentErrorMessage).toHaveBeenCalledWith({
			logPath: "/l.log",
			serverId: "srv-build",
			fallback: "fallback",
		});
		expect(mocks.sendBuildErrorNotifications).toHaveBeenCalledWith({
			projectName: "Proj",
			applicationName: "My App",
			applicationType: "application",
			serviceId: "app-1",
			errorMessage: "...Watchdog: marked failed",
			buildLink: "https://dokploy.test/x",
			organizationId: "org-1",
		});
	});

	it("never throws", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.getDeploymentErrorMessage.mockResolvedValue("x");
		mocks.sendBuildErrorNotifications.mockRejectedValue(new Error("smtp down"));

		await expect(
			sendWatchdogFailureNotification(
				{ logPath: "/l.log" },
				null,
				context,
				"fallback",
			),
		).resolves.toBeUndefined();
	});
});
