import {
	INFLIGHT_ROW_GRACE_MS,
	INFLIGHT_TIMEOUT_MS,
	type InflightState,
	MAX_START_ATTEMPTS,
	maxDeploymentId,
	type PollDeps,
	pollWatch,
	resetPollState,
	type StartOutcome,
	selectNewDeployments,
	type WatchPatch,
	type WatchRow,
} from "@dokploy/server/services/github-deployments/poll-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Recorded, scriptedFetch } from "./helpers";

const NOW = 1_700_000_000_000;
const DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE = `ghcr.io/devinosolutions/sendly-web@${DIGEST}`;
const dep = (id: number, serviceId = "svc1", image: unknown = IMAGE) => ({
	id,
	payload: { dokploy: { serviceId, image } },
});

const baseWatch = (overrides: Partial<WatchRow> = {}): WatchRow => ({
	watchId: "w1",
	organizationId: "org1",
	serviceType: "application",
	serviceId: "svc1",
	connectionId: "c1",
	owner: "DevinoSolutions",
	repo: "sendly",
	environment: "production",
	enabled: true,
	lastSeenDeploymentId: 10,
	etag: 'W/"old"',
	inflightDeploymentId: null,
	inflightStartedAt: null,
	...overrides,
});

const statuses = (calls: Recorded[]) =>
	calls
		.filter((c) => c.method === "POST")
		.map((c) => ({
			url: c.url.replace(
				"https://api.github.com/repos/DevinoSolutions/sendly/deployments/",
				"",
			),
			...JSON.parse(c.body ?? "{}"),
		}));

const harness = (
	fetchReplies: Parameters<typeof scriptedFetch>[0],
	options: {
		startDeploy?: PollDeps["startDeploy"];
		inflight?: InflightState;
		token?: string | null;
	} = {},
) => {
	const { fetch, calls } = scriptedFetch(fetchReplies);
	const patches: WatchPatch[] = [];
	const blocks = new Map<string, number>();
	const revoked: string[] = [];
	const started: number[] = [];
	const deps: PollDeps = {
		fetch,
		now: () => NOW,
		loadToken: async () =>
			options.token === undefined ? "gho_secret" : options.token,
		markRevoked: async (id) => {
			revoked.push(id);
		},
		blockedUntil: (key) => blocks.get(key),
		block: (key, until) => {
			blocks.set(key, until);
		},
		patchWatch: async (_id, patch) => {
			patches.push(patch);
		},
		startDeploy:
			options.startDeploy ??
			(async (_watch, deployment): Promise<StartOutcome> => {
				started.push(deployment.id);
				return { kind: "started", logUrl: "https://dokploy.example/svc1" };
			}),
		inspectInflight: async () => options.inflight ?? { state: "running" },
		log: () => {},
	};
	return { deps, calls, patches, blocks, revoked, started };
};

beforeEach(() => resetPollState());

describe("new-deployment selection", () => {
	it("keeps ids above lastSeen, oldest first", () => {
		const list = [{ id: 13 }, { id: 11 }, { id: 10 }, { id: 12 }, { id: 4 }];
		expect(selectNewDeployments(list, 10).map((d) => d.id)).toEqual([
			11, 12, 13,
		]);
		expect(selectNewDeployments(list, 13)).toEqual([]);
		expect(maxDeploymentId(list)).toBe(13);
		expect(maxDeploymentId([])).toBe(0);
	});
});

