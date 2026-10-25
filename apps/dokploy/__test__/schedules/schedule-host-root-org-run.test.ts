import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A dokploy-server schedule runs inside the Dokploy process. A row made by an
 * organization that does not own the instance (before the create and update
 * routes were limited to the one that does) is left in the database and is not
 * run: the run stops before it records a deployment or starts anything.
 */

const mocks = vi.hoisted(() => ({
	rootOrganization: "org-root",
	findScheduleById: vi.fn(),
	findScheduleOrganizationId: vi.fn(),
	createDeploymentSchedule: vi.fn(),
	updateDeployment: vi.fn(),
	finishScheduleRun: vi.fn(),
	endScheduleRunCancelled: vi.fn(),
	isScheduleRunCancelled: vi.fn(),
	spawnAsync: vi.fn(),
	sendScheduleFailureNotifications: vi.fn(),
	createWriteStream: vi.fn(),
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
}));

vi.mock("@dokploy/server/utils/schedules/run-status", () => ({
	finishScheduleRun: mocks.finishScheduleRun,
	endScheduleRunCancelled: mocks.endScheduleRunCancelled,
	isScheduleRunCancelled: mocks.isScheduleRunCancelled,
}));

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: vi.fn(),
	isRootOrganization: async (organizationId: string) =>
		organizationId === mocks.rootOrganization,
}));

vi.mock("@dokploy/server/utils/process/spawnAsync", () => ({
	spawnAsync: mocks.spawnAsync,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/notifications/schedule-failure", () => ({
	sendScheduleFailureNotifications: mocks.sendScheduleFailureNotifications,
}));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	createWriteStream: mocks.createWriteStream,
}));

vi.mock("node-schedule", () => ({
	scheduleJob: vi.fn(),
	scheduledJobs: {},
}));

import { runCommand } from "@dokploy/server/utils/schedules/utils";

const hostRun = (organizationId: string | null) => ({
	scheduleId: "sch-1",
	name: "Nightly",
	scheduleType: "dokploy-server",
	command: "",
	shellType: "bash",
	appName: "my-schedule",
	serviceName: null,
	serverId: null,
	organizationId,
	compose: null,
	application: null,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createDeploymentSchedule.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "run.log",
	});
	mocks.updateDeployment.mockResolvedValue(undefined);
	mocks.finishScheduleRun.mockResolvedValue("recorded");
	mocks.isScheduleRunCancelled.mockResolvedValue(false);
	mocks.findScheduleOrganizationId.mockResolvedValue("org-other");
	mocks.spawnAsync.mockResolvedValue(undefined);
	mocks.createWriteStream.mockReturnValue({
		write: vi.fn(),
		end: vi.fn(),
		writable: true,
	});
});

describe("running a host schedule", () => {
	it("is refused for a schedule of an organization that does not own the instance", async () => {
		mocks.findScheduleById.mockResolvedValue(hostRun("org-other"));

		await expect(runCommand("sch-1")).rejects.toThrow(
			/Not running host schedule sch-1/,
		);

		expect(mocks.createDeploymentSchedule).not.toHaveBeenCalled();
		expect(mocks.spawnAsync).not.toHaveBeenCalled();
	});

	it("runs a schedule of the organization that owns the instance", async () => {
		mocks.findScheduleById.mockResolvedValue(hostRun("org-root"));

		await runCommand("sch-1");

		expect(mocks.spawnAsync).toHaveBeenCalledTimes(1);
	});

	it("runs a schedule that predates the organization column as before", async () => {
		mocks.findScheduleById.mockResolvedValue(hostRun(null));

		await runCommand("sch-1");

		expect(mocks.spawnAsync).toHaveBeenCalledTimes(1);
	});

	it("does not look at the organization of any other kind of schedule", async () => {
		mocks.findScheduleById.mockResolvedValue({
			...hostRun("org-other"),
			scheduleType: "server",
			serverId: "srv-1",
		});

		await runCommand("sch-1").catch(() => undefined);

		expect(mocks.createDeploymentSchedule).toHaveBeenCalledTimes(1);
	});
});
