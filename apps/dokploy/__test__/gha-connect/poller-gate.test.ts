import type { AcceptanceResult } from "@dokploy/server/services/gha-connect/acceptance";
import {
	BACKUP_RETRY_MS,
	pollConnectionWatch,
	resetConnectionPollState,
} from "@dokploy/server/services/gha-connect/poll";
import {
	MAX_START_ATTEMPTS,
	resetPollState,
	STATUS_TEXT,
} from "@dokploy/server/services/github-deployments/poll-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	DIGEST,
	harness,
	NOW,
	pending,
	REPOSITORY,
	release,
	wake,
	watchRow,
} from "./poll-harness";

/** Let a backup that runs outside the tick finish. */
const flush = async () => {
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
	resetPollState();
	resetConnectionPollState();
});

const accepted = (runId: number): AcceptanceResult => ({
	kind: "accepted",
	release: release(runId),
});

describe("a release goes through the deploy gate before it starts", () => {
	it("image mode: records the accepted release, then starts it in the same tick", async () => {
		const h = harness({
			deployments: [wake(11, 100)],
			results: { 100: accepted(100) },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.recordedAccepted).toEqual([{ run: 100, deployment: 11 }]);
		expect(h.processedWrites[0]?.[0]).toMatchObject({
			runId: 100,
			outcome: "accepted",
		});
		expect(h.gateCalls).toHaveLength(1);
		expect(h.started).toHaveLength(1);
		expect(h.started[0]).toMatchObject({
			id: 11,
			// The cursor the start is made from is the one the discovery advanced to.
			cursor: 11,
			payload: {
				kind: "deploy",
				image: `${REPOSITORY}@${DIGEST}`,
				repository: REPOSITORY,
				digest: DIGEST,
				buildRunUrl:
					"https://github.com/DevinoSolutions/voicelabs/actions/runs/100",
				release: {
					connectionId: "c1",
					serviceKey: "web",
					runId: 100,
					runAttempt: 1,
					delivery: "pull",
					manifestReleaseId: "gh-100.1",
				},
			},
		});
		expect(h.statuses().at(-1)).toMatchObject({
			deployment: 11,
			state: "in_progress",
			description: STATUS_TEXT.accepted,
		});
	});

	it("carries every image of a multi-image release", async () => {
		const second = `registry.devino.ca/voicelabs/docs@sha256:${"f".repeat(64)}`;
		const h = harness({
			pending: [
				pending(100, 11, {
					images: [
						{
							name: "web",
							composeService: "web",
							ref: `${REPOSITORY}@${DIGEST}`,
						},
						{ name: "docs", composeService: "docs", ref: second },
					],
				}),
			],
			deployments: null,
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.started[0]?.payload).toMatchObject({
			extraImages: [
				{
					repository: "registry.devino.ca/voicelabs/docs",
					digest: `sha256:${"f".repeat(64)}`,
				},
			],
			release: { images: [{ name: "web" }, { name: "docs" }] },
		});
	});

	it("hands the gate exactly what it read: version, block flag, name and the release's last check", async () => {
		const checked = new Date(NOW - 5_000);
		const h = harness({
			pending: [
				pending(100, 11, { gateCheckedAt: checked, gateState: "waiting" }),
			],
			gate: {
				gateMode: "checks",
				gateVersion: 7,
				gateBlocked: false,
				repoFullName: "DevinoSolutions/voicelabs",
				state: "connected",
				deployedSha: "b".repeat(40),
			},
			deployments: null,
		});
		await pollConnectionWatch(watchRow(), h.deps);
		const call = h.gateCalls[0];
		expect(call?.connection).toMatchObject({
			ghaConnectionId: "c1",
			gateVersion: 7,
			gateBlocked: false,
			repoFullName: "DevinoSolutions/voicelabs",
			repoId: 42,
			state: "connected",
			gateMode: "checks",
		});
		expect(call?.release).toMatchObject({
			releaseId: "rel-100",
			runId: 100,
			gateCheckedAt: checked,
			gateState: "waiting",
		});
		expect(call?.store).toBe(h.deps.gateStore);
		expect(call?.appSlug).toBeNull();
	});

	it("a waiting gate posts queued once and starts nothing; a new reason is posted again", async () => {
		let reason = "Waiting for CI: build";
		const h = harness({
			pending: [pending(100, 11)],
			deployments: null,
			decision: () => ({ state: "waiting", reason, pendingNames: ["build"] }),
		});
		await pollConnectionWatch(watchRow(), h.deps);
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.started).toEqual([]);
		expect(h.statuses()).toMatchObject([
			{ deployment: 11, state: "queued", description: "Waiting for CI: build" },
		]);
		reason = "changed";
		h.deps.runGate = async () => ({
			state: "waiting",
			reason: "x",
			pendingNames: ["build", "lint"],
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.statuses().map((s) => s.description)).toEqual([
			"Waiting for CI: build",
			"Waiting for CI: build, lint",
		]);
	});

	it("a blocked gate posts the reason as a failure once and starts nothing", async () => {
		const h = harness({
			pending: [pending(100, 11)],
			deployments: null,
			decision: {
				state: "blocked",
				reason: "Check test failed",
				failedNames: ["test"],
				neverReported: [],
				unfinished: [],
			},
		});
		await pollConnectionWatch(watchRow(), h.deps);
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.started).toEqual([]);
		expect(h.statuses()).toMatchObject([
			{ deployment: 11, state: "failure", description: "Check test failed" },
		]);
	});

	it("looks at a waiting release on every tick even when the list answers 304", async () => {
		const decisions: Array<"waiting" | "deploy"> = [
			"waiting",
			"waiting",
			"deploy",
		];
		const h = harness({
			pending: [pending(100, 11)],
			deployments: null,
			decision: () => {
				const next = decisions.shift() ?? "deploy";
				return next === "deploy"
					? { state: "deploy" }
					: { state: "waiting", reason: "Waiting for CI", pendingNames: [] };
			},
		});
		await pollConnectionWatch(watchRow(), h.deps);
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.started).toEqual([]);
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.gateCalls).toHaveLength(3);
		expect(h.started).toHaveLength(1);
	});

	it("a newer release supersedes a waiting one: the older is answered inactive and the gate's start is cleared", async () => {
		const h = harness({
			pending: [pending(100, 11), pending(200, 12)],
			deployments: null,
			decision: {
				state: "waiting",
				reason: "Waiting for CI",
				pendingNames: [],
			},
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.superseded).toEqual([["rel-100"]]);
		expect(h.clears).toEqual(["c1"]);
		expect(h.gateCalls).toHaveLength(1);
		expect(h.gateCalls[0]?.release.releaseId).toBe("rel-200");
		expect(h.statuses()).toMatchObject([
			{
				deployment: 11,
				state: "inactive",
				description: STATUS_TEXT.superseded,
			},
			{ deployment: 12, state: "queued" },
		]);
	});

	it("the later attempt of the same run wins over the earlier one", async () => {
		const h = harness({
			pending: [
				pending(100, 11),
				pending(100, 12, { releaseId: "rel-100b", runAttempt: 2 }),
			],
			deployments: null,
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.superseded).toEqual([["rel-100"]]);
		expect(h.started[0]?.id).toBe(12);
	});
});

describe("a passing gate does not deploy through a block it did not set", () => {
	it("a connection Blocked for a refused release never deploys, whatever the gate says", async () => {
		const h = harness({
			pending: [pending(100, 11)],
			deployments: null,
			gate: { state: "blocked", gateBlocked: false },
			decision: { state: "deploy" },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.started).toEqual([]);
		expect(h.statuses()).toEqual([]);
	});

	it("a block the discovery just set in this tick also stops the start", async () => {
		const h = harness({
			// The newest run is refused with a block; an older release waits at the gate.
			pending: [pending(50, 9)],
			deployments: [wake(11, 100)],
			results: {
				100: {
					kind: "refused",
					code: "manifest-binding",
					message: "bad manifest",
					block: true,
					recheck: false,
				},
			},
			decision: { state: "deploy" },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.events).toContain("release-refused");
		expect(h.started).toEqual([]);
	});

	it("a connection the gate itself blocked deploys once the gate passes", async () => {
		const h = harness({
			pending: [pending(100, 11)],
			deployments: null,
			gate: { state: "blocked", gateBlocked: true },
			decision: { state: "deploy" },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.started).toHaveLength(1);
	});

	it("a disconnected connection never deploys", async () => {
		const h = harness({
			pending: [pending(100, 11)],
			deployments: null,
			gate: { state: "disconnected" },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.started).toEqual([]);
	});

	it("a push release is never deployed, even if one is found among the accepted", async () => {
		const h = harness({
			pending: [pending(100, 11, { delivery: "push" })],
			deployments: null,
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.gateCalls).toEqual([]);
		expect(h.started).toEqual([]);
	});

	it("the gate pausing the connection (rate limit while listing) skips the start", async () => {
		const h = harness({
			pending: [pending(100, 11)],
			deployments: [wake(12, 200)],
			results: {
				200: {
					kind: "retry",
					cause: { kind: "rate-limited", retryAt: NOW + 60_000 },
				},
			},
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.gateCalls).toEqual([]);
		expect(h.started).toEqual([]);
	});
});

describe("starting the release", () => {
	it("holds the first release until the backup before the flip is done", async () => {
		let ok = false;
		const h = harness({
			pending: [pending(100, 11)],
			deployments: null,
			backup: async () => ({
				ok,
				note: ok ? "" : "The backup failed (disk full).",
			}),
		});
		// The dump runs outside the tick: the first tick only starts it.
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.started).toEqual([]);
		expect(h.patches.at(-1)).toMatchObject({
			lastError: "Backing up before the first release.",
		});
		await flush();
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.started).toEqual([]);
		expect(h.patches.at(-1)).toMatchObject({
			lastError: "The backup failed (disk full).",
		});
		expect(h.blocks.get("watch:w1")).toBe(NOW + BACKUP_RETRY_MS);
		ok = true;
		// The retry waits out its back-off.
		h.blocks.clear();
		await pollConnectionWatch(watchRow(), h.deps);
		await flush();
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.backups).toHaveLength(2);
		expect(h.started).toHaveLength(1);

		// A slow dump does not hold the tick: while it runs nothing starts.
		resetConnectionPollState();
		let release!: () => void;
		const slow = harness({
			pending: [pending(100, 11)],
			deployments: null,
			backup: () =>
				new Promise((resolve) => {
					release = () => resolve({ ok: true, note: "" });
				}),
		});
		await pollConnectionWatch(watchRow(), slow.deps);
		await pollConnectionWatch(watchRow(), slow.deps);
		expect(slow.backups).toHaveLength(1);
		expect(slow.started).toEqual([]);
		release();
		await flush();
		await pollConnectionWatch(watchRow(), slow.deps);
		expect(slow.started).toHaveLength(1);
	});

	it("does not run the backup twice for one release, nor once something is deployed", async () => {
		const first = harness({
			pending: [pending(100, 11)],
			deployments: null,
			startOutcome: { kind: "stale" },
			backup: async () => ({ ok: true, note: "" }),
		});
		await pollConnectionWatch(watchRow(), first.deps);
		await flush();
		await pollConnectionWatch(watchRow(), first.deps);
		await pollConnectionWatch(watchRow(), first.deps);
		expect(first.backups).toHaveLength(1);

		const later = harness({
			pending: [pending(100, 11)],
			deployments: null,
			factsOverride: {
				deployed: {
					sha: "b".repeat(40),
					runId: 50,
					attempt: 1,
					digests: [DIGEST],
				},
			},
		});
		await pollConnectionWatch(watchRow(), later.deps);
		expect(later.backups).toEqual([]);
		expect(later.started).toHaveLength(1);
	});

	it("a rejected start fails the release, blocks the service with the reason and answers GitHub", async () => {
		const h = harness({
			pending: [pending(100, 11)],
			deployments: null,
			startOutcome: { kind: "rejected", reason: "not the image this app runs" },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.failed).toEqual(["rel-100"]);
		expect(h.eventLog).toMatchObject([
			{ type: "release-refused", message: "not the image this app runs" },
		]);
		expect(h.statuses()).toMatchObject([
			{ deployment: 11, state: "failure", description: STATUS_TEXT.rejected },
		]);
	});

	it("a start that keeps failing is given up after three tries and answered", async () => {
		const h = harness({
			pending: [pending(100, 11)],
			deployments: null,
			startOutcome: () => {
				throw new Error("queue closed");
			},
		});
		for (let i = 0; i < MAX_START_ATTEMPTS; i++) {
			await pollConnectionWatch(watchRow(), h.deps);
			h.blocks.clear();
		}
		expect(h.failed).toEqual(["rel-100"]);
		expect(h.statuses().at(-1)).toMatchObject({
			state: "failure",
			description: STATUS_TEXT.notQueued,
		});
	});

	it("a stale start (the watch moved) writes nothing and is tried again next tick", async () => {
		const h = harness({
			pending: [pending(100, 11)],
			deployments: null,
			startOutcome: { kind: "stale" },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.failed).toEqual([]);
		expect(h.statuses()).toEqual([]);
		expect(h.stored).toHaveLength(1);
	});

	it("an accepted release without a Deployment to answer is failed, not started", async () => {
		const h = harness({
			pending: [pending(100, 11, { githubDeploymentId: null })],
			deployments: null,
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.failed).toEqual(["rel-100"]);
		expect(h.started).toEqual([]);
	});

	it("a release image that is not pinned by digest is refused, not started", async () => {
		const h = harness({
			pending: [
				pending(100, 11, {
					images: [
						{ name: "web", composeService: "web", ref: `${REPOSITORY}:latest` },
					],
				}),
			],
			deployments: null,
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.started).toEqual([]);
		expect(h.failed).toEqual(["rel-100"]);
	});
});

describe("after a restart", () => {
	it("replays nothing: the runs in `processed` are not verified again and a stored accepted release goes on", async () => {
		const h = harness({
			// The same Deployments are listed again on the first tick after the boot.
			deployments: [wake(11, 100)],
			processed: [
				{
					runId: 100,
					attempt: 1,
					outcome: "accepted",
					at: new Date(NOW - 60_000).toISOString(),
				},
			],
			pending: [pending(100, 11)],
			// Boot reads GitHub once; the gate lets the stored release go.
			decision: { state: "deploy" },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.accepted).toEqual([]);
		expect(h.recordedAccepted).toEqual([]);
		expect(h.processedWrites).toEqual([]);
		expect(h.listCalls()).toHaveLength(1);
		expect(h.started).toHaveLength(1);
		expect(h.started[0]?.id).toBe(11);
	});
});
