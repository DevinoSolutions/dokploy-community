import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The server-side watch for Snapvisor builds that need review: outbound
 * polling (a private panel cannot receive webhooks), one notification per
 * commit of a service, idempotent across restarts, bounded in time and polite
 * to a rate-limiting Snapvisor.
 *
 * The logic runs against an in-memory store (the same contract the database
 * store implements) and a fake Snapvisor, so nothing here touches Postgres or
 * the real API.
 */

vi.mock("@dokploy/server/db", () => ({
	db: {},
	dbUrl: "postgres://mock:mock@localhost:5432/mock",
}));

const {
	runSnapvisorCheckCycle,
	snapvisorErrorDelayMs,
	snapvisorPollDelayMs,
	SNAPVISOR_WATCH_WINDOW_MS,
} = await import("@dokploy/server/services/snapvisor-checks");
const { SnapvisorError } = await import(
	"@dokploy/server/utils/snapvisor/client"
);

import type { SnapvisorBuildCheck } from "@dokploy/server/db/schema";
import type {
	SnapvisorChangesPayload,
	SnapvisorCheckContext,
	SnapvisorCheckDeps,
	SnapvisorCheckStore,
} from "@dokploy/server/services/snapvisor-checks";
import type { SnapvisorBuild } from "@dokploy/server/utils/snapvisor/client";

const SECRET_TOKEN = "sv-pat-0000000000000000beef";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = new Date("2026-10-11T12:00:00Z");
const MIN = 60_000;

const check = (overrides: Partial<SnapvisorBuildCheck> = {}) =>
	({
		checkId: "check-1",
		organizationId: "org-1",
		serviceType: "application",
		serviceId: "app-1",
		deploymentId: "dep-1",
		commitSha: SHA,
		state: "pending",
		attempts: 0,
		errorStreak: 0,
		buildNumber: null,
		buildStatus: null,
		nextCheckAt: T0,
		expiresAt: new Date(T0.getTime() + SNAPVISOR_WATCH_WINDOW_MS),
		notifiedAt: null,
		createdAt: T0,
		...overrides,
	}) as SnapvisorBuildCheck;

const build = (
	status: SnapvisorBuild["status"],
	overrides: Partial<SnapvisorBuild> = {},
): SnapvisorBuild => ({
	id: "build-7",
	number: 7,
	head: { sha: SHA, branch: "feature/login" },
	base: null,
	status,
	stats: {
		added: 1,
		removed: 0,
		unchanged: 10,
		changed: 4,
		ignored: 0,
		failure: 0,
		retryFailure: 0,
		total: 15,
	},
	url: "",
	...overrides,
});

/** The persisted half, in memory. Rows are copied in and out like a database. */
const memoryStore = (initial: SnapvisorBuildCheck[]) => {
	const rows = new Map(initial.map((row) => [row.checkId, { ...row }]));
	const store: SnapvisorCheckStore & {
		rows: typeof rows;
		discovered: SnapvisorBuildCheck[];
	} = {
		rows,
		discovered: [],
		async discover() {
			let added = 0;
			for (const row of store.discovered.splice(0)) {
				const duplicate = [...rows.values()].some(
					(r) => r.serviceId === row.serviceId && r.commitSha === row.commitSha,
				);
				if (!duplicate) {
					rows.set(row.checkId, { ...row });
					added++;
				}
			}
			return added;
		},
		async expireOverdue(now) {
			let expired = 0;
			for (const row of rows.values()) {
				if (row.state === "pending" && row.expiresAt <= now) {
					row.state = "expired";
					expired++;
				}
			}
			return expired;
		},
		async listDue(now, limit) {
			return [...rows.values()]
				.filter(
					(row) =>
						row.state === "pending" &&
						row.nextCheckAt <= now &&
						row.expiresAt > now,
				)
				.sort((a, b) => a.nextCheckAt.getTime() - b.nextCheckAt.getTime())
				.slice(0, limit)
				.map((row) => ({ ...row }));
		},
		async update(checkId, patch) {
			Object.assign(rows.get(checkId) ?? {}, patch);
		},
		async deferOrganization(organizationId, until) {
			for (const row of rows.values()) {
				if (
					row.organizationId === organizationId &&
					row.state === "pending" &&
					row.nextCheckAt < until
				) {
					row.nextCheckAt = until;
				}
			}
		},
		async claimNotification(checkId, now) {
			const row = rows.get(checkId);
			if (!row || row.state !== "pending") return false;
			row.state = "notified";
			row.notifiedAt = now;
			return true;
		},
		async prune() {},
	};
	return store;
};

