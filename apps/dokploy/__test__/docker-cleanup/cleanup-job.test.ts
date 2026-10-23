import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-7344: the cleanup job is scheduled in UTC from the host's
 * `dockerCleanupCron`, replaces the previous job when the schedule changes, and
 * every path (boot, updateDockerCleanup, server create/update) goes through
 * the idle guard.
 */

type FakeJob = { name: string; cancel: ReturnType<typeof vi.fn> };

const mocks = vi.hoisted(() => ({
	scheduledJobs: {} as Record<string, unknown>,
	scheduleJob: vi.fn(),
	cleanupAll: vi.fn(),
	sendDockerCleanupNotifications: vi.fn(),
	findServerById: vi.fn(),
	updateServerById: vi.fn(),
	updateWebServerSettings: vi.fn(),
	getWebServerSettings: vi.fn(),
	getAllServers: vi.fn(),
	runningRows: vi.fn(),
	queueJobs: vi.fn(),
	cloudSchedule: vi.fn(),
	cloudRemove: vi.fn(),
	findOwner: vi.fn(),
}));

vi.mock("node-schedule", () => ({
	scheduledJobs: mocks.scheduledJobs,
	scheduleJob: mocks.scheduleJob,
}));

vi.mock("@dokploy/server", async () => {
	const background = await import("@dokploy/server/utils/process/background");
	return {
		...background,
		CLEANUP_CRON_JOB: "50 23 * * *",
		IS_CLOUD: false,
		findServerById: mocks.findServerById,
		updateServerById: mocks.updateServerById,
		updateWebServerSettings: mocks.updateWebServerSettings,
		sendDockerCleanupNotifications: mocks.sendDockerCleanupNotifications,
	};
});

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	cleanupAll: mocks.cleanupAll,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			deployments: { findMany: mocks.runningRows },
			applications: { findMany: async () => [] },
			compose: { findMany: async () => [] },
			member: { findFirst: mocks.findOwner },
		},
	},
}));

vi.mock("@dokploy/server/services/deployment-queue-journal", () => ({
	listQueueJobs: mocks.queueJobs,
}));

vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: mocks.getWebServerSettings,
}));

vi.mock("@dokploy/server/services/server", () => ({
	getAllServers: mocks.getAllServers,
	getAccessibleServerIds: vi.fn(),
}));

vi.mock("@dokploy/server/services/backup", () => ({}));
vi.mock("@dokploy/server/services/destination", () => ({
	findDestinationById: vi.fn(),
}));
vi.mock("@dokploy/server/utils/backups/utils", () => ({
	getRclonePathAndFlags: vi.fn(),
	normalizeS3Path: vi.fn(),
	scheduleBackup: vi.fn(),
}));
vi.mock("@dokploy/server/utils/access-log/handler", () => ({
	startLogCleanup: vi.fn(),
}));
vi.mock("@dokploy/server/utils/notifications/docker-cleanup", () => ({
	sendDockerCleanupNotifications: mocks.sendDockerCleanupNotifications,
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
}));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));
vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: vi.fn(),
}));
vi.mock("@/server/utils/backup", () => ({
	schedule: mocks.cloudSchedule,
	removeJob: mocks.cloudRemove,
}));

import {
	cancelDockerCleanup,
	scheduleDockerCleanup,
	WEB_SERVER_CLEANUP_JOB,
} from "@dokploy/server/utils/docker/cleanup-job";
import { initCronJobs } from "@dokploy/server/utils/backups/index";
import { applyDockerCleanupSchedule } from "@/server/utils/docker-cleanup";

const { settingsRouter } = await import("@/server/api/routers/settings");

const caller = settingsRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "owner@example.com", role: "owner" },
} as Parameters<typeof settingsRouter.createCaller>[0]);

