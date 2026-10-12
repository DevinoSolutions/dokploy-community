import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * createDeploymentSchedule creates directories and log files named after the
 * schedule's app name, on the host or over SSH. A stored name that is not a
 * plain directory name must stop the run before anything is executed.
 */

const mocks = vi.hoisted(() => ({
	findScheduleById: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findServerById: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({
	IS_CLOUD: false,
	paths: () => ({ SCHEDULES_PATH: "/tmp/schedules", LOGS_PATH: "/tmp/logs" }),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {},
		update: vi.fn(),
		insert: vi.fn(),
		select: vi.fn(),
		delete: vi.fn(),
	},
}));

vi.mock("@dokploy/server/services/schedule", () => ({
	findScheduleById: mocks.findScheduleById,
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

import { createDeploymentSchedule } from "@dokploy/server/services/deployment";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("createDeploymentSchedule", () => {
	it.each([
		"..",
		".",
		"x$(touch pwned)",
		"x`touch pwned`",
		"x;touch pwned",
		"x y",
		"../../etc",
		"",
	])("refuses app name %j before running anything", async (appName) => {
		mocks.findScheduleById.mockResolvedValue({
			scheduleId: "sch-1",
			appName,
			serverId: "server-1",
			application: null,
			compose: null,
			server: { serverId: "server-1" },
		});

		await expect(
			createDeploymentSchedule({
				scheduleId: "sch-1",
				title: "Schedule",
				description: "Schedule",
			}),
		).rejects.toThrow("Invalid schedule app name");

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});