const integration = {
	snapvisorId: "sv-1",
	organizationId: "org-1",
	name: "Snapvisor",
	accessToken: SECRET_TOKEN,
	accountSlug: "my-team",
	baseUrl: "https://api.snapvisor.io",
	createdAt: new Date(),
};

type Outcome = SnapvisorBuild | null | Error;

/**
 * A fake Snapvisor + clock around a store. `outcome` is what the build lookup
 * returns right now; `calls` records which commits were asked about.
 */
const world = (store: ReturnType<typeof memoryStore>) => {
	const state = {
		now: new Date(T0),
		outcome: null as Outcome,
		byOrganization: {} as Record<string, Outcome>,
		byCommit: {} as Record<string, Outcome>,
		context: (check: SnapvisorBuildCheck): SnapvisorCheckContext | null => ({
			snapvisorProjectName: "web-app",
			serviceName: "web",
			projectName: "Marketing",
			environmentName: "production",
			integration: {
				...integration,
				organizationId: check.organizationId,
			},
		}),
		calls: [] as { organizationId: string; commitSha: string }[],
		notifications: [] as SnapvisorChangesPayload[],
		notifyError: null as Error | null,
	};
	const deps = (): SnapvisorCheckDeps => ({
		...store,
		now: () => new Date(state.now),
		loadContext: async (row) => state.context(row),
		findBuild: async (context, commitSha) => {
			const organizationId = context.integration.organizationId;
			state.calls.push({ organizationId, commitSha });
			const outcome =
				state.byCommit[commitSha] ??
				state.byOrganization[organizationId] ??
				state.outcome;
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
		notify: async (payload) => {
			state.notifications.push(payload);
			if (state.notifyError) throw state.notifyError;
		},
	});
	const advance = (ms: number) => {
		state.now = new Date(state.now.getTime() + ms);
	};
	return { state, deps, advance };
};

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("a build that needs review", () => {
	it("notifies exactly once when a pending build lands in changes-detected", async () => {
		const store = memoryStore([check()]);
		const w = world(store);

		// Not built yet, then still running, then finished with changes.
		w.state.outcome = null;
		await runSnapvisorCheckCycle(w.deps());
		expect(w.state.notifications).toHaveLength(0);

		w.advance(10 * MIN);
		w.state.outcome = build("progress");
		await runSnapvisorCheckCycle(w.deps());
		expect(w.state.notifications).toHaveLength(0);

		w.advance(15 * MIN);
		w.state.outcome = build("changes-detected");
		const summary = await runSnapvisorCheckCycle(w.deps());
		expect(summary.notified).toBe(1);
		expect(w.state.notifications).toHaveLength(1);

		// Later cycles, even with the build still waiting for review.
		for (let i = 0; i < 5; i++) {
			w.advance(20 * MIN);
			await runSnapvisorCheckCycle(w.deps());
		}
		expect(w.state.notifications).toHaveLength(1);
		expect(store.rows.get("check-1")).toMatchObject({
			state: "notified",
			buildStatus: "changes-detected",
			buildNumber: 7,
		});
		expect(store.rows.get("check-1")?.notifiedAt).toBeInstanceOf(Date);
	});

	it("names the service, environment, branch, short commit, snapshot counts and review link", async () => {
		const store = memoryStore([check()]);
		const w = world(store);
		w.state.outcome = build("changes-detected");

		await runSnapvisorCheckCycle(w.deps());

		expect(w.state.notifications).toEqual([
			{
				organizationId: "org-1",
				projectName: "Marketing",
				serviceName: "web",
				serviceType: "application",
				environmentName: "production",
				branch: "feature/login",
				commitSha: SHA,
				snapvisorProjectName: "web-app",
				changedSnapshots: 4,
				addedSnapshots: 1,
				removedSnapshots: 0,
				reviewUrl: "https://app.snapvisor.io/my-team/web-app/builds/7",
			},
		]);
		expect(JSON.stringify(w.state.notifications)).not.toContain(SECRET_TOKEN);
	});

	it("still notifies when Snapvisor sent no snapshot counts", async () => {
		const w = world(memoryStore([check()]));
		w.state.outcome = build("changes-detected", { stats: null });

		await runSnapvisorCheckCycle(w.deps());

		expect(w.state.notifications[0]).toMatchObject({
			changedSnapshots: null,
			addedSnapshots: null,
			removedSnapshots: null,
		});
	});

	it("notifies for a compose service the same way", async () => {
		const w = world(
			memoryStore([check({ serviceType: "compose", serviceId: "compose-1" })]),
		);
		w.state.outcome = build("changes-detected");
		await runSnapvisorCheckCycle(w.deps());
		expect(w.state.notifications).toHaveLength(1);
		expect(w.state.notifications[0]?.serviceType).toBe("compose");
	});
});

describe.each([
	["accepted"],
	["rejected"],
	["no-changes"],
	["error"],
	["aborted"],
	["expired"],
] as const)("a build that is %s", (status) => {
	it("sends no notification and stops watching", async () => {
		const store = memoryStore([check()]);
		const w = world(store);
		w.state.outcome = build(status);

		const summary = await runSnapvisorCheckCycle(w.deps());

		expect(w.state.notifications).toHaveLength(0);
		expect(summary.settled).toBe(1);
		expect(store.rows.get("check-1")?.state).toBe("settled");

		w.advance(30 * MIN);
		await runSnapvisorCheckCycle(w.deps());
		expect(w.state.calls).toHaveLength(1);
	});
});

describe("restarts and overlapping runs", () => {
	it("does not notify again after a restart", async () => {
		const store = memoryStore([check()]);
		const first = world(store);
		first.state.outcome = build("changes-detected");
		await runSnapvisorCheckCycle(first.deps());
		expect(first.state.notifications).toHaveLength(1);

		// A new process: fresh deps over the same persisted rows.
		const second = world(store);
		second.state.now = new Date(T0.getTime() + 30 * MIN);
		second.state.outcome = build("changes-detected");
		await runSnapvisorCheckCycle(second.deps());
		await runSnapvisorCheckCycle(second.deps());

		expect(second.state.notifications).toHaveLength(0);
		expect(second.state.calls).toHaveLength(0);
	});

	it("does not notify again when a redeploy of the same commit is discovered", async () => {
		const store = memoryStore([check()]);
		const w = world(store);
		w.state.outcome = build("changes-detected");
		await runSnapvisorCheckCycle(w.deps());

		store.discovered.push(check({ checkId: "check-2", deploymentId: "dep-2" }));
		w.advance(5 * MIN);
		const summary = await runSnapvisorCheckCycle(w.deps());

		expect(summary.discovered).toBe(0);
		expect(w.state.notifications).toHaveLength(1);
	});

	it("sends one notification when two runs race for the same check", async () => {
		const store = memoryStore([check()]);
		const w = world(store);
		w.state.outcome = build("changes-detected");

		await Promise.all([
			runSnapvisorCheckCycle(w.deps()),
			runSnapvisorCheckCycle(w.deps()),
		]);

		expect(w.state.notifications).toHaveLength(1);
	});

	it("does not retry a notification whose channels failed", async () => {
		const store = memoryStore([check()]);
		const w = world(store);
		w.state.outcome = build("changes-detected");
		w.state.notifyError = new Error("channel down");

		await expect(runSnapvisorCheckCycle(w.deps())).resolves.toMatchObject({
			notified: 1,
		});
		w.advance(10 * MIN);
		await runSnapvisorCheckCycle(w.deps());

		expect(w.state.notifications).toHaveLength(1);
	});
});

describe("the watch window", () => {
	it("gives up after the window without ever finding a build", async () => {
		const store = memoryStore([check()]);
		const w = world(store);
		w.state.outcome = null;

		// A cycle every 3 minutes for just over the 6 hour window.
		let last = { expired: 0 };
		for (let at = 0; at <= SNAPVISOR_WATCH_WINDOW_MS + 6 * MIN; at += 3 * MIN) {
			w.state.now = new Date(T0.getTime() + at);
			last = await runSnapvisorCheckCycle(w.deps());
			if (store.rows.get("check-1")?.state === "expired") break;
		}

		expect(store.rows.get("check-1")?.state).toBe("expired");
		expect(w.state.notifications).toHaveLength(0);
		expect(last.expired).toBe(1);

		const callsAtExpiry = w.state.calls.length;
		w.advance(60 * MIN);
		w.state.outcome = build("changes-detected");
		await runSnapvisorCheckCycle(w.deps());
		expect(w.state.calls).toHaveLength(callsAtExpiry);
		expect(w.state.notifications).toHaveLength(0);
	});

	it("does not ask Snapvisor about a check whose window has already closed", async () => {
		const store = memoryStore([
			check({ expiresAt: new Date(T0.getTime() - MIN) }),
		]);
		const w = world(store);
		w.state.outcome = build("changes-detected");

		await runSnapvisorCheckCycle(w.deps());

		expect(w.state.calls).toHaveLength(0);
		expect(w.state.notifications).toHaveLength(0);
		expect(store.rows.get("check-1")?.state).toBe("expired");
	});

	it("polls a missing build with growing, capped gaps", async () => {
		const store = memoryStore([check()]);
		const w = world(store);
		w.state.outcome = null;

		const gaps: number[] = [];
		for (let i = 0; i < 8; i++) {
			await runSnapvisorCheckCycle(w.deps());
			const next = store.rows.get("check-1")?.nextCheckAt as Date;
			gaps.push(next.getTime() - w.state.now.getTime());
			w.state.now = next;
		}

		expect(gaps[0]).toBe(snapvisorPollDelayMs(1));
		for (let i = 1; i < gaps.length; i++) {
			expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1] as number);
		}
		expect(Math.max(...gaps)).toBeLessThanOrEqual(15 * MIN);
		expect(store.rows.get("check-1")?.attempts).toBe(8);
	});

	it("leaves a check alone until it is due", async () => {
		const store = memoryStore([check()]);
		const w = world(store);
		w.state.outcome = null;
		await runSnapvisorCheckCycle(w.deps());
		expect(w.state.calls).toHaveLength(1);

		w.advance(1 * MIN);
		await runSnapvisorCheckCycle(w.deps());
		expect(w.state.calls).toHaveLength(1);
	});
});