/** What the schedule currently holds, by job name. */
const registry = mocks.scheduledJobs as Record<string, FakeJob | undefined>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	for (const key of Object.keys(registry)) delete registry[key];
	// Like node-schedule: registers by name, and a cancel removes the entry.
	mocks.scheduleJob.mockImplementation((name: string) => {
		const job: FakeJob = {
			name,
			cancel: vi.fn(() => {
				if (registry[name] === job) delete registry[name];
			}),
		};
		registry[name] = job;
		return job;
	});
	mocks.cleanupAll.mockResolvedValue(undefined);
	mocks.sendDockerCleanupNotifications.mockResolvedValue(undefined);
	mocks.runningRows.mockResolvedValue([]);
	mocks.queueJobs.mockResolvedValue([]);
	mocks.findServerById.mockResolvedValue({
		serverId: "srv-1",
		name: "prod",
		organizationId: "org-a",
		serverStatus: "active",
		enableDockerCleanup: true,
		dockerCleanupCron: "0 4 * * *",
	});
});

const scheduledCallbackOf = (callIndex = 0) =>
	mocks.scheduleJob.mock.calls[callIndex]?.[2] as () => Promise<void>;

describe("scheduleDockerCleanup", () => {
	it("hands node-schedule the cron with an explicit UTC timezone", () => {
		scheduleDockerCleanup({
			jobName: "srv-1",
			serverId: "srv-1",
			hostLabel: "server prod (srv-1)",
			cron: "30 2 * * *",
		});
		expect(mocks.scheduleJob).toHaveBeenCalledWith(
			"srv-1",
			{ rule: "30 2 * * *", tz: "Etc/UTC" },
			expect.any(Function),
		);
	});

	it("does not use the old 23:50 container-local schedule", () => {
		scheduleDockerCleanup({
			jobName: "srv-1",
			serverId: "srv-1",
			hostLabel: "server prod",
			cron: undefined,
		});
		expect(mocks.scheduleJob.mock.calls[0]?.[1]).toEqual({
			rule: "0 4 * * *",
			tz: "Etc/UTC",
		});
	});

	it("cancels the job of the same name before scheduling the new one", () => {
		scheduleDockerCleanup({
			jobName: "srv-1",
			serverId: "srv-1",
			hostLabel: "server prod",
			cron: "0 4 * * *",
		});
		const first = registry["srv-1"] as FakeJob;
		scheduleDockerCleanup({
			jobName: "srv-1",
			serverId: "srv-1",
			hostLabel: "server prod",
			cron: "0 5 * * *",
		});
		expect(first.cancel).toHaveBeenCalledTimes(1);
		expect(first.cancel.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.scheduleJob.mock.invocationCallOrder[1] as number,
		);
		expect(registry["srv-1"]).not.toBe(first);
	});

	it("runs the cleanup and the follow-up only when the host is idle", async () => {
		const afterCleanup = vi.fn();
		scheduleDockerCleanup({
			jobName: "srv-1",
			serverId: "srv-1",
			hostLabel: "server prod",
			cron: "0 4 * * *",
			afterCleanup,
		});
		await scheduledCallbackOf()();
		expect(mocks.cleanupAll).toHaveBeenCalledWith("srv-1");
		expect(afterCleanup).toHaveBeenCalledTimes(1);
	});

	it("cleans the Dokploy server with no serverId", async () => {
		scheduleDockerCleanup({
			jobName: WEB_SERVER_CLEANUP_JOB,
			hostLabel: "the Dokploy server",
			cron: "0 4 * * *",
		});
		await scheduledCallbackOf()();
		expect(mocks.cleanupAll).toHaveBeenCalledWith(undefined);
	});

	it("defers instead of cleaning while a deployment is active, then gives up quietly", async () => {
		vi.useFakeTimers();
		try {
			mocks.runningRows.mockResolvedValue([
				{
					serverId: "srv-1",
					buildServerId: null,
					application: null,
					compose: null,
				},
			]);
			const afterCleanup = vi.fn();
			scheduleDockerCleanup({
				jobName: "srv-1",
				serverId: "srv-1",
				hostLabel: "server prod (srv-1)",
				cron: "0 4 * * *",
				afterCleanup,
			});
			const done = scheduledCallbackOf()();
			await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000 + 1000);
			await done;
			expect(mocks.cleanupAll).not.toHaveBeenCalled();
			expect(afterCleanup).not.toHaveBeenCalled();
			expect(console.log).toHaveBeenCalledWith(
				"Docker cleanup deferred: 1 deployment(s) active on server prod (srv-1)",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops waiting once the job is cancelled", async () => {
		vi.useFakeTimers();
		try {
			mocks.runningRows.mockResolvedValue([
				{
					serverId: "srv-1",
					buildServerId: null,
					application: null,
					compose: null,
				},
			]);
			scheduleDockerCleanup({
				jobName: "srv-1",
				serverId: "srv-1",
				hostLabel: "server prod",
				cron: "0 4 * * *",
			});
			const done = scheduledCallbackOf()();
			await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
			cancelDockerCleanup("srv-1");
			// The build ends, but the schedule was switched off: nothing runs.
			mocks.runningRows.mockResolvedValue([]);
			await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
			await done;
			expect(mocks.cleanupAll).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("applyDockerCleanupSchedule (remote servers)", () => {
	it("schedules with the server's stored cron when none is given", async () => {
		mocks.findServerById.mockResolvedValue({
			name: "prod",
			dockerCleanupCron: "15 1 * * *",
		});
		await applyDockerCleanupSchedule("srv-1", "org-a", true);
		expect(mocks.scheduleJob).toHaveBeenCalledWith(
			"srv-1",
			{ rule: "15 1 * * *", tz: "Etc/UTC" },
			expect.any(Function),
		);
	});

	it("reschedules on a changed cron, cancelling the old job first", async () => {
		mocks.findServerById.mockResolvedValue({
			name: "prod",
			dockerCleanupCron: "0 4 * * *",
		});
		await applyDockerCleanupSchedule("srv-1", "org-a", true, "0 4 * * *");
		const old = registry["srv-1"] as FakeJob;
		await applyDockerCleanupSchedule("srv-1", "org-a", true, "0 6 * * *");
		expect(old.cancel).toHaveBeenCalledTimes(1);
		expect(mocks.scheduleJob).toHaveBeenCalledTimes(2);
		expect(mocks.scheduleJob.mock.calls[1]?.[1]).toEqual({
			rule: "0 6 * * *",
			tz: "Etc/UTC",
		});
	});

	it("cancels the job when cleanup is turned off", async () => {
		await applyDockerCleanupSchedule("srv-1", "org-a", true, "0 4 * * *");
		const job = registry["srv-1"] as FakeJob;
		await applyDockerCleanupSchedule("srv-1", "org-a", false);
		expect(job.cancel).toHaveBeenCalledTimes(1);
		expect(mocks.scheduleJob).toHaveBeenCalledTimes(1);
	});
});

describe("settings.updateDockerCleanup", () => {
	it("stores a new web server cron and reschedules the job in UTC", async () => {
		mocks.updateWebServerSettings
			.mockResolvedValueOnce({
				enableDockerCleanup: true,
				dockerCleanupCron: "0 4 * * *",
			})
			.mockResolvedValueOnce({
				enableDockerCleanup: true,
				dockerCleanupCron: "45 5 * * *",
			});
		await caller.updateDockerCleanup({ enableDockerCleanup: true });
		const old = registry[WEB_SERVER_CLEANUP_JOB] as FakeJob;

		await caller.updateDockerCleanup({
			enableDockerCleanup: true,
			dockerCleanupCron: "45  5 * * *",
		});

		expect(mocks.updateWebServerSettings).toHaveBeenLastCalledWith({
			enableDockerCleanup: true,
			dockerCleanupCron: "45 5 * * *",
		});
		expect(old.cancel).toHaveBeenCalledTimes(1);
		expect(mocks.scheduleJob).toHaveBeenLastCalledWith(
			WEB_SERVER_CLEANUP_JOB,
			{ rule: "45 5 * * *", tz: "Etc/UTC" },
			expect.any(Function),
		);
	});

	it("leaves the stored cron alone when none is sent", async () => {
		mocks.updateWebServerSettings.mockResolvedValue({
			enableDockerCleanup: true,
			dockerCleanupCron: "0 4 * * *",
		});
		await caller.updateDockerCleanup({ enableDockerCleanup: true });
		expect(mocks.updateWebServerSettings).toHaveBeenCalledWith({
			enableDockerCleanup: true,
		});
	});

	it("cancels the web server job when switched off", async () => {
		mocks.updateWebServerSettings.mockResolvedValue({
			enableDockerCleanup: true,
			dockerCleanupCron: "0 4 * * *",
		});
		await caller.updateDockerCleanup({ enableDockerCleanup: true });
		const job = registry[WEB_SERVER_CLEANUP_JOB] as FakeJob;
		mocks.updateWebServerSettings.mockResolvedValue({
			enableDockerCleanup: false,
			dockerCleanupCron: "0 4 * * *",
		});
		await caller.updateDockerCleanup({ enableDockerCleanup: false });
		expect(job.cancel).toHaveBeenCalledTimes(1);
	});

	it("stores a remote server's cron and reschedules its job", async () => {
		mocks.findServerById.mockResolvedValue({
			serverId: "srv-1",
			name: "prod",
			organizationId: "org-a",
			serverStatus: "active",
			enableDockerCleanup: true,
			dockerCleanupCron: "0 2 * * 1",
		});
		await caller.updateDockerCleanup({
			serverId: "srv-1",
			enableDockerCleanup: true,
			dockerCleanupCron: "0 2 * * 1",
		});
		expect(mocks.updateServerById).toHaveBeenCalledWith("srv-1", {
			enableDockerCleanup: true,
			dockerCleanupCron: "0 2 * * 1",
		});
		expect(mocks.scheduleJob).toHaveBeenCalledWith(
			"srv-1",
			{ rule: "0 2 * * 1", tz: "Etc/UTC" },
			expect.any(Function),
		);
	});

	it("rejects schedules that would run more often than hourly, before writing anything", async () => {
		for (const dockerCleanupCron of ["* * * * *", "*/10 * * * *", "0 4 * *"]) {
			await expect(
				caller.updateDockerCleanup({
					serverId: "srv-1",
					enableDockerCleanup: true,
					dockerCleanupCron,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(mocks.updateServerById).not.toHaveBeenCalled();
		expect(mocks.updateWebServerSettings).not.toHaveBeenCalled();
		expect(mocks.scheduleJob).not.toHaveBeenCalled();
	});

	it("does not touch another organization's server", async () => {
		mocks.findServerById.mockResolvedValue({
			serverId: "srv-9",
			organizationId: "org-b",
		});
		await expect(
			caller.updateDockerCleanup({
				serverId: "srv-9",
				enableDockerCleanup: true,
				dockerCleanupCron: "0 4 * * *",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.updateServerById).not.toHaveBeenCalled();
	});
});

describe("initCronJobs", () => {
	it("schedules the web server and each server from their own cron", async () => {
		mocks.findOwner.mockResolvedValue({ user: { id: "owner-1" } });
		mocks.getWebServerSettings.mockResolvedValue({
			enableDockerCleanup: true,
			dockerCleanupCron: "0 3 * * *",
		});
		mocks.getAllServers.mockResolvedValue([
			{
				serverId: "srv-1",
				name: "one",
				enableDockerCleanup: true,
				dockerCleanupCron: "0 4 * * *",
			},
			{
				serverId: "srv-2",
				name: "two",
				enableDockerCleanup: true,
				dockerCleanupCron: "30 5 * * 0",
			},
			{
				serverId: "srv-3",
				name: "off",
				enableDockerCleanup: false,
				dockerCleanupCron: "0 4 * * *",
			},
		]);
		// Backups are not under test here.
		const { db } = await import("@dokploy/server/db");
		(db.query as Record<string, unknown>).backups = {
			findMany: async () => [],
		};

		await initCronJobs();

		const calls = mocks.scheduleJob.mock.calls.map(
			([name, spec]) => [name, spec] as const,
		);
		expect(calls).toEqual([
			[WEB_SERVER_CLEANUP_JOB, { rule: "0 3 * * *", tz: "Etc/UTC" }],
			["srv-1", { rule: "0 4 * * *", tz: "Etc/UTC" }],
			["srv-2", { rule: "30 5 * * 0", tz: "Etc/UTC" }],
		]);
	});
});