describe("polling a watch", () => {
	it("on 304 does nothing but note the check, and sends the stored ETag", async () => {
		const h = harness([{ status: 304 }]);
		await pollWatch(baseWatch(), h.deps);
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]?.headers["If-None-Match"]).toBe('W/"old"');
		expect(h.started).toEqual([]);
		expect(h.patches).toHaveLength(1);
		expect(h.patches[0]).not.toHaveProperty("etag");
	});

	it("the first poll only baselines: old deployments never run", async () => {
		const h = harness([
			{ json: [dep(8), dep(9)], headers: { etag: 'W/"first"' } },
		]);
		await pollWatch(
			baseWatch({ lastSeenDeploymentId: null, etag: null }),
			h.deps,
		);
		expect(h.started).toEqual([]);
		expect(statuses(h.calls)).toEqual([]);
		expect(h.patches[0]).toMatchObject({
			lastSeenDeploymentId: 9,
			etag: 'W/"first"',
		});
	});

	it("starts the oldest new deployment for this service, posts in_progress, keeps the ETag unsaved", async () => {
		const h = harness([
			{
				json: [dep(13), dep(12), dep(11), dep(10)],
				headers: { etag: 'W/"new"' },
			},
			{ status: 201, json: {} },
		]);
		await pollWatch(baseWatch(), h.deps);
		// One deployment at a time, in id order: 11 now, 12 and 13 after it ends.
		expect(h.started).toEqual([11]);
		const posted = statuses(h.calls);
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({
			url: "11/statuses",
			state: "in_progress",
			log_url: "https://dokploy.example/svc1",
		});
		// The list changed but 12 and 13 are unhandled: a 304 next time would lose them.
		expect(h.patches.some((p) => "etag" in p)).toBe(false);
	});

	it("skips deployments that name another service, silently, and saves the ETag", async () => {
		const h = harness([
			{
				json: [dep(12, "other"), dep(11, "other")],
				headers: { etag: 'W/"n"' },
			},
		]);
		await pollWatch(baseWatch(), h.deps);
		expect(h.started).toEqual([]);
		expect(statuses(h.calls)).toEqual([]);
		expect(
			h.patches.map((p) => p.lastSeenDeploymentId).filter(Boolean),
		).toEqual([11, 12]);
		expect(h.patches.at(-1)).toMatchObject({ etag: 'W/"n"' });
	});

	it("answers an unpinned image for this service with a failure and moves on", async () => {
		const h = harness([
			{
				json: [dep(11, "svc1", "ghcr.io/o/r:latest")],
				headers: { etag: 'W/"n"' },
			},
			{ status: 201, json: {} },
		]);
		await pollWatch(baseWatch(), h.deps);
		expect(h.started).toEqual([]);
		const posted = statuses(h.calls);
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({ url: "11/statuses", state: "failure" });
		expect(posted[0].description).toContain("pinned by digest");
		expect(h.patches.some((p) => p.lastSeenDeploymentId === 11)).toBe(true);
	});

	it("answers a rejected deploy (rule said no) with a failure", async () => {
		const h = harness([{ json: [dep(11)] }, { status: 201, json: {} }], {
			startDeploy: async () => ({
				kind: "rejected",
				reason: "The image repository is not the one this application runs.",
			}),
		});
		await pollWatch(baseWatch(), h.deps);
		expect(statuses(h.calls)[0]).toMatchObject({
			state: "failure",
			url: "11/statuses",
		});
	});

	it("a stale claim (another poll took it) posts nothing and leaves the ETag alone", async () => {
		const h = harness([{ json: [dep(11)] }], {
			startDeploy: async () => ({ kind: "stale" }),
		});
		await pollWatch(baseWatch(), h.deps);
		expect(statuses(h.calls)).toEqual([]);
		expect(h.patches).toEqual([]);
	});

	it("retries a failed start, then answers with a failure after the attempt limit", async () => {
		const startDeploy = vi.fn(async () => {
			throw new Error("queue unavailable");
		});
		for (let attempt = 1; attempt < MAX_START_ATTEMPTS; attempt += 1) {
			const h = harness([{ json: [dep(11)] }], { startDeploy });
			await pollWatch(baseWatch(), h.deps);
			expect(statuses(h.calls)).toEqual([]);
			expect(h.patches.some((p) => p.lastSeenDeploymentId === 11)).toBe(false);
			expect(h.patches.some((p) => p.lastError)).toBe(true);
		}
		const last = harness([{ json: [dep(11)] }, { status: 201, json: {} }], {
			startDeploy,
		});
		await pollWatch(baseWatch(), last.deps);
		expect(statuses(last.calls)[0]).toMatchObject({
			state: "failure",
			url: "11/statuses",
		});
		expect(last.patches.some((p) => p.lastSeenDeploymentId === 11)).toBe(true);
	});

	it("does not poll a disabled watch, or one without a usable token", async () => {
		const off = harness([{ json: [] }]);
		await pollWatch(baseWatch({ enabled: false }), off.deps);
		expect(off.calls).toHaveLength(0);

		const noToken = harness([{ json: [] }], { token: null });
		await pollWatch(baseWatch(), noToken.deps);
		expect(noToken.calls).toHaveLength(0);
		expect(noToken.patches[0]?.lastError).toContain("Connect GitHub again");
	});
});