describe("rate limiting and outages", () => {
	it("backs off for at least Retry-After on a 429", async () => {
		const store = memoryStore([check()]);
		const w = world(store);
		w.state.outcome = new SnapvisorError("slow down", {
			status: 429,
			retryAfterSeconds: 20 * 60,
		});

		const summary = await runSnapvisorCheckCycle(w.deps());

		expect(summary.failed).toBe(1);
		const row = store.rows.get("check-1");
		expect(row?.errorStreak).toBe(1);
		expect((row?.nextCheckAt as Date).getTime()).toBe(T0.getTime() + 20 * MIN);

		// Nothing happens until then, however often the job ticks.
		for (let at = 3; at < 20; at += 3) {
			w.state.now = new Date(T0.getTime() + at * MIN);
			await runSnapvisorCheckCycle(w.deps());
		}
		expect(w.state.calls).toHaveLength(1);

		w.state.now = new Date(T0.getTime() + 21 * MIN);
		w.state.outcome = build("changes-detected");
		await runSnapvisorCheckCycle(w.deps());
		expect(w.state.calls).toHaveLength(2);
		expect(w.state.notifications).toHaveLength(1);
		expect(store.rows.get("check-1")?.errorStreak).toBe(0);
	});

	it("backs off exponentially without a Retry-After, up to an hour", async () => {
		const store = memoryStore([check()]);
		const w = world(store);
		w.state.outcome = new SnapvisorError("slow down", { status: 429 });

		const gaps: number[] = [];
		for (let i = 0; i < 6; i++) {
			await runSnapvisorCheckCycle(w.deps());
			const next = store.rows.get("check-1")?.nextCheckAt as Date;
			gaps.push(next.getTime() - w.state.now.getTime());
			w.state.now = next;
		}

		expect(gaps).toEqual([5, 10, 20, 40, 60, 60].map((m) => m * MIN));
		expect(gaps[0]).toBe(snapvisorErrorDelayMs(1));
	});

	it("stops asking an organization after its first failure in a cycle and defers the rest", async () => {
		const store = memoryStore([
			check({ checkId: "a", serviceId: "app-a", commitSha: "a".repeat(40) }),
			check({
				checkId: "b",
				serviceId: "app-b",
				commitSha: "b".repeat(40),
				nextCheckAt: new Date(T0.getTime() + 1_000),
			}),
			check({
				checkId: "c",
				serviceId: "app-c",
				commitSha: "c".repeat(40),
				nextCheckAt: new Date(T0.getTime() + 2_000),
			}),
		]);
		const w = world(store);
		w.state.now = new Date(T0.getTime() + 5_000);
		w.state.outcome = new SnapvisorError("slow down", {
			status: 429,
			retryAfterSeconds: 600,
		});

		await runSnapvisorCheckCycle(w.deps());

		expect(w.state.calls).toHaveLength(1);
		const until = w.state.now.getTime() + 10 * MIN;
		for (const id of ["a", "b", "c"]) {
			expect((store.rows.get(id)?.nextCheckAt as Date).getTime()).toBe(until);
		}
	});

	it("keeps checking other organizations when one is rate limited", async () => {
		const store = memoryStore([
			check({ checkId: "a", organizationId: "org-1", serviceId: "app-a" }),
			check({
				checkId: "b",
				organizationId: "org-2",
				serviceId: "app-b",
				commitSha: "b".repeat(40),
			}),
		]);
		const w = world(store);
		w.state.byOrganization = {
			"org-1": new SnapvisorError("slow down", { status: 429 }),
			"org-2": build("changes-detected"),
		};

		const summary = await runSnapvisorCheckCycle(w.deps());

		expect(summary).toMatchObject({ failed: 1, notified: 1 });
		expect(w.state.notifications.map((n) => n.organizationId)).toEqual([
			"org-2",
		]);
	});

	describe("a failure that is only about one project", () => {
		const A = "a".repeat(40);
		const B = "b".repeat(40);
		const twoServicesOfOneOrganization = () =>
			memoryStore([
				check({ checkId: "a", serviceId: "app-a", commitSha: A }),
				check({
					checkId: "b",
					serviceId: "app-b",
					commitSha: B,
					nextCheckAt: new Date(T0.getTime() + 1_000),
				}),
			]);

		it("defers only that check when its project no longer exists, and still checks and notifies the healthy one", async () => {
			const store = twoServicesOfOneOrganization();
			const deferOrganization = vi.spyOn(store, "deferOrganization");
			const w = world(store);
			w.state.now = new Date(T0.getTime() + 5_000);
			w.state.byCommit = {
				[A]: new SnapvisorError("project not found", { status: 404 }),
				[B]: build("changes-detected"),
			};

			const summary = await runSnapvisorCheckCycle(w.deps());

			expect(summary).toMatchObject({ checked: 2, failed: 1, notified: 1 });
			expect(w.state.calls.map((c) => c.commitSha)).toEqual([A, B]);
			expect(w.state.notifications.map((n) => n.commitSha)).toEqual([B]);
			expect(deferOrganization).not.toHaveBeenCalled();
			expect(store.rows.get("b")?.state).toBe("notified");
			expect(store.rows.get("a")).toMatchObject({
				state: "pending",
				errorStreak: 1,
			});
			expect((store.rows.get("a")?.nextCheckAt as Date).getTime()).toBe(
				w.state.now.getTime() + 5 * MIN,
			);
		});

		it("keeps asking about the healthy check on later cycles while the broken one backs off on its own streak", async () => {
			const store = memoryStore([
				check({ checkId: "a", serviceId: "app-a", commitSha: A }),
				check({ checkId: "b", serviceId: "app-b", commitSha: B }),
			]);
			const w = world(store);
			w.state.byCommit = {
				[A]: new SnapvisorError("project not found", { status: 404 }),
				[B]: null,
			};

			const gaps: number[] = [];
			for (let i = 0; i < 4; i++) {
				const before = w.state.now.getTime();
				await runSnapvisorCheckCycle(w.deps());
				gaps.push(
					(store.rows.get("a")?.nextCheckAt as Date).getTime() - before,
				);
				// Jump to when the broken check is due again.
				w.advance(gaps[i] as number);
			}

			expect(gaps).toEqual([5, 10, 20, 40].map((m) => m * MIN));
			// The healthy check was asked on every cycle it was due, never held
			// back by the broken neighbour.
			expect(
				w.state.calls.filter((c) => c.commitSha === B).length,
			).toBeGreaterThanOrEqual(4);
			expect(store.rows.get("a")?.errorStreak).toBe(4);
			expect(store.rows.get("b")?.errorStreak).toBe(0);
		});

		it.each([400, 404, 422])(
			"treats HTTP %i as belonging to the check alone",
			async (status) => {
				const store = twoServicesOfOneOrganization();
				const w = world(store);
				w.state.now = new Date(T0.getTime() + 5_000);
				w.state.byCommit = {
					[A]: new SnapvisorError("nope", { status }),
					[B]: build("changes-detected"),
				};

				await runSnapvisorCheckCycle(w.deps());

				expect(w.state.notifications).toHaveLength(1);
				expect(store.rows.get("b")?.state).toBe("notified");
			},
		);

		it.each([
			["401", new SnapvisorError("x", { status: 401 })],
			["403", new SnapvisorError("x", { status: 403 })],
			["429", new SnapvisorError("x", { status: 429 })],
			["500", new SnapvisorError("x", { status: 500 })],
			["502", new SnapvisorError("x", { status: 502 })],
			["a network error", new TypeError("fetch failed")],
		])(
			"still holds the whole organization back for %s",
			async (_name, error) => {
				const store = twoServicesOfOneOrganization();
				const w = world(store);
				w.state.now = new Date(T0.getTime() + 5_000);
				w.state.byCommit = {
					[A]: error,
					[B]: build("changes-detected"),
				};

				await runSnapvisorCheckCycle(w.deps());

				expect(w.state.calls).toHaveLength(1);
				expect(w.state.notifications).toHaveLength(0);
				expect((store.rows.get("b")?.nextCheckAt as Date).getTime()).toBe(
					w.state.now.getTime() + 5 * MIN,
				);
			},
		);
	});

	it.each([
		["a rejected token", new SnapvisorError("rejected", { status: 401 })],
		["Snapvisor being unreachable", new SnapvisorError("down")],
		["a non-Snapvisor error", new TypeError("fetch failed")],
	])(
		"treats %s as a deferral, not a failure of the watch",
		async (_n, error) => {
			const store = memoryStore([check()]);
			const w = world(store);
			w.state.outcome = error;

			await expect(runSnapvisorCheckCycle(w.deps())).resolves.toMatchObject({
				failed: 1,
				notified: 0,
			});

			const row = store.rows.get("check-1");
			expect(row?.state).toBe("pending");
			expect(row?.errorStreak).toBe(1);
			expect((row?.nextCheckAt as Date).getTime()).toBe(T0.getTime() + 5 * MIN);
		},
	);

	it("never logs the token, the message or the URL of a failure", async () => {
		const w = world(memoryStore([check()]));
		w.state.outcome = new SnapvisorError(
			`Could not reach Snapvisor at https://api.snapvisor.io/v2: ${SECRET_TOKEN}`,
			{ status: 500 },
		);

		await runSnapvisorCheckCycle(w.deps());

		const logged = JSON.stringify(errorLog.mock.calls);
		expect(logged).toContain("HTTP 500");
		expect(logged).not.toContain(SECRET_TOKEN);
		expect(logged).not.toContain("snapvisor.io");
	});
});

