import {
	describeError,
	INFLIGHT_ROW_GRACE_MS,
	INFLIGHT_TIMEOUT_MS,
	type InflightState,
	MAX_START_ATTEMPTS,
	MAX_STATUS_ATTEMPTS,
	maxDeploymentId,
	type PollDeps,
	pollWatch,
	reportServiceGone,
	resetPollState,
	STATUS_TEXT,
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
	postLogUrl: false,
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
		/** The cursor was reset elsewhere: every compare-and-set patch is refused. */
		cursorMoved?: boolean;
	} = {},
) => {
	const { fetch, calls } = scriptedFetch(fetchReplies);
	const patches: WatchPatch[] = [];
	const patchOptions: Array<{ ifCursor?: number | null } | undefined> = [];
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
		patchWatch: async (_id, patch, patchOption) => {
			patches.push(patch);
			patchOptions.push(patchOption);
			if (options.cursorMoved && patchOption?.ifCursor !== undefined) {
				patches.pop();
				return false;
			}
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
	return { deps, calls, patches, patchOptions, blocks, revoked, started };
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

	it("deploys only the NEWEST new deployment for this service and answers the older ones as inactive", async () => {
		const h = harness([
			{
				json: [dep(13), dep(12), dep(11), dep(10)],
				headers: { etag: 'W/"new"' },
			},
			{ status: 201, json: {} },
		]);
		await pollWatch(baseWatch(), h.deps);
		// Only 13 runs; 11 and 12 are superseded and answered, oldest first, so
		// no workflow waits on them.
		expect(h.started).toEqual([13]);
		const posted = statuses(h.calls);
		expect(posted.map((p) => [p.url, p.state])).toEqual([
			["11/statuses", "inactive"],
			["12/statuses", "inactive"],
			["13/statuses", "in_progress"],
		]);
		expect(posted[0]?.description).toBe(STATUS_TEXT.superseded);
		// The dashboard link is opt-in per watch: not sent by default.
		expect(posted.some((p) => "log_url" in p)).toBe(false);
		expect(
			h.patches.map((p) => p.lastSeenDeploymentId).filter(Boolean),
		).toEqual([11, 12]);
		// The deployment is in flight: a 304 next time must not hide anything.
		expect(h.patches.some((p) => "etag" in p)).toBe(false);
	});

	it("sends the Dokploy link as log_url only when the watch opted in", async () => {
		const h = harness([{ json: [dep(11)] }, { status: 201, json: {} }]);
		await pollWatch(baseWatch({ postLogUrl: true }), h.deps);
		expect(statuses(h.calls)[0]).toMatchObject({
			state: "in_progress",
			log_url: "https://dokploy.example/svc1",
		});
	});

	it("passes startDeploy a watch whose cursor already includes the superseded ones", async () => {
		const seen: Array<number | null> = [];
		const h = harness(
			[{ json: [dep(12), dep(11)] }, { status: 201, json: {} }],
			{
				startDeploy: async (watch) => {
					seen.push(watch.lastSeenDeploymentId);
					return { kind: "started" };
				},
			},
		);
		await pollWatch(baseWatch(), h.deps);
		expect(seen).toEqual([11]);
	});

	it("answers an older invalid deployment with a failure and still deploys the newest valid one", async () => {
		const h = harness([
			{ json: [dep(12), dep(11, "svc1", "ghcr.io/o/r:latest")] },
			{ status: 201, json: {} },
		]);
		await pollWatch(baseWatch(), h.deps);
		expect(h.started).toEqual([12]);
		expect(
			statuses(h.calls).map((p) => [p.url, p.state, p.description]),
		).toEqual([
			["11/statuses", "failure", STATUS_TEXT.unreadable],
			["12/statuses", "in_progress", STATUS_TEXT.accepted],
		]);
	});

	it("does not answer a superseded deployment of another service", async () => {
		const h = harness([
			{ json: [dep(13), dep(12, "other"), dep(11)] },
			{ status: 201, json: {} },
		]);
		await pollWatch(baseWatch(), h.deps);
		expect(statuses(h.calls).map((p) => p.url)).toEqual([
			"11/statuses",
			"13/statuses",
		]);
	});

	it("stops where it is when GitHub does not take a superseded answer yet", async () => {
		const h = harness([{ json: [dep(12), dep(11)] }, { status: 500 }]);
		await pollWatch(baseWatch(), h.deps);
		expect(h.started).toEqual([]);
		expect(h.patches.some((p) => p.lastSeenDeploymentId)).toBe(false);
		expect(h.blocks.get("watch:w1")).toBeGreaterThan(NOW);
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
		// GitHub gets fixed text; the reason stays on the dashboard.
		expect(posted[0].description).toBe(STATUS_TEXT.unreadable);
		expect(h.patches.at(-1)?.lastError).toContain("pinned by digest");
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
			description: STATUS_TEXT.rejected,
		});
		// The rule's reason (it names the image the service runs) stays inside Dokploy.
		expect(JSON.stringify(h.calls.map((c) => c.body))).not.toContain(
			"this application runs",
		);
		expect(h.patches.at(-1)?.lastError).toContain("this application runs");
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
			description: STATUS_TEXT.notQueued,
		});
		expect(last.patches.some((p) => p.lastSeenDeploymentId === 11)).toBe(true);
	});

	it("never sends the text of a start error to GitHub, and keeps database parameters out of lastError", async () => {
		const secret = "postgres-param-gho_abc123";
		const startDeploy = vi.fn(async () => {
			throw new Error(
				`Failed query: update "application" set "dockerImage" = $1 params: ${secret}`,
			);
		});
		for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
			const h = harness([{ json: [dep(11)] }, { status: 201, json: {} }], {
				startDeploy,
			});
			await pollWatch(baseWatch(), h.deps);
			expect(JSON.stringify(h.patches)).not.toContain(secret);
			expect(JSON.stringify(h.calls.map((c) => c.body))).not.toContain(secret);
			expect(JSON.stringify(h.patches)).not.toContain("Failed query");
		}
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

describe("writes are conditional on the cursor the poll started from", () => {
	it("a 304 and the baseline are compare-and-set on the cursor they read", async () => {
		const notModified = harness([{ status: 304 }]);
		await pollWatch(baseWatch({ lastSeenDeploymentId: 10 }), notModified.deps);
		expect(notModified.patchOptions).toEqual([{ ifCursor: 10 }]);

		const baseline = harness([{ json: [dep(8), dep(9)] }]);
		await pollWatch(
			baseWatch({ lastSeenDeploymentId: null, etag: null }),
			baseline.deps,
		);
		expect(baseline.patchOptions).toEqual([{ ifCursor: null }]);
	});

	it("each advance names the cursor the previous one left, and so does the final patch", async () => {
		const h = harness([{ json: [dep(12, "other"), dep(11, "other")] }]);
		await pollWatch(baseWatch({ lastSeenDeploymentId: 10 }), h.deps);
		expect(h.patchOptions).toEqual([
			{ ifCursor: 10 },
			{ ifCursor: 11 },
			{ ifCursor: 12 },
		]);
	});

	it("stops writing, deploying and answering once the cursor was reset under it", async () => {
		// A tick read the watch, then the watch was disabled and enabled again
		// (cursor reset to null): nothing it still holds may land.
		const h = harness(
			[{ json: [dep(12), dep(11)] }, { status: 201, json: {} }],
			{
				cursorMoved: true,
			},
		);
		await pollWatch(baseWatch({ lastSeenDeploymentId: 10 }), h.deps);
		expect(h.patches).toEqual([]);
		expect(h.started).toEqual([]);
		// 11 was superseded and answered before its advance was refused; nothing after.
		expect(statuses(h.calls).map((p) => p.url)).toEqual(["11/statuses"]);
	});
});

describe("describeError", () => {
	it("keeps one short line and never a database statement or parameters", () => {
		expect(describeError(new Error("line one\nline two"))).toBe("line one");
		expect(
			describeError(
				new Error('Failed query: insert into "x" values ($1) params: gho_zzz'),
			),
		).toBe("A database error occurred");
		expect(
			describeError(new Error("x".repeat(500))).length,
		).toBeLessThanOrEqual(160);
		expect(describeError(undefined)).toBe("An unexpected error occurred");
	});
});

describe("a service deleted while a deployment is in flight", () => {
	it("posts one final failure before the watch is dropped", async () => {
		const h = harness([{ status: 201, json: {} }]);
		await reportServiceGone(
			baseWatch({ inflightDeploymentId: 11, inflightStartedAt: new Date(NOW) }),
			h.deps,
		);
		expect(statuses(h.calls)).toEqual([
			{
				url: "11/statuses",
				state: "failure",
				description: STATUS_TEXT.serviceGone,
			},
		]);
	});

	it("posts nothing when nothing was in flight, or when there is no token", async () => {
		const idle = harness([{ status: 201, json: {} }]);
		await reportServiceGone(baseWatch(), idle.deps);
		expect(idle.calls).toHaveLength(0);

		const noToken = harness([{ status: 201, json: {} }], { token: null });
		await reportServiceGone(
			baseWatch({ inflightDeploymentId: 11, inflightStartedAt: new Date(NOW) }),
			noToken.deps,
		);
		expect(noToken.calls).toHaveLength(0);
	});

	it("is best effort: a GitHub failure does not throw", async () => {
		const h = harness([new Error("socket")]);
		await expect(
			reportServiceGone(
				baseWatch({
					inflightDeploymentId: 11,
					inflightStartedAt: new Date(NOW),
				}),
				h.deps,
			),
		).resolves.toBeUndefined();
	});
});

describe("reporting the end of a Dokploy deployment", () => {
	const inflightWatch = (ageMs = 1000) =>
		baseWatch({
			inflightDeploymentId: 11,
			inflightStartedAt: new Date(NOW - ageMs),
		});

	it("posts success without a link by default, with the log link when the watch opted in, then clears it", async () => {
		const plain = harness([{ status: 201, json: {} }], {
			inflight: { state: "done", logUrl: "https://dokploy.example/logs" },
		});
		await pollWatch(inflightWatch(), plain.deps);
		expect(statuses(plain.calls)[0]).toMatchObject({
			url: "11/statuses",
			state: "success",
			description: STATUS_TEXT.done,
		});
		expect(statuses(plain.calls)[0]).not.toHaveProperty("log_url");

		const h = harness([{ status: 201, json: {} }], {
			inflight: { state: "done", logUrl: "https://dokploy.example/logs" },
		});
		await pollWatch(
			{ ...inflightWatch(), postLogUrl: true } as WatchRow,
			h.deps,
		);
		expect(statuses(h.calls)[0]).toMatchObject({
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

	it("keeps the deployment in flight and backs off when GitHub could not take the status", async () => {
		const h = harness([{ status: 500, json: {} }], {
			inflight: { state: "done" },
		});
		await pollWatch(inflightWatch(), h.deps);
		expect(h.patches).toEqual([]);
		expect(h.blocks.get("watch:w1")).toBe(NOW + 30_000);
	});

	it.each([403, 500, 502])(
		"gives up on a status GitHub keeps refusing (%i) after the attempt limit, clearing the deployment and recording why",
		async (status) => {
			const h = harness([{ status, json: {} }], {
				inflight: { state: "error" },
			});
			const delays: number[] = [];
			for (let attempt = 1; attempt <= MAX_STATUS_ATTEMPTS; attempt += 1) {
				h.blocks.clear();
				await pollWatch(inflightWatch(), h.deps);
				const until = h.blocks.get("watch:w1");
				if (until) delays.push(until - NOW);
			}
			expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(
				MAX_STATUS_ATTEMPTS,
			);
			// Exponential back-off until the last attempt, which settles.
			expect(delays).toEqual([30_000, 60_000, 120_000, 240_000]);
			expect(h.patches).toHaveLength(1);
			expect(h.patches[0]).toMatchObject({
				inflightDeploymentId: null,
				inflightStartedAt: null,
			});
			expect(h.patches[0]?.lastError).toContain(`HTTP ${status}`);
		},
	);

	it("a refused status that later succeeds resets the count", async () => {
		const h = harness(
			[{ status: 500 }, { status: 500 }, { status: 201, json: {} }],
			{ inflight: { state: "done" } },
		);
		for (let i = 0; i < 3; i += 1) {
			h.blocks.clear();
			await pollWatch(inflightWatch(), h.deps);
		}
		expect(h.patches).toHaveLength(1);
		expect(h.patches[0]).toMatchObject({
			inflightDeploymentId: null,
			lastError: null,
		});
	});

	it("on 401 marks the connection revoked and keeps the deployment to report after reconnecting", async () => {
		const h = harness([{ status: 401, json: {} }], {
			inflight: { state: "done" },
		});
		await pollWatch(inflightWatch(), h.deps);
		expect(h.revoked).toEqual(["c1"]);
		expect(h.patches).toEqual([]);
	});

	it("a rate limited status pauses the connection and is not counted as a failed attempt", async () => {
		const h = harness([{ status: 429, headers: { "retry-after": "30" } }], {
			inflight: { state: "done" },
		});
		await pollWatch(inflightWatch(), h.deps);
		expect(h.blocks.get("connection:c1")).toBe(NOW + 30_000);
		expect(h.patches).toEqual([]);
	});

	it("posts the same fixed text whatever the Dokploy error was", async () => {
		const h = harness([{ status: 201, json: {} }], {
			// A stray detail from an old caller must not be forwarded.
			inflight: {
				state: "error",
				detail: "ECONNREFUSED 10.0.0.7:5432 password=hunter2",
			} as unknown as InflightState,
		});
		await pollWatch(inflightWatch(), h.deps);
		const body = h.calls.find((c) => c.method === "POST")?.body ?? "";
		expect(body).not.toContain("hunter2");
		expect(body).not.toContain("10.0.0.7");
		expect(JSON.parse(body)).toEqual({
			state: "failure",
			description: STATUS_TEXT.failed,
		});
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
