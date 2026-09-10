import { describe, expect, it, vi } from "vitest";
import { BuildPolicyError } from "@dokploy/server/services/build-policy/errors";
import {
	evaluateRequiredChecks,
	waitForRequiredChecks,
} from "@dokploy/server/services/build-policy/required-checks";

const run = (
	name: string,
	status: string,
	conclusion: string | null = null,
) => ({ name, status, conclusion });

describe("evaluateRequiredChecks", () => {
	it("is satisfied when every required check succeeded", () => {
		expect(
			evaluateRequiredChecks(
				["build", "test"],
				[
					run("build", "completed", "success"),
					run("test", "completed", "success"),
					run("lint", "completed", "failure"),
				],
			),
		).toEqual({ state: "satisfied" });
	});

	it("treats a neutral or skipped conclusion as success", () => {
		expect(
			evaluateRequiredChecks(
				["build", "test"],
				[
					run("build", "completed", "neutral"),
					run("test", "completed", "skipped"),
				],
			),
		).toEqual({ state: "satisfied" });
	});

	it("is pending while a required check is still running", () => {
		expect(
			evaluateRequiredChecks(
				["build", "test"],
				[run("build", "completed", "success"), run("test", "in_progress")],
			),
		).toEqual({ state: "pending", waitingOn: ["test"] });
	});

	it("is pending while a required check has not been reported at all", () => {
		expect(
			evaluateRequiredChecks(["build", "test"], [run("build", "queued")]),
		).toEqual({ state: "pending", waitingOn: ["build", "test"] });
	});

	it.each(["failure", "cancelled", "timed_out", "action_required", "stale"])(
		"fails on a %s conclusion",
		(conclusion) => {
			expect(
				evaluateRequiredChecks(["build"], [run("build", "completed", conclusion)]),
			).toEqual({ state: "failed", failed: ["build"] });
		},
	);

	it("reports every failing check, not just the first", () => {
		expect(
			evaluateRequiredChecks(
				["build", "test"],
				[
					run("build", "completed", "failure"),
					run("test", "completed", "timed_out"),
				],
			),
		).toEqual({ state: "failed", failed: ["build", "test"] });
	});

	it("uses the newest run when a check was re-run", () => {
		expect(
			evaluateRequiredChecks(
				["build"],
				[
					run("build", "completed", "failure"),
					run("build", "completed", "success"),
				],
			),
		).toEqual({ state: "satisfied" });
	});

	it("is satisfied immediately when nothing is required", () => {
		expect(evaluateRequiredChecks([], [])).toEqual({ state: "satisfied" });
	});
});

describe("waitForRequiredChecks", () => {
	const base = {
		requiredChecks: ["build"],
		owner: "DevinoSolutions",
		repo: "sendly",
		sha: "abc123",
		timeoutMs: 60_000,
		pollIntervalMs: 5_000,
	};

	it("returns immediately when nothing is required and never calls github", async () => {
		const listCheckRuns = vi.fn();
		await waitForRequiredChecks({
			...base,
			requiredChecks: [],
			listCheckRuns,
			sleep: vi.fn(),
			now: () => 0,
		});
		expect(listCheckRuns).not.toHaveBeenCalled();
	});

	it("returns once the required checks succeed", async () => {
		const listCheckRuns = vi
			.fn()
			.mockResolvedValueOnce([run("build", "in_progress")])
			.mockResolvedValueOnce([run("build", "completed", "success")]);
		const sleep = vi.fn().mockResolvedValue(undefined);
		let clock = 0;
		await waitForRequiredChecks({
			...base,
			listCheckRuns,
			sleep,
			now: () => {
				const t = clock;
				clock += 5_000;
				return t;
			},
		});
		expect(listCheckRuns).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(5_000);
	});

	it("fails fast when a required check concludes in failure", async () => {
		const listCheckRuns = vi
			.fn()
			.mockResolvedValue([run("build", "completed", "failure")]);
		const sleep = vi.fn();
		await expect(
			waitForRequiredChecks({ ...base, listCheckRuns, sleep, now: () => 0 }),
		).rejects.toMatchObject({ code: "REQUIRED_CHECKS_FAILED" });
		expect(sleep).not.toHaveBeenCalled();
		expect(listCheckRuns).toHaveBeenCalledTimes(1);
	});

	it("names the failing checks in the error message", async () => {
		const listCheckRuns = vi
			.fn()
			.mockResolvedValue([run("build", "completed", "failure")]);
		await expect(
			waitForRequiredChecks({ ...base, listCheckRuns, sleep: vi.fn(), now: () => 0 }),
		).rejects.toThrow(/build/);
	});

	it("times out with a named error when the checks never conclude", async () => {
		const listCheckRuns = vi.fn().mockResolvedValue([run("build", "queued")]);
		let clock = 0;
		const sleep = vi.fn().mockImplementation(async () => {
			clock += 30_000;
		});
		await expect(
			waitForRequiredChecks({
				...base,
				listCheckRuns,
				sleep,
				now: () => clock,
			}),
		).rejects.toMatchObject({ code: "REQUIRED_CHECKS_TIMEOUT" });
	});

	it("reports what it was still waiting on when it times out", async () => {
		const listCheckRuns = vi.fn().mockResolvedValue([]);
		let clock = 0;
		const sleep = vi.fn().mockImplementation(async () => {
			clock += 30_000;
		});
		await expect(
			waitForRequiredChecks({
				...base,
				requiredChecks: ["build", "e2e"],
				listCheckRuns,
				sleep,
				now: () => clock,
			}),
		).rejects.toThrow(/e2e/);
	});

	it("surfaces a BuildPolicyError, not a raw github error shape", async () => {
		const listCheckRuns = vi
			.fn()
			.mockResolvedValue([run("build", "completed", "failure")]);
		await expect(
			waitForRequiredChecks({ ...base, listCheckRuns, sleep: vi.fn(), now: () => 0 }),
		).rejects.toBeInstanceOf(BuildPolicyError);
	});
});
