import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/index", () => ({
	IS_CLOUD: true,
	removeScheduleBackup: vi.fn(),
}));

import { removeJob, schedule, updateJob } from "../../server/utils/backup";

const job = {
	type: "schedule" as const,
	cronSchedule: "0 0 * * *",
	scheduleId: "sched-1",
	timezone: null,
};

const mockFetch = (ok: boolean, status: number, body: unknown) => {
	const fn = vi.fn().mockResolvedValue({
		ok,
		status,
		json: async () => body,
	});
	vi.stubGlobal("fetch", fn);
	return fn;
};

describe("jobs service calls", () => {
	beforeEach(() => {
		process.env.JOBS_URL = "http://jobs.test";
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("posts to the matching jobs endpoint and returns the response", async () => {
		const fetchMock = mockFetch(true, 200, { message: "ok" });
		await expect(schedule(job)).resolves.toEqual({ message: "ok" });
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://jobs.test/create-backup");
		await updateJob(job);
		await removeJob(job);
		expect(fetchMock.mock.calls[1]?.[0]).toBe("http://jobs.test/update-backup");
		expect(fetchMock.mock.calls[2]?.[0]).toBe("http://jobs.test/remove-job");
	});

	it.each([
		["schedule", schedule, "/create-backup"],
		["updateJob", updateJob, "/update-backup"],
		["removeJob", removeJob, "/remove-job"],
	])(
		"%s throws when the jobs service answers non-2xx",
		async (_n, fn, path) => {
			mockFetch(false, 400, { message: "Invalid request" });
			await expect(fn(job)).rejects.toThrow(
				`Jobs service ${path} failed (400): {"message":"Invalid request"}`,
			);
		},
	);
});
