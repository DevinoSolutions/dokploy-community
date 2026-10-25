import { execFileSync } from "node:child_process";
import {
	boundFetchCommand,
	FETCH_CLONE_KILL_AFTER_SECONDS,
	FETCH_CLONE_TIMEOUT_SECONDS,
} from "@dokploy/server/utils/docker/domain";
import { describe, expect, it } from "vitest";

// T-8239: a Fetch holds the compose's deploy lock while it clones, so the clone
// is bounded on the host that runs it and the lock is given back after it has
// exited. The lock's own 10-minute release is only the last resort.

/** Runs a command the way a host shell does; returns its status and output. */
const run = (command: string) => {
	try {
		const stdout = execFileSync("sh", ["-c", command], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		const failed = error as { status: number; stdout: string; stderr: string };
		return {
			status: failed.status,
			stdout: failed.stdout,
			stderr: failed.stderr,
		};
	}
};

describe("boundFetchCommand", { timeout: 30_000 }, () => {
	it("stops the clone, TERM then KILL, before the lock's 10-minute release", () => {
		expect(
			FETCH_CLONE_TIMEOUT_SECONDS + FETCH_CLONE_KILL_AFTER_SECONDS,
		).toBeLessThan(10 * 60);
		expect(boundFetchCommand("true;")).toContain(
			`timeout -k ${FETCH_CLONE_KILL_AFTER_SECONDS} ${FETCH_CLONE_TIMEOUT_SECONDS}`,
		);
	});

	it("runs the command unchanged and keeps its exit status", () => {
		const command = `set -e; echo "it's $((1 + 1)) ✅"; exit 3`;

		const result = run(boundFetchCommand(command));

		expect(result.status).toBe(3);
		expect(result.stdout).toBe("it's 2 ✅\n");
	});

	it("stops a command that runs too long and says so", () => {
		const result = run(boundFetchCommand("sleep 30", 1, 1));

		expect(result.status).toBe(124);
		expect(result.stderr).toContain(
			"The clone did not finish within 1 seconds and was stopped",
		);
	});
});
