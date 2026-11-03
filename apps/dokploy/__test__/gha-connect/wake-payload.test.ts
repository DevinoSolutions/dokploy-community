import {
	parseDeploymentTask,
	parseWakePayload,
	WAKE_SCHEMA,
} from "@dokploy/server/services/gha-connect/wake-payload";
import { describe, expect, it } from "vitest";

const payload = (overrides: Record<string, unknown> = {}) => ({
	schema: WAKE_SCHEMA,
	run_id: 9876543210,
	run_attempt: 2,
	artifact: "dokploy-release",
	...overrides,
});

describe("parseDeploymentTask", () => {
	it("returns the key of a dokploy task", () => {
		expect(parseDeploymentTask("dokploy:web")).toBe("web");
		expect(parseDeploymentTask("dokploy:shorty-web.v2")).toBe("shorty-web.v2");
	});

	it.each([
		"deploy",
		"dokploy:",
		"dokploy:Web",
		"Dokploy:web",
		"dokploy:web;rm",
		"dokploy:a/b",
		undefined,
		null,
		42,
	])("ignores %s", (task) => {
		expect(parseDeploymentTask(task)).toBeNull();
	});
});

describe("parseWakePayload", () => {
	it("reads the run id and attempt", () => {
		expect(parseWakePayload(payload())).toEqual({
			ok: true,
			runId: 9876543210,
			runAttempt: 2,
		});
	});

	it("accepts the payload as a JSON string and ids as decimal strings", () => {
		expect(
			parseWakePayload(
				JSON.stringify(payload({ run_id: "9876543210", run_attempt: "3" })),
			),
		).toEqual({ ok: true, runId: 9876543210, runAttempt: 3 });
	});

	it("never takes an image or a service id from the payload", () => {
		const result = parseWakePayload(
			payload({ dokploy: { image: "evil@sha256:" + "a".repeat(64) } }),
		);
		expect(result).toEqual({ ok: true, runId: 9876543210, runAttempt: 2 });
	});

	it.each([
		["another schema", payload({ schema: "dokploy.deployment/v2" })],
		["another artifact", payload({ artifact: "something-else" })],
		["a zero run id", payload({ run_id: 0 })],
		["a fractional attempt", payload({ run_attempt: 1.5 })],
		["a negative attempt", payload({ run_attempt: -1 })],
		["a missing run id", payload({ run_id: undefined })],
		["an array", []],
		["a string that is not JSON", "nope"],
		["null", null],
	])("refuses %s", (_name, value) => {
		expect(parseWakePayload(value).ok).toBe(false);
	});
});

describe("parseWakePayload: the job and runner hints", () => {
	it("reads them when they are printable text, and leaves them out otherwise", () => {
		expect(
			parseWakePayload(payload({ job: "release", runner: "GitHub Actions 7" })),
		).toEqual({
			ok: true,
			runId: 9876543210,
			runAttempt: 2,
			job: "release",
			runner: "GitHub Actions 7",
		});
		for (const bad of ["a\nb", "", "x".repeat(121), 5, null, { a: 1 }]) {
			expect(parseWakePayload(payload({ job: bad, runner: bad }))).toEqual({
				ok: true,
				runId: 9876543210,
				runAttempt: 2,
			});
		}
	});
});
