import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the "invalid container name or ID: value is empty" storm
 * (Sentry DOKPLOY-COMMUNITY-1 / DOKPLOY-COMMUNITY-2).
 *
 * When an application/compose schedule fires while its target container is not
 * running, the container lookup returns null and containerId defaulted to "".
 * The old code then ran `docker exec "" ...` on every cron tick, and because
 * node-schedule's async callback had no catch, the rethrow became an
 * unhandledRejection.
 */

const mocks = vi.hoisted(() => ({
	findScheduleById: vi.fn(),
	findScheduleOrganizationId: vi.fn(),
	createDeploymentSchedule: vi.fn(),
	updateDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	getDokployUrl: vi.fn(),
	getServiceContainer: vi.fn(),
	getComposeContainer: vi.fn(),
	spawnAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	sendScheduleFailureNotifications: vi.fn(),
	appendFile: vi.fn(),
	scheduleJobNode: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({
	IS_CLOUD: false,
	paths: () => ({ SCHEDULES_PATH: "/tmp/schedules" }),
}));

vi.mock("@dokploy/server/services/schedule", () => ({
	findScheduleById: mocks.findScheduleById,
	findScheduleOrganizationId: mocks.findScheduleOrganizationId,
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeploymentSchedule: mocks.createDeploymentSchedule,
	updateDeployment: mocks.updateDeployment,
	updateDeploymentStatus: mocks.updateDeploymentStatus,
}));

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: mocks.getDokployUrl,
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	getServiceContainer: mocks.getServiceContainer,
	getComposeContainer: mocks.getComposeContainer,
}));

vi.mock("@dokploy/server/utils/process/spawnAsync", () => ({
	spawnAsync: mocks.spawnAsync,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/utils/notifications/schedule-failure", () => ({
	sendScheduleFailureNotifications: mocks.sendScheduleFailureNotifications,
}));

vi.mock("node:fs/promises", () => ({
	appendFile: mocks.appendFile,
}));

vi.mock("node-schedule", () => ({
	scheduleJob: mocks.scheduleJobNode,
	scheduledJobs: {},
}));

import { runCommand, scheduleJob } from "@dokploy/server/utils/schedules/utils";

const applicationSchedule = () => ({
	scheduleId: "sch-app-1",
	name: "Nightly cleanup",
	scheduleType: "application" as const,
	command: "echo hi",
	shellType: "sh",
	appName: "my-app",
	serviceName: null,
	serverId: null,
	compose: null,
	application: {
		appName: "my-app",
		serverId: null,
		environment: { project: { name: "My Project" } },
	},
});

const composeSchedule = () => ({
	scheduleId: "sch-compose-1",
	name: "Compose task",
	scheduleType: "compose" as const,
	command: "echo hi",
	shellType: "sh",
	appName: "my-compose",
	serviceName: "web",
	serverId: null,
	application: null,
	compose: {
		appName: "my-compose",
		serverId: null,
		composeType: "docker-compose",
		environment: { project: { name: "My Project" } },
	},
});

describe("runCommand — target container not running (DOKPLOY-COMMUNITY-1/2)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.createDeploymentSchedule.mockResolvedValue({
			deploymentId: "dep-1",
			logPath: "/tmp/dep-1.log",
		});
		mocks.updateDeploymentStatus.mockResolvedValue(undefined);
		mocks.findScheduleOrganizationId.mockResolvedValue("org-1");
		mocks.getDokployUrl.mockResolvedValue("https://dokploy.test");
		mocks.sendScheduleFailureNotifications.mockResolvedValue(undefined);
		mocks.appendFile.mockResolvedValue(undefined);
	});

	it("rejects with an actionable error and never runs docker exec for an application", async () => {
		mocks.findScheduleById.mockResolvedValue(applicationSchedule());
		mocks.getServiceContainer.mockResolvedValue(null);

		await expect(runCommand("sch-app-1")).rejects.toThrow(
			"Container not found for my-app — the service may not be running",
		);

		// The whole point: no docker exec with an empty container id.
		expect(mocks.spawnAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();

		// It is recorded as a proper schedule failure, not a success.
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalledWith(
			"dep-1",
			"done",
		);
		expect(mocks.sendScheduleFailureNotifications).toHaveBeenCalledTimes(1);

		// The failure is written to the deployment log.
		expect(mocks.appendFile).toHaveBeenCalledWith(
			"/tmp/dep-1.log",
			expect.stringContaining("Container not found for my-app"),
		);
	});

	it("includes the service name in the error for a compose schedule", async () => {
		mocks.findScheduleById.mockResolvedValue(composeSchedule());
		mocks.getComposeContainer.mockResolvedValue(null);

		await expect(runCommand("sch-compose-1")).rejects.toThrow(
			'Container not found for my-compose (service "web") — the service may not be running',
		);

		expect(mocks.spawnAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
	});
});

describe("scheduleJob — cron callback must not leak rejections", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.createDeploymentSchedule.mockResolvedValue({
			deploymentId: "dep-1",
			logPath: "/tmp/dep-1.log",
		});
		mocks.updateDeploymentStatus.mockResolvedValue(undefined);
		mocks.findScheduleOrganizationId.mockResolvedValue("org-1");
		mocks.getDokployUrl.mockResolvedValue("https://dokploy.test");
		mocks.sendScheduleFailureNotifications.mockResolvedValue(undefined);
		mocks.appendFile.mockResolvedValue(undefined);
	});

	it("swallows a failing runCommand instead of producing an unhandled rejection", async () => {
		// runCommand will reject because the container lookup returns null.
		mocks.findScheduleById.mockResolvedValue(applicationSchedule());
		mocks.getServiceContainer.mockResolvedValue(null);

		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		scheduleJob({
			scheduleId: "sch-app-1",
			cronExpression: "* * * * *",
			timezone: "UTC",
		} as never);

		expect(mocks.scheduleJobNode).toHaveBeenCalledTimes(1);
		const registeredCallback = mocks.scheduleJobNode.mock
			.calls[0]?.[2] as () => Promise<void>;

		// The callback must resolve (not reject) even though runCommand rejects.
		await expect(registeredCallback()).resolves.toBeUndefined();

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Scheduled job sch-app-1 failed:",
			expect.any(Error),
		);
		consoleErrorSpy.mockRestore();
	});
});
