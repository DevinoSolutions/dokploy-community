import {
	handleFresh,
	type PollDeps,
	pollWatch,
	prepareTick,
	reportEnd,
	resetPollState,
	STATUS_TEXT,
	type WatchPatch,
	type WatchRow,
} from "@dokploy/server/services/github-deployments/poll-core";
import { beforeEach, describe, expect, it } from "vitest";
import { scriptedFetch } from "../github-deployments/helpers";

const NOW = 1_700_000_000_000;

const watch = (overrides: Partial<WatchRow> = {}): WatchRow => ({
	watchId: "w1",
	organizationId: "org1",
	serviceType: "compose",
	serviceId: "svc1",
	connectionId: "gh1",
	owner: "DevinoSolutions",
	repo: "voicelabs",
	environment: "development",
	enabled: true,
	lastSeenDeploymentId: 10,
	etag: 'W/"old"',
	inflightDeploymentId: null,
	inflightStartedAt: null,
	postLogUrl: false,
	...overrides,
});

const deps = (
	replies: Parameters<typeof scriptedFetch>[0],
	extra: Partial<PollDeps> = {},
) => {
	const { fetch, calls } = scriptedFetch(replies);
	const patches: WatchPatch[] = [];
	const ended: string[] = [];
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
		inspectInflight: async () => ({ state: "done" }),
		log: () => {},
		onDeployEnded: async (_w, end) => {
			ended.push(end.state);
		},
		...extra,
	};
	return { deps: value, calls, patches, ended };
};

const bodies = (calls: Array<{ method: string; body?: string }>) =>
	calls
		.filter((c) => c.method === "POST")
		.map((c) => JSON.parse(c.body ?? "{}"));

beforeEach(() => resetPollState());

describe("prepareTick: the part of a tick every watch shares", () => {
	it("ends the tick on a 304 for a plain watch", async () => {
		const h = deps([{ status: 304 }]);
		expect(await prepareTick(watch(), h.deps)).toBeNull();
		expect(h.patches).toEqual([
			{ lastCheckedAt: new Date(NOW), lastError: null },
		]);
	});

	it("hands the tick on after a 304 when the caller needs every tick (a waiting release)", async () => {
		const h = deps([{ status: 304 }]);
		const tick = await prepareTick(watch(), h.deps, {
			continueOnNotModified: true,
		});
		expect(tick).toMatchObject({
			notModified: true,
			lastSeen: 10,
			listed: { kind: "ok", deployments: [] },
		});
	});

	it("never hands a first poll on: it only baselines the cursor", async () => {
		const h = deps([{ json: [{ id: 5 }, { id: 3 }], headers: { etag: "e1" } }]);
		const tick = await prepareTick(
			watch({ lastSeenDeploymentId: null }),
			h.deps,
			{ continueOnNotModified: true },
		);
		expect(tick).toBeNull();
		expect(h.patches[0]).toMatchObject({ lastSeenDeploymentId: 5, etag: "e1" });
	});

	it("reports the end of a connection's deployment to the connection before it tells GitHub", async () => {
		const h = deps([{ status: 201 }], {
			inspectInflight: async () => ({ state: "done" }),
			environmentUrl: async () => "https://app.example.com",
		});
		const tick = await prepareTick(
			watch({
				inflightDeploymentId: 11,
				inflightStartedAt: new Date(NOW - 1_000),
				ghaConnectionId: "c1",
			}),
			h.deps,
		);
		expect(tick).toBeNull();
		expect(h.ended).toEqual(["done"]);
		expect(bodies(h.calls)).toEqual([
			{
				state: "success",
				description: STATUS_TEXT.done,
				environment_url: "https://app.example.com",
				auto_inactive: false,
			},
		]);
		expect(h.patches.at(-1)).toMatchObject({ inflightDeploymentId: null });
	});

	it("does not call the connection hook, nor add its fields, for a plain watch", async () => {
		const h = deps([{ status: 201 }], {
			inspectInflight: async () => ({ state: "done" }),
			environmentUrl: async () => "https://app.example.com",
		});
		await prepareTick(
			watch({
				inflightDeploymentId: 11,
				inflightStartedAt: new Date(NOW - 1_000),
			}),
			h.deps,
		);
		expect(h.ended).toEqual([]);
		expect(bodies(h.calls)[0]).not.toHaveProperty("environment_url");
		expect(bodies(h.calls)[0]).not.toHaveProperty("auto_inactive");
	});

	it("a failed deploy is reported as a failure with no environment link", async () => {
		const h = deps([{ status: 201 }], {
			inspectInflight: async () => ({ state: "error" }),
			environmentUrl: async () => "https://app.example.com",
		});
		await prepareTick(
			watch({
				inflightDeploymentId: 11,
				inflightStartedAt: new Date(NOW - 1_000),
				ghaConnectionId: "c1",
			}),
			h.deps,
		);
		expect(h.ended).toEqual(["error"]);
		expect(bodies(h.calls)[0]).toMatchObject({ state: "failure" });
		expect(bodies(h.calls)[0]).not.toHaveProperty("environment_url");
	});

	it("repeats onDeployEnded when GitHub could not be told yet", async () => {
		const h = deps([{ status: 500 }], {
			inspectInflight: async () => ({ state: "done" }),
		});
		await prepareTick(
			watch({
				inflightDeploymentId: 11,
				inflightStartedAt: new Date(NOW - 1_000),
				ghaConnectionId: "c1",
			}),
			h.deps,
		);
		await prepareTick(
			watch({
				inflightDeploymentId: 11,
				inflightStartedAt: new Date(NOW - 1_000),
				ghaConnectionId: "c1",
			}),
			h.deps,
		);
		expect(h.ended).toEqual(["done", "done"]);
	});
});