describe("links that went away", () => {
	it("settles a check whose service, link or integration is gone", async () => {
		const store = memoryStore([check()]);
		const w = world(store);
		w.state.context = () => null;
		w.state.outcome = build("changes-detected");

		await runSnapvisorCheckCycle(w.deps());

		expect(w.state.calls).toHaveLength(0);
		expect(w.state.notifications).toHaveLength(0);
		expect(store.rows.get("check-1")?.state).toBe("settled");
	});
});

describe("discovery", () => {
	it("starts watching newly discovered deployments in the same cycle", async () => {
		const store = memoryStore([]);
		store.discovered.push(check());
		const w = world(store);
		w.state.outcome = build("changes-detected");

		const summary = await runSnapvisorCheckCycle(w.deps());

		expect(summary.discovered).toBe(1);
		expect(w.state.notifications).toHaveLength(1);
	});
});

describe("delays", () => {
	it("polls every 3 minutes at first and never slower than every 15", () => {
		expect(snapvisorPollDelayMs(0)).toBe(3 * MIN);
		expect(snapvisorPollDelayMs(100)).toBe(15 * MIN);
	});

	it("never waits less than the Retry-After it was given, capped at an hour", () => {
		expect(snapvisorErrorDelayMs(1, 30 * 60)).toBe(30 * MIN);
		expect(snapvisorErrorDelayMs(1, 24 * 60 * 60)).toBe(60 * MIN);
		expect(snapvisorErrorDelayMs(1, 10)).toBe(5 * MIN);
	});
});
