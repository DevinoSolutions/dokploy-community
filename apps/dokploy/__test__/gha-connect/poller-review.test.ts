import {
	pollConnectionWatch,
	resetConnectionPollState,
} from "@dokploy/server/services/gha-connect/poll";
import {
	resetPollState,
	STATUS_TEXT,
} from "@dokploy/server/services/github-deployments/poll-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	DIGEST,
	harness,
	NOW,
	pending,
	release,
	wake,
	watchRow,
} from "./poll-harness";

beforeEach(() => {
	resetPollState();
	resetConnectionPollState();
});

const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("a pull release never deploys over something newer that already ran", () => {
	it("a pushed release that is verified supersedes the older waiting pull release", async () => {
		const h = harness({
			pending: [pending(90, 11)],
			deployments: [wake(12, 100)],
			results: { 100: { kind: "accepted", release: release(100, "push") } },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.verifiedPush).toEqual([12]);
		expect(h.superseded).toEqual([["rel-90"]]);
		expect(h.clears).toEqual(["c1"]);
		expect(h.started).toEqual([]);
		expect(h.gateCalls).toEqual([]);
		expect(h.statuses()).toContainEqual(
			expect.objectContaining({
				deployment: 11,
				state: "inactive",
				description: STATUS_TEXT.superseded,
			}),
		);
	});

	it("keeps a waiting pull release that is newer than the pushed one", async () => {
		const h = harness({
			pending: [pending(200, 11)],
			deployments: [wake(12, 100)],
			results: { 100: { kind: "accepted", release: release(100, "push") } },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.superseded).toEqual([]);
		expect(h.started.map((s) => s.id)).toEqual([11]);
	});

	it("an already-running release (a noop) supersedes the older waiting pull release", async () => {
		const h = harness({
			pending: [pending(90, 11)],
			deployments: [wake(12, 100)],
			results: { 100: { kind: "noop", release: release(100) } },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.noops).toEqual([12]);
		expect(h.superseded).toEqual([["rel-90"]]);
		expect(h.started).toEqual([]);
	});

	it("drops waiting releases that are not newer than the deployed run and attempt", async () => {
		const h = harness({
			pending: [
				pending(100, 11),
				pending(100, 12, { releaseId: "rel-100b", runAttempt: 2 }),
				pending(90, 13, { releaseId: "rel-90" }),
			],
			deployments: null,
			factsOverride: {
				deployed: {
					sha: "b".repeat(40),
					runId: 100,
					attempt: 2,
					digests: [DIGEST],
				},
			},
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.superseded.flat().sort()).toEqual([
			"rel-100",
			"rel-100b",
			"rel-90",
		]);
		expect(h.started).toEqual([]);
		expect(h.gateCalls).toEqual([]);
	});

	it("a later attempt of the deployed run is newer and starts", async () => {
		const h = harness({
			pending: [pending(100, 12, { releaseId: "rel-100b", runAttempt: 2 })],
			deployments: null,
			factsOverride: {
				deployed: {
					sha: "b".repeat(40),
					runId: 100,
					attempt: 1,
					digests: [DIGEST],
				},
			},
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.superseded).toEqual([]);
		expect(h.started.map((s) => s.id)).toEqual([12]);
	});
});

describe("the first tick keeps what was made since Connect", () => {
	const first = () => watchRow({ lastSeenDeploymentId: null, etag: null });

	it("accepts a wake-up of this service created after the connection and skips older history", async () => {
		const h = harness({
			connectedAt: NOW - 3_600_000,
			deployments: [
				{ ...wake(30, 200), created_at: at(1_800_000) },
				{ ...wake(20, 150, 1, "dokploy:docs"), created_at: at(1_700_000) },
				{ ...wake(5, 90), created_at: at(7_200_000) },
			],
			results: { 200: { kind: "accepted", release: release(200) } },
		});
		await pollConnectionWatch(first(), h.deps);
		expect(h.accepted).toEqual([200]);
		expect(h.recordedAccepted).toEqual([{ run: 200, deployment: 30 }]);
		expect(h.started.map((s) => s.id)).toEqual([30]);
	});

	it("only baselines when nothing was made since Connect", async () => {
		const h = harness({
			connectedAt: NOW - 3_600_000,
			deployments: [{ ...wake(5, 90), created_at: at(7_200_000) }],
		});
		await pollConnectionWatch(first(), h.deps);
		expect(h.accepted).toEqual([]);
		expect(h.started).toEqual([]);
		expect(h.patches[0]).toMatchObject({ lastSeenDeploymentId: 5 });
	});
});

describe("a connection that vanished mid-tick", () => {
	it("starts nothing when the connection is gone by the time the release is settled", async () => {
		const h = harness({
			pending: [pending(100, 11)],
			deployments: null,
			goneAfterFirstRead: true,
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.gateCalls).toEqual([]);
		expect(h.started).toEqual([]);
		expect(h.failed).toEqual([]);
	});
});