describe("reportEnd", () => {
	it("a timeout is a failure", async () => {
		const h = deps([{ status: 201 }]);
		const settled = await reportEnd(
			h.deps,
			watch({ inflightDeploymentId: 11 }),
			"gho_secret",
			{ state: "timeout" },
		);
		expect(settled).toEqual({ settled: true });
		expect(bodies(h.calls)[0]).toMatchObject({
			state: "failure",
			description: STATUS_TEXT.timeout,
		});
	});
});

describe("handleFresh", () => {
	it("moves the caller's progress as it answers, and holds at a hold without moving past it", async () => {
		const h = deps([{ status: 201 }]);
		const progress = { cursor: 10 as number | null };
		await handleFresh(
			watch(),
			h.deps,
			{
				token: "gho_secret",
				now: NOW,
				listed: { kind: "ok", deployments: [], etag: "e2" },
				lastSeen: 10,
			},
			[{ id: 11 }, { id: 12 }, { id: 13 }],
			new Map([
				[11, { kind: "ignore", reason: "not ours" }],
				[12, { kind: "hold", reason: "still building" }],
				[13, { kind: "ignore", reason: "not ours" }],
			]),
			undefined,
			progress,
		);
		expect(progress.cursor).toBe(11);
		expect(h.patches.at(-1)).toMatchObject({ lastError: "still building" });
		expect(h.patches.some((p) => p.etag !== undefined)).toBe(false);
	});

	it("answers an invalid deployment with the text it names", async () => {
		const h = deps([{ status: 201 }]);
		await handleFresh(
			watch(),
			h.deps,
			{
				token: "gho_secret",
				now: NOW,
				listed: { kind: "ok", deployments: [], etag: "e2" },
				lastSeen: 10,
			},
			[{ id: 11 }],
			new Map([
				[11, { kind: "invalid", reason: "x", statusText: STATUS_TEXT.refused }],
			]),
			undefined,
		);
		expect(bodies(h.calls)[0]).toMatchObject({
			state: "failure",
			description: STATUS_TEXT.refused,
		});
	});
});

describe("a plain watch is unchanged by the split", () => {
	it("still deploys the newest valid deployment and answers older ones as superseded", async () => {
		const image = `ghcr.io/devinosolutions/x@sha256:${"b".repeat(64)}`;
		const started: number[] = [];
		const h = deps(
			[
				{
					json: [
						{ id: 12, payload: { dokploy: { serviceId: "svc1", image } } },
						{ id: 11, payload: { dokploy: { serviceId: "svc1", image } } },
					],
					headers: { etag: "e2" },
				},
				{ status: 201 },
				{ status: 201 },
			],
			{
				startDeploy: async (_w, d) => {
					started.push(d.id);
					return { kind: "started" };
				},
			},
		);
		await pollWatch(watch(), h.deps);
		expect(started).toEqual([12]);
		expect(bodies(h.calls).map((b) => b.state)).toEqual([
			"inactive",
			"in_progress",
		]);
	});
});
