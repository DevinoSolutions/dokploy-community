import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearTraefikSetupJobs,
	getTraefikSetupJob,
	trackTraefikSetupJob,
} from "@/server/api/utils/traefik-setup-jobs";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("traefik setup jobs", () => {
	beforeEach(() => {
		clearTraefikSetupJobs();
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("is pending until the setup settles, then done", async () => {
		let finish: () => void = () => {};
		trackTraefikSetupJob(
			undefined,
			"a",
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
			"test",
		);
		expect(getTraefikSetupJob(undefined, "a").state).toBe("pending");

		finish();
		await flush();
		expect(getTraefikSetupJob(undefined, "a")).toEqual({
			state: "done",
			error: null,
		});
	});

	it("keeps the failure message and logs it", async () => {
		trackTraefikSetupJob(
			"s1",
			"a",
			Promise.reject(new Error("boom")),
			"writeTraefikEnv",
		);
		await flush();

		expect(getTraefikSetupJob("s1", "a")).toEqual({
			state: "failed",
			error: "boom",
		});
		expect(console.error).toHaveBeenCalledWith(
			"writeTraefikEnv background writeTraefikSetup:",
			expect.any(Error),
		);
	});

	it("stringifies a non-Error rejection", async () => {
		trackTraefikSetupJob("s1", "a", Promise.reject("plain"), "test");
		await flush();
		expect(getTraefikSetupJob("s1", "a").error).toBe("plain");
	});

	it("keeps servers and ids apart, and the local host apart from a server", async () => {
		trackTraefikSetupJob("s1", "a", Promise.resolve(), "test");
		await flush();

		expect(getTraefikSetupJob("s1", "a").state).toBe("done");
		expect(getTraefikSetupJob("s2", "a").state).toBe("unknown");
		expect(getTraefikSetupJob("s1", "b").state).toBe("unknown");
		expect(getTraefikSetupJob(undefined, "a").state).toBe("unknown");
	});

	it("forgets a run after 30 minutes", async () => {
		vi.useFakeTimers();
		trackTraefikSetupJob("s1", "old", Promise.resolve(), "test");
		await vi.advanceTimersByTimeAsync(31 * 60_000);
		trackTraefikSetupJob("s1", "new", Promise.resolve(), "test");

		expect(getTraefikSetupJob("s1", "old").state).toBe("unknown");
		expect(getTraefikSetupJob("s1", "new").state).toBe("pending");
	});

	it("keeps at most 200 runs, dropping the oldest", async () => {
		for (let i = 0; i < 205; i++) {
			trackTraefikSetupJob("s1", `job-${i}`, Promise.resolve(), "test");
		}
		await flush();

		expect(getTraefikSetupJob("s1", "job-0").state).toBe("unknown");
		expect(getTraefikSetupJob("s1", "job-4").state).toBe("unknown");
		expect(getTraefikSetupJob("s1", "job-5").state).toBe("done");
		expect(getTraefikSetupJob("s1", "job-204").state).toBe("done");
	});

	it("drops runs that ended, failed ones included, before one that is still pending", async () => {
		trackTraefikSetupJob("s1", "waiting", new Promise(() => {}), "test");
		trackTraefikSetupJob("s1", "bad-0", Promise.reject(new Error("x")), "test");
		for (let i = 0; i < 250; i++) {
			trackTraefikSetupJob(
				"s1",
				`bad-${i + 1}`,
				Promise.reject(new Error("x")),
				"test",
			);
			await flush();
		}

		expect(getTraefikSetupJob("s1", "waiting").state).toBe("pending");
		expect(getTraefikSetupJob("s1", "bad-0").state).toBe("unknown");
		expect(getTraefikSetupJob("s1", "bad-250").state).toBe("failed");
	});

	it("drops the oldest pending run only when none has ended", () => {
		for (let i = 0; i < 205; i++) {
			trackTraefikSetupJob("s1", `job-${i}`, new Promise(() => {}), "test");
		}

		expect(getTraefikSetupJob("s1", "job-0").state).toBe("unknown");
		expect(getTraefikSetupJob("s1", "job-5").state).toBe("pending");
		expect(getTraefikSetupJob("s1", "job-204").state).toBe("pending");
	});

	it("caps a very long error message", async () => {
		trackTraefikSetupJob(
			"s1",
			"a",
			Promise.reject(new Error("x".repeat(5000))),
			"test",
		);
		await flush();

		expect(getTraefikSetupJob("s1", "a").error).toHaveLength(2000);
	});

	it("does not show the result of an earlier run as the result of a reused job id", async () => {
		let finishFirst: () => void = () => {};
		let finishSecond: () => void = () => {};
		trackTraefikSetupJob(
			"s1",
			"same",
			new Promise<void>((resolve) => {
				finishFirst = resolve;
			}),
			"test",
		);
		trackTraefikSetupJob(
			"s1",
			"same",
			new Promise<void>((resolve) => {
				finishSecond = resolve;
			}),
			"test",
		);

		finishFirst();
		await flush();
		expect(getTraefikSetupJob("s1", "same").state).toBe("pending");

		finishSecond();
		await flush();
		expect(getTraefikSetupJob("s1", "same").state).toBe("done");
	});

	it("does not take the failure of an earlier run for the reused job id either", async () => {
		let failFirst: (error: Error) => void = () => {};
		trackTraefikSetupJob(
			"s1",
			"same",
			new Promise<void>((_, reject) => {
				failFirst = reject;
			}),
			"test",
		);
		trackTraefikSetupJob("s1", "same", new Promise(() => {}), "test");

		failFirst(new Error("old"));
		await flush();
		expect(getTraefikSetupJob("s1", "same")).toEqual({
			state: "pending",
			error: null,
		});
	});
});
