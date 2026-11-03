import type {
	AcceptanceResult,
	AcceptedRelease,
} from "@dokploy/server/services/gha-connect/acceptance";
import {
	MAX_VERIFICATIONS_PER_TICK,
	pollConnectionWatch,
	RECHECK_BACKOFF_MS,
	RECHECK_MAX_AGE_MS,
	resetConnectionPollState,
} from "@dokploy/server/services/gha-connect/poll";
import {
	mergeProcessed,
	PROCESSED_CAP,
} from "@dokploy/server/services/gha-connect/processed";
import {
	resetPollState,
	STATUS_TEXT,
} from "@dokploy/server/services/github-deployments/poll-core";
import { beforeEach, describe, expect, it } from "vitest";
import { harness, NOW, release, wake, watchRow } from "./poll-harness";

beforeEach(() => {
	resetPollState();
	resetConnectionPollState();
});

const accepted = (r: AcceptedRelease): AcceptanceResult => ({
	kind: "accepted",
	release: r,
});

describe("pollConnectionWatch: finding the releases", () => {
	it("ignores deployments that are not wake-ups for this service and never asks GitHub about them", async () => {
		const h = harness({
			deployments: [
				wake(13, 7, 1, "dokploy:worker"),
				{ id: 12, task: "deploy", payload: {} },
				{ id: 11 },
			],
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.accepted).toEqual([]);
		expect(h.statuses()).toEqual([]);
		// Everything new was handled: the etag is saved.
		expect(h.patches.at(-1)).toMatchObject({ etag: 'W/"new"' });
	});

	it("answers an unreadable wake-up with a failure", async () => {
		const h = harness({
			deployments: [
				{ id: 11, task: "dokploy:web", payload: { schema: "nope" } },
			],
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.statuses()).toMatchObject([
			{ deployment: 11, state: "failure", description: STATUS_TEXT.unreadable },
		]);
	});

	it("passes the job and runner the wake-up named to acceptance as a hint", async () => {
		const h = harness({
			deployments: [
				{
					id: 11,
					task: "dokploy:web",
					payload: {
						schema: "dokploy.deployment/v1",
						run_id: 100,
						run_attempt: 1,
						artifact: "dokploy-release",
						job: "release",
						runner: "ubuntu-1",
					},
				},
			],
			results: { 100: accepted(release(100)) },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.acceptHints).toEqual([{ job: "release", runner: "ubuntu-1" }]);
	});

	it("verifies a run once even when several Deployments name it", async () => {
		const h = harness({
			deployments: [wake(12, 100), wake(11, 100)],
			results: { 100: accepted(release(100)) },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.accepted).toEqual([100]);
	});

	it("does not look again at a run it already handled", async () => {
		const h = harness({
			deployments: [wake(11, 100)],
			processed: [
				{
					runId: 100,
					attempt: 1,
					outcome: "accepted",
					at: new Date(NOW).toISOString(),
				},
			],
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.accepted).toEqual([]);
		expect(h.statuses()).toEqual([]);
	});

	it("looks only at the newest runs first and supersedes the older ones without verifying them", async () => {
		const h = harness({
			deployments: [wake(13, 300), wake(12, 200), wake(11, 100)],
			results: { 300: accepted(release(300)) },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.accepted).toEqual([300]);
		expect(h.statuses().slice(0, 2)).toMatchObject([
			{
				deployment: 11,
				state: "inactive",
				description: STATUS_TEXT.superseded,
			},
			{
				deployment: 12,
				state: "inactive",
				description: STATUS_TEXT.superseded,
			},
		]);
	});

	it("verifies at most five runs per tick and leaves the rest for the next one", async () => {
		const ids = Array.from(
			{ length: MAX_VERIFICATIONS_PER_TICK + 2 },
			(_, i) => 11 + i,
		);
		const results: Record<number, AcceptanceResult> = {};
		for (const id of ids) {
			results[id * 10] = {
				kind: "refused",
				code: "run-failed",
				message: "The run concluded failure",
				block: false,
				recheck: false,
			};
		}
		const h = harness({
			deployments: [...ids].reverse().map((id) => wake(id, id * 10)),
			results,
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.accepted).toHaveLength(MAX_VERIFICATIONS_PER_TICK);
		// The newest were looked at; the two oldest wait, so the etag is not saved.
		expect(h.accepted).toEqual(
			[...ids]
				.reverse()
				.slice(0, MAX_VERIFICATIONS_PER_TICK)
				.map((id) => id * 10),
		);
		expect(h.patches.some((p) => p.etag === 'W/"new"')).toBe(false);
	});

	it("takes its verifications from the repository's budget when it has one", async () => {
		const h = harness({
			deployments: [wake(11, 100)],
			results: { 100: accepted(release(100)) },
		});
		h.deps.takeVerification = () => false;
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.accepted).toEqual([]);
		expect(h.patches.at(-1)).toMatchObject({
			lastError: expect.stringContaining("next tick"),
		});
	});
});

describe("pollConnectionWatch: what acceptance says", () => {
	const refused = (
		code: string,
		over: { block?: boolean; recheck?: boolean } = {},
	): AcceptanceResult => ({
		kind: "refused",
		code: code as never,
		message: `refused: ${code}`,
		block: over.block ?? false,
		recheck: over.recheck ?? false,
	});

	it("blocks the service and answers a failure when the release itself is broken", async () => {
		const h = harness({
			deployments: [wake(11, 100)],
			results: { 100: refused("manifest-binding", { block: true }) },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.events).toEqual(["release-refused"]);
		expect(h.statuses()).toMatchObject([
			{ deployment: 11, state: "failure", description: STATUS_TEXT.refused },
		]);
		expect(h.processedWrites[0]?.[0]).toMatchObject({
			runId: 100,
			outcome: "manifest-binding",
		});
	});

	it("answers a failed run with its own text and does not block", async () => {
		const h = harness({
			deployments: [wake(11, 100)],
			results: { 100: refused("run-failed") },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.events).toEqual([]);
		expect(h.statuses()).toMatchObject([
			{ state: "failure", description: STATUS_TEXT.runFailed },
		]);
	});

	it("falls back to the next older release when the newest is refused", async () => {
		const h = harness({
			deployments: [wake(12, 200), wake(11, 100)],
			results: { 200: refused("run-failed"), 100: accepted(release(100)) },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.accepted).toEqual([200, 100]);
		expect(h.recordedAccepted).toEqual([{ run: 100, deployment: 11 }]);
	});

	it("waits for a run that is still building: nothing answered, cursor and etag stay", async () => {
		const h = harness({
			deployments: [wake(11, 100)],
			results: { 100: { kind: "pending", reason: "The run is in_progress" } },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.statuses()).toEqual([]);
		expect(h.patches.some((p) => p.lastSeenDeploymentId !== undefined)).toBe(
			false,
		);
		expect(h.patches.some((p) => p.etag !== undefined)).toBe(false);
		expect(h.patches.at(-1)).toMatchObject({
			lastError: "The run is in_progress",
		});
	});

	it("pauses the connection on a rate limit and records nothing", async () => {
		const h = harness({
			deployments: [wake(11, 100)],
			results: {
				100: {
					kind: "retry",
					cause: { kind: "rate-limited", retryAt: NOW + 90_000 },
				},
			},
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.blocks.get("connection:gh1")).toBe(NOW + 90_000);
		expect(h.processedWrites).toEqual([]);
		expect(h.statuses()).toEqual([]);
	});

	it("marks the GitHub connection revoked when the token is dead", async () => {
		const h = harness({
			deployments: [wake(11, 100)],
			results: { 100: { kind: "retry", cause: { kind: "unauthorized" } } },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.events).toEqual(["revoked gh1"]);
	});

	it("answers a superseded attempt without blocking and records it as handled", async () => {
		const h = harness({
			deployments: [wake(11, 100)],
			results: { 100: { kind: "superseded", reason: "newer attempt" } },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.events).toEqual([]);
		expect(h.statuses()).toMatchObject([{ state: "inactive" }]);
		expect(h.processedWrites[0]?.[0]).toMatchObject({ outcome: "superseded" });
	});

	it("does not record a run as handled when its status could not be posted", async () => {
		const h = harness({
			deployments: [wake(11, 100)],
			results: { 100: refused("run-failed") },
			statusReplies: [500],
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.processedWrites).toEqual([]);
	});

	it("never throws: a failing acceptance backs the watch off", async () => {
		const h = harness({ deployments: [wake(11, 555)], results: {} });
		await expect(
			pollConnectionWatch(watchRow(), h.deps),
		).resolves.toBeUndefined();
		expect(h.blocks.get("watch:w1")).toBeGreaterThan(NOW);
	});

	it("a pull release that matches what runs deploys nothing and connects the service", async () => {
		const h = harness({
			deployments: [wake(11, 100)],
			results: { 100: { kind: "noop", release: release(100) } },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.noops).toEqual([11]);
		expect(h.events).toEqual(["release-deployed"]);
		expect(h.started).toEqual([]);
		expect(h.statuses()).toMatchObject([
			{ state: "success", description: STATUS_TEXT.alreadyDeployed },
		]);
	});
});

describe("pollConnectionWatch: refusals that a fix on GitHub clears", () => {
	const wider: AcceptanceResult = {
		kind: "refused",
		code: "policy-wider",
		message: "The environment allows more than the tracked branch",
		block: true,
		recheck: true,
	};

	it("blocks, posts nothing and asks again later without blocking the whole watch", async () => {
		const h = harness({
			deployments: [wake(11, 100)],
			results: { 100: wider },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.events).toEqual(["release-refused"]);
		expect(h.statuses()).toEqual([]);
		expect(h.processedWrites).toEqual([]);
		// The watch is NOT blocked: a release waiting at the gate keeps being looked at.
		expect(h.blocks.has("watch:w1")).toBe(false);
	});

	it("does not ask again before the back-off ends, and asks again after", async () => {
		const first = harness({
			deployments: [wake(11, 100)],
			results: { 100: wider },
		});
		await pollConnectionWatch(watchRow(), first.deps);
		const soon = harness({
			deployments: [wake(11, 100)],
			results: { 100: wider },
			now: NOW + RECHECK_BACKOFF_MS - 1_000,
		});
		await pollConnectionWatch(watchRow(), soon.deps);
		expect(soon.accepted).toEqual([]);
		const later = harness({
			deployments: [wake(11, 100)],
			results: { 100: wider },
			now: NOW + RECHECK_BACKOFF_MS + 1_000,
		});
		await pollConnectionWatch(watchRow(), later.deps);
		expect(later.accepted).toEqual([100]);
	});

	it("gives up after 24 hours with a final refusal that does not block again", async () => {
		const old = new Date(NOW - RECHECK_MAX_AGE_MS - 60_000).toISOString();
		const h = harness({
			deployments: [{ ...wake(11, 100), created_at: old }],
			results: { 100: wider },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		// The refusal itself still reports the block it always did, but the run is now handled.
		expect(h.statuses()).toMatchObject([
			{ deployment: 11, state: "failure", description: STATUS_TEXT.refused },
		]);
		expect(h.processedWrites[0]?.[0]).toMatchObject({
			runId: 100,
			outcome: "recheck-expired",
		});
	});

	it("keeps asking while the Deployment is younger than 24 hours", async () => {
		const young = new Date(NOW - 60 * 60 * 1000).toISOString();
		const h = harness({
			deployments: [{ ...wake(11, 100), created_at: young }],
			results: { 100: wider },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.processedWrites).toEqual([]);
		expect(h.statuses()).toEqual([]);
	});
});

describe("pollConnectionWatch: push releases and releases of several services", () => {
	it("verifies a pushed release without deploying it, and settles it", async () => {
		const h = harness({
			deployments: [wake(11, 100)],
			results: { 100: accepted(release(100, "push")) },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.verifiedPush).toEqual([11]);
		expect(h.recordedAccepted).toEqual([]);
		expect(h.started).toEqual([]);
		expect(h.gateCalls).toEqual([]);
		expect(h.statuses()).toMatchObject([
			{
				deployment: 11,
				state: "success",
				description: STATUS_TEXT.verifiedPush,
			},
		]);
		expect(h.processedWrites[0]?.[0]).toMatchObject({
			outcome: "verified-push",
		});
	});

	it("holds a multi-service release until every service has its Deployment", async () => {
		const multi = release(100, "pull", { releaseServices: ["web", "worker"] });
		const waiting = harness({
			deployments: [wake(11, 100)],
			results: { 100: accepted(multi) },
		});
		await pollConnectionWatch(watchRow(), waiting.deps);
		expect(waiting.recordedAccepted).toEqual([]);
		expect(waiting.patches.at(-1)).toMatchObject({
			lastError: expect.stringContaining("worker"),
		});

		const whole = harness({
			deployments: [wake(12, 100, 1, "dokploy:worker"), wake(11, 100)],
			results: { 100: accepted(multi) },
		});
		await pollConnectionWatch(watchRow(), whole.deps);
		expect(whole.recordedAccepted).toEqual([{ run: 100, deployment: 11 }]);
	});

	it("blocks a multi-service release that is still incomplete 15 minutes after the run ended", async () => {
		const multi = release(100, "pull", {
			releaseServices: ["web", "worker"],
			runEndedAt: NOW - 15 * 60 * 1000 - 1_000,
		});
		const h = harness({
			deployments: [wake(11, 100)],
			results: { 100: accepted(multi) },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.eventLog).toMatchObject([
			{
				type: "release-refused",
				message: expect.stringContaining("no Deployment for worker"),
			},
		]);
		expect(h.recordedAccepted).toEqual([]);
		expect(h.statuses()).toMatchObject([{ state: "failure" }]);
		// A block that is not the gate's: nothing will deploy through it.
		expect(h.started).toEqual([]);
	});
});

describe("mergeProcessed", () => {
	it("keeps the newest first and drops the oldest beyond the cap", () => {
		const entry = (n: number) => ({
			runId: n,
			attempt: 1,
			outcome: "x",
			at: "2026-11-03T00:00:00.000Z",
		});
		const existing = Array.from({ length: PROCESSED_CAP }, (_, i) =>
			entry(i + 1),
		);
		const merged = mergeProcessed(existing, [entry(1000)]);
		expect(merged).toHaveLength(PROCESSED_CAP);
		expect(merged[0]?.runId).toBe(1000);
		expect(merged.at(-1)?.runId).toBe(PROCESSED_CAP - 1);
	});
});
