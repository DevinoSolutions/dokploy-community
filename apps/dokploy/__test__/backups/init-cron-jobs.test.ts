import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findRoot: vi.fn(),
	findBackups: vi.fn(),
	getAllServers: vi.fn(),
	scheduleDockerCleanup: vi.fn(),
	scheduleBackup: vi.fn(),
	startLogCleanup: vi.fn(),
	sendDockerCleanupNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			organization: { findFirst: mocks.findRoot },
			backups: { findMany: mocks.findBackups },
		},
	},
}));

vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: vi.fn(async () => ({
		enableDockerCleanup: true,
		dockerCleanupCron: "0 4 * * *",
		logCleanupCron: "0 0 * * *",
	})),
}));

vi.mock("@dokploy/server/services/server", () => ({
	getAllServers: mocks.getAllServers,
}));

vi.mock("@dokploy/server/utils/access-log/handler", () => ({
	startLogCleanup: mocks.startLogCleanup,
}));

// The fork schedules cleanups through scheduleDockerCleanup (UTC cron, deploy
// guard); its afterCleanup hook is what sends the notification.
vi.mock("@dokploy/server/utils/docker/cleanup-job", () => ({
	WEB_SERVER_CLEANUP_JOB: "docker-cleanup",
	scheduleDockerCleanup: mocks.scheduleDockerCleanup,
}));

vi.mock("@dokploy/server/utils/backups/utils", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/backups/utils")
	>()),
	scheduleBackup: mocks.scheduleBackup,
}));

vi.mock("@dokploy/server/utils/notifications/docker-cleanup", () => ({
	sendDockerCleanupNotifications: mocks.sendDockerCleanupNotifications,
}));

import { initCronJobs } from "@dokploy/server/utils/backups";

type CleanupInput = { jobName: string; afterCleanup?: () => Promise<unknown> };

const afterCleanupOf = (jobName: string) => {
	const call = mocks.scheduleDockerCleanup.mock.calls.find(
		([input]) => (input as CleanupInput).jobName === jobName,
	);
	return (call?.[0] as CleanupInput | undefined)?.afterCleanup;
};

describe("initCronJobs (#5403)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.stubEnv("DOKPLOY_ROOT_ORGANIZATION_ID", "");
		mocks.findBackups.mockResolvedValue([]);
		mocks.getAllServers.mockResolvedValue([]);
	});

	it("registers docker and log cleanup before the root organization exists", async () => {
		mocks.findRoot.mockResolvedValue(undefined);

		await initCronJobs();

		expect(mocks.scheduleDockerCleanup).toHaveBeenCalledWith(
			expect.objectContaining({
				jobName: "docker-cleanup",
				cron: "0 4 * * *",
			}),
		);
		expect(mocks.startLogCleanup).toHaveBeenCalledWith("0 0 * * *");
	});

	it("registers enabled backups before the root organization exists", async () => {
		mocks.findRoot.mockResolvedValue(undefined);
		const backup = { enabled: true, databaseType: "postgres", schedule: "x" };
		mocks.findBackups.mockResolvedValue([backup]);

		await initCronJobs();

		expect(mocks.scheduleBackup).toHaveBeenCalledWith(backup);
	});

	it("notifies the root organization when the cleanup runs", async () => {
		mocks.findRoot.mockResolvedValue(undefined);
		await initCronJobs();
		const afterCleanup = afterCleanupOf("docker-cleanup");

		mocks.findRoot.mockResolvedValue({ id: "org-1", name: "One" });
		await afterCleanup?.();

		expect(mocks.sendDockerCleanupNotifications).toHaveBeenCalledWith("org-1");
	});

	it("skips the notification while no organization owns the instance", async () => {
		mocks.findRoot.mockResolvedValue(undefined);
		await initCronJobs();

		await afterCleanupOf("docker-cleanup")?.();

		expect(mocks.sendDockerCleanupNotifications).not.toHaveBeenCalled();
	});

	it("notifies a remote server's own organization", async () => {
		mocks.findRoot.mockResolvedValue(undefined);
		mocks.getAllServers.mockResolvedValue([
			{
				serverId: "srv-1",
				name: "one",
				enableDockerCleanup: true,
				dockerCleanupCron: "0 5 * * *",
				organizationId: "org-2",
			},
		]);
		await initCronJobs();

		await afterCleanupOf("srv-1")?.();

		expect(mocks.sendDockerCleanupNotifications).toHaveBeenCalledWith(
			"org-2",
			"Docker cleanup for Server one (srv-1)",
		);
	});
});
