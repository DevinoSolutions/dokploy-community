import {
	checkReleaseComplete,
	RELEASE_COMPLETE_TIMEOUT_MS,
} from "@dokploy/server/services/gha-connect/completeness";
import { describe, expect, it } from "vitest";

const deployment = (key: string, runId = 9, runAttempt = 1) => ({
	task: `dokploy:${key}`,
	payload: {
		schema: "dokploy.deployment/v1",
		run_id: runId,
		run_attempt: runAttempt,
		artifact: "dokploy-release",
	},
});

const base = {
	ownKey: "voicekit-web",
	releaseServices: ["voicekit-web", "voicekit-engine"],
	runId: 9,
	runAttempt: 1,
	now: 1_000_000,
	runEndedAt: 1_000_000 - 60_000,
};

describe("checkReleaseComplete", () => {
	it("is complete for a release of one service", () => {
		expect(
			checkReleaseComplete({
				...base,
				releaseServices: ["voicekit-web"],
				deployments: [],
			}),
		).toEqual({ complete: true });
	});

	it("is complete when every other service has a Deployment of the same run and attempt", () => {
		expect(
			checkReleaseComplete({
				...base,
				deployments: [deployment("voicekit-engine")],
			}),
		).toEqual({ complete: true });
	});

	it("waits for a missing service and names it", () => {
		expect(checkReleaseComplete({ ...base, deployments: [] })).toEqual({
			complete: false,
			missing: ["voicekit-engine"],
			timedOut: false,
		});
	});

	it("does not count a Deployment of another run, another attempt or another task", () => {
		const result = checkReleaseComplete({
			...base,
			deployments: [
				deployment("voicekit-engine", 8, 1),
				deployment("voicekit-engine", 9, 2),
				{ task: "deploy", payload: null },
			],
		});
		expect(result).toMatchObject({
			complete: false,
			missing: ["voicekit-engine"],
		});
	});

	it("times out only after the run has been over for 15 minutes", () => {
		const within = checkReleaseComplete({
			...base,
			deployments: [],
			runEndedAt: base.now - RELEASE_COMPLETE_TIMEOUT_MS,
		});
		expect(within).toMatchObject({ timedOut: false });
		const past = checkReleaseComplete({
			...base,
			deployments: [],
			runEndedAt: base.now - RELEASE_COMPLETE_TIMEOUT_MS - 1,
		});
		expect(past).toMatchObject({ complete: false, timedOut: true });
	});

	it("never times out when GitHub did not say when the run ended", () => {
		expect(
			checkReleaseComplete({ ...base, deployments: [], runEndedAt: null }),
		).toMatchObject({
			timedOut: false,
		});
	});
});
