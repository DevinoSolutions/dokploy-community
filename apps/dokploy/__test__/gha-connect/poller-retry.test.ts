import {
	pollConnectionWatch,
	resetConnectionPollState,
} from "@dokploy/server/services/gha-connect/poll";
import { registryRetryText } from "@dokploy/server/services/gha-connect/registry-retry";
import {
	type EndState,
	type PollDeps,
	prepareTick,
	resetPollState,
	STATUS_TEXT,
	type WatchRow,
} from "@dokploy/server/services/github-deployments/poll-core";
import { beforeEach, describe, expect, it } from "vitest";
import { scriptedFetch } from "../github-deployments/helpers";
import { harness, NOW, pending, release, wake, watchRow } from "./poll-harness";

beforeEach(() => {
	resetPollState();
	resetConnectionPollState();
});

describe("a release that waits for the registry is started again by the poll", () => {
	it("does not start it, nor ask the gate, before its time", async () => {
		const h = harness({
			deployments: null,
			pending: [
				pending(100, 11, { retryAt: new Date(NOW + 30_000), retryAttempt: 1 }),
			],
			// A gate that would block must not matter: the release passed it before.
			decision: {
				state: "blocked",
				reason: "x",
				failedNames: [],
				neverReported: [],
				unfinished: [],
			},
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.started).toHaveLength(0);
		expect(h.gateCalls).toHaveLength(0);
		expect(h.failed).toEqual([]);
		expect(h.statuses()).toEqual([]);
	});

	it("starts it at its time without a second gate evaluation", async () => {
		const h = harness({
			deployments: null,
			pending: [
				pending(100, 11, { retryAt: new Date(NOW - 1_000), retryAttempt: 1 }),
			],
			decision: {
				state: "blocked",
				reason: "x",
				failedNames: [],
				neverReported: [],
				unfinished: [],
			},
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.gateCalls).toHaveLength(0);
		expect(h.started).toHaveLength(1);
		expect(h.started[0]).toMatchObject({
			id: 11,
			payload: { release: { runId: 100, delivery: "pull" } },
		});
		expect(h.statuses().at(-1)).toMatchObject({
			deployment: 11,
			state: "in_progress",
			description: STATUS_TEXT.accepted,
		});
	});

	it("looks at the gate again when its settings changed since the release passed it", async () => {
		const h = harness({
			deployments: null,
			// The gate version in the harness is 3.
			pending: [
				pending(100, 11, {
					retryAt: new Date(NOW - 1_000),
					retryAttempt: 1,
					retryGateVersion: 2,
				}),
			],
			decision: {
				state: "waiting",
				reason: "checks running",
				pendingNames: [],
			},
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.gateCalls).toHaveLength(1);
		expect(h.started).toHaveLength(0);
		// Once the gate lets it go, it starts.
		const passing = harness({
			deployments: null,
			pending: [
				pending(100, 11, {
					retryAt: new Date(NOW - 1_000),
					retryAttempt: 1,
					retryGateVersion: 2,
				}),
			],
		});
		await pollConnectionWatch(watchRow(), passing.deps);
		expect(passing.gateCalls).toHaveLength(1);
		expect(passing.started).toHaveLength(1);
	});

	it("skips the gate when its settings are the ones the release passed under", async () => {
		const h = harness({
			deployments: null,
			pending: [
				pending(100, 11, {
					retryAt: new Date(NOW - 1_000),
					retryAttempt: 1,
					retryGateVersion: 3,
				}),
			],
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.gateCalls).toHaveLength(0);
		expect(h.started).toHaveLength(1);
	});

	it("a retry whose start is stale waits for the next tick instead of failing", async () => {
		const h = harness({
			deployments: null,
			pending: [
				pending(100, 11, { retryAt: new Date(NOW - 1_000), retryAttempt: 2 }),
			],
			startOutcome: { kind: "stale" },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.failed).toEqual([]);
		expect(h.stored).toHaveLength(1);
	});

	it("a newer accepted release supersedes the one that is retrying", async () => {
		const h = harness({
			deployments: [wake(12, 200)],
			pending: [
				pending(100, 11, { retryAt: new Date(NOW + 60_000), retryAttempt: 1 }),
			],
			results: { 200: { kind: "accepted", release: release(200) } },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		// The old one is retired like any older accepted release: answered inactive, marked superseded.
		expect(h.superseded).toEqual([["rel-100"]]);
		expect(h.statuses()).toContainEqual(
			expect.objectContaining({
				deployment: 11,
				state: "inactive",
				description: STATUS_TEXT.superseded,
			}),
		);
		// And the newer one goes out in the same tick.
		expect(h.started).toHaveLength(1);
		expect(h.started[0]?.id).toBe(12);
	});

	it("does not start while the connection is blocked for another reason", async () => {
		const h = harness({
			deployments: null,
			pending: [
				pending(100, 11, { retryAt: new Date(NOW - 1_000), retryAttempt: 1 }),
			],
			gate: { state: "blocked", gateBlocked: false },
		});
		await pollConnectionWatch(watchRow(), h.deps);
		expect(h.started).toHaveLength(0);
	});
});

describe("the end of a deployment that the registry refused", () => {
	const watchInflight = (overrides: Partial<WatchRow> = {}): WatchRow =>
		watchRow({
			inflightDeploymentId: 11,
			inflightStartedAt: new Date(NOW - 20_000),
			...overrides,
		});

	const deps = (
		end: EndState,
		verdict: Awaited<ReturnType<NonNullable<PollDeps["onDeployEnded"]>>>,
		replies: Parameters<typeof scriptedFetch>[0] = [{ status: 201 }],
	) => {
		const { fetch, calls } = scriptedFetch(replies);
		const patches: unknown[] = [];
		const ended: EndState[] = [];
		const value: PollDeps = {
			fetch,
			now: () => NOW,
			loadToken: async () => "gho_secret",
			markRevoked: async () => {},
			blockedUntil: () => undefined,
			block: () => {},
			patchWatch: async (_id, patch) => {
				patches.push(patch);
			},
			startDeploy: async () => ({ kind: "started" }),
			inspectInflight: async () => end as never,
			log: () => {},
			onDeployEnded: async (_w, e) => {
				ended.push(e);
				return verdict;
			},
		};
		return { deps: value, calls, patches, ended };
	};

	const bodies = (calls: Array<{ method: string; body?: string }>) =>
		calls
			.filter((c) => c.method === "POST")
			.map((c) => JSON.parse(c.body ?? "{}"));

	it("tells GitHub the release waits instead of failing it, and frees the watch", async () => {
		const text = registryRetryText(1, 60_000);
		const h = deps(
			{ state: "error", registryAccess: true },
			{ kind: "retry", text },
		);
		expect(await prepareTick(watchInflight(), h.deps)).toBeNull();
		expect(h.ended).toEqual([{ state: "error", registryAccess: true }]);
		expect(bodies(h.calls)).toEqual([
			{ state: "queued", description: text, auto_inactive: false },
		]);
		expect(h.patches.at(-1)).toMatchObject({
			inflightDeploymentId: null,
			inflightStartedAt: null,
		});
	});

	it("keeps the deployment in flight and asks again when GitHub could not be told yet", async () => {
		const text = registryRetryText(1, 60_000);
		const h = deps(
			{ state: "error", registryAccess: true },
			{ kind: "retry", text },
			[{ status: 500 }],
		);
		await prepareTick(watchInflight(), h.deps);
		expect(h.patches).toEqual([]);
		await prepareTick(watchInflight(), h.deps);
		// The connection hook runs again; it answers the same retry without scheduling a second one.
		expect(h.ended).toHaveLength(2);
	});

	it("any other error is still reported to GitHub as a failure", async () => {
		const h = deps({ state: "error" }, { kind: "settled" });
		await prepareTick(watchInflight(), h.deps);
		expect(bodies(h.calls)[0]).toMatchObject({
			state: "failure",
			description: STATUS_TEXT.failed,
		});
		expect(h.patches.at(-1)).toMatchObject({ inflightDeploymentId: null });
	});

	it("a retry that ran out is reported as a failure too", async () => {
		const h = deps(
			{ state: "error", registryAccess: true },
			{ kind: "exhausted", note: "gave up" },
		);
		await prepareTick(watchInflight(), h.deps);
		expect(bodies(h.calls)[0]).toMatchObject({ state: "failure" });
	});
});