describe("back-off and errors", () => {
	it("pauses the whole connection on a rate limit and skips ticks until it passes", async () => {
		const h = harness([
			{ status: 429, headers: { "retry-after": "90" } },
			{ status: 304 },
		]);
		await pollWatch(baseWatch(), h.deps);
		expect(h.blocks.get("connection:c1")).toBe(NOW + 90_000);
		expect(h.calls).toHaveLength(1);
		// Another watch on the same connection is not called while paused.
		await pollWatch(baseWatch({ watchId: "w2" }), h.deps);
		expect(h.calls).toHaveLength(1);
	});

	it("marks the connection revoked on 401", async () => {
		const h = harness([{ status: 401 }]);
		await pollWatch(baseWatch(), h.deps);
		expect(h.revoked).toEqual(["c1"]);
	});

	it("records an unknown repository and backs that watch off", async () => {
		const h = harness([{ status: 404 }]);
		await pollWatch(baseWatch(), h.deps);
		expect(h.patches[0]?.lastError).toContain("DevinoSolutions/sendly");
		expect(h.blocks.get("watch:w1")).toBeGreaterThan(NOW);
	});

	it("never throws: a failing step becomes lastError and a back-off", async () => {
		const h = harness([{ json: [dep(11)] }], {});
		h.deps.patchWatch = vi
			.fn()
			.mockRejectedValueOnce(new Error("db down"))
			.mockResolvedValue(undefined);
		h.deps.startDeploy = async () => {
			throw new Error("boom");
		};
		await expect(pollWatch(baseWatch(), h.deps)).resolves.toBeUndefined();
	});
});

describe("reporting the end of a Dokploy deployment", () => {
	const inflightWatch = (ageMs = 1000) =>
		baseWatch({
			inflightDeploymentId: 11,
			inflightStartedAt: new Date(NOW - ageMs),
		});

	it("posts success with the log link when the Dokploy deployment is done, then clears it", async () => {
		const h = harness([{ status: 201, json: {} }], {
			inflight: { state: "done", logUrl: "https://dokploy.example/logs" },
		});
		await pollWatch(inflightWatch(), h.deps);
		expect(statuses(h.calls)[0]).toMatchObject({
			url: "11/statuses",
			state: "success",
			log_url: "https://dokploy.example/logs",
		});
		expect(h.patches[0]).toMatchObject({
			inflightDeploymentId: null,
			inflightStartedAt: null,
		});
		// No list call while reporting.
		expect(h.calls.filter((c) => c.method === "GET")).toEqual([]);
	});

	it("posts failure for an error or a cancel", async () => {
		for (const state of ["error", "cancelled"] as const) {
			const h = harness([{ status: 201, json: {} }], {
				inflight: {
					state,
					logUrl: "https://dokploy.example/logs",
				} as InflightState,
			});
			await pollWatch(inflightWatch(), h.deps);
			expect(statuses(h.calls)[0]).toMatchObject({ state: "failure" });
		}
	});

	it("keeps waiting while the deployment runs, and takes no new deployment meanwhile", async () => {
		const h = harness([{ json: [dep(12)] }], {
			inflight: { state: "running" },
		});
		await pollWatch(inflightWatch(), h.deps);
		expect(h.calls).toHaveLength(0);
		expect(h.patches).toEqual([]);
	});

	it("fails a deployment that never ends after the timeout", async () => {
		const h = harness([{ status: 201, json: {} }], {
			inflight: { state: "running" },
		});
		await pollWatch(inflightWatch(INFLIGHT_TIMEOUT_MS + 1), h.deps);
		expect(statuses(h.calls)[0]).toMatchObject({ state: "failure" });
	});

	it("gives a queued job time to show up, then calls it lost", async () => {
		const early = harness([], { inflight: { state: "missing" } });
		await pollWatch(inflightWatch(1000), early.deps);
		expect(early.calls).toHaveLength(0);

		const late = harness([{ status: 201, json: {} }], {
			inflight: { state: "missing" },
		});
		await pollWatch(inflightWatch(INFLIGHT_ROW_GRACE_MS + 1), late.deps);
		expect(statuses(late.calls)[0]).toMatchObject({ state: "failure" });
	});

	it("keeps the deployment in flight when GitHub could not take the status", async () => {
		const h = harness([{ status: 500, json: {} }], {
			inflight: { state: "done" },
		});
		await pollWatch(inflightWatch(), h.deps);
		expect(h.patches).toEqual([]);
	});

	it("gives up on a deployment GitHub no longer has", async () => {
		const h = harness([{ status: 404, json: {} }], {
			inflight: { state: "done" },
		});
		await pollWatch(inflightWatch(), h.deps);
		expect(h.patches[0]).toMatchObject({ inflightDeploymentId: null });
	});

	it("never puts the token into a status or a log line", async () => {
		const log = vi.fn();
		const h = harness([{ status: 201, json: {} }], {
			inflight: { state: "done" },
		});
		h.deps.log = log;
		await pollWatch(inflightWatch(), h.deps);
		for (const call of h.calls) {
			expect(call.body ?? "").not.toContain("gho_secret");
			expect(call.url).not.toContain("gho_secret");
		}
		expect(JSON.stringify(log.mock.calls)).not.toContain("gho_secret");
	});
});
