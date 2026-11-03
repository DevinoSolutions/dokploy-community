import type {
	GateCheck,
	GateWorkflowRun,
} from "@dokploy/server/services/gha-connect/deploy-gate";
import type {
	GateGithub,
	GateRead,
} from "@dokploy/server/services/gha-connect/deploy-gate-github";
import {
	type DeployGateStore,
	type GateConnection,
	type GateOutcome,
	type GateRelease,
	runDeployGate,
} from "@dokploy/server/services/gha-connect/deploy-gate-step";
import { describe, expect, it, vi } from "vitest";

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-03T12:00:00Z");
const WORKFLOW = ".github/workflows/dokploy.yml";

const connection = (
	overrides: Partial<GateConnection> = {},
): GateConnection => ({
	ghaConnectionId: "gc-1",
	state: "waiting",
	trackedBranch: "main",
	workflowPath: WORKFLOW,
	gateMode: "checks",
	gateWorkflows: [],
	gateTimeoutMinutes: 60,
	gateStartedAt: null,
	deployedSha: null,
	...overrides,
});

const release = (overrides: Partial<GateRelease> = {}): GateRelease => ({
	releaseId: "rel-1",
	sha: "a".repeat(40),
	runId: 777,
	createdAt: new Date(NOW - 10 * MINUTE),
	gateState: null,
	gateExpected: null,
	...overrides,
});

let nextId = 1;
const check = (
	name: string,
	status: string,
	conclusion: string | null,
	extra: Partial<GateCheck> = {},
): GateCheck => ({
	name,
	kind: "check-run",
	status,
	conclusion,
	id: nextId++,
	startedAt: null,
	appSlug: "github-actions",
	runId: null,
	...extra,
});

const ok = <T>(value: T): GateRead<T> => ({ kind: "ok", value });
const releaseRun: GateWorkflowRun = {
	id: 777,
	name: "Dokploy",
	path: WORKFLOW,
	runAttempt: 1,
	status: "in_progress",
	conclusion: null,
	startedAt: null,
};

const fakeGithub = (parts: Partial<GateGithub> = {}) => {
	const github = {
		loadExpectedCheckSet: vi.fn(async () =>
			ok({ source: "required" as const, names: ["build", "test"] }),
		),
		loadCommitChecks: vi.fn(async () => ok<GateCheck[]>([])),
		loadWorkflowRuns: vi.fn(async () => ok<GateWorkflowRun[]>([releaseRun])),
		...parts,
	};
	return github as typeof github & GateGithub;
};

const fakeStore = () => {
	const store = {
		markGateStarted: vi.fn(async () => {}),
		clearGateStart: vi.fn(async () => {}),
		recordGateOutcome: vi.fn(
			async (_releaseId: string, _outcome: GateOutcome) => {},
		),
		blockConnection: vi.fn(async () => {}),
		unblockConnection: vi.fn(async () => {}),
	};
	return store satisfies DeployGateStore;
};

const run = (
	parts: {
		connection?: Partial<GateConnection>;
		release?: Partial<GateRelease>;
		github?: GateGithub;
		store?: DeployGateStore;
		appSlug?: string | null;
	} = {},
) =>
	runDeployGate({
		connection: connection(parts.connection),
		release: release(parts.release),
		github: parts.github ?? fakeGithub(),
		store: parts.store ?? fakeStore(),
		now: () => NOW,
		appSlug: parts.appSlug,
	});

describe("runDeployGate", () => {
	it("image mode deploys without reading GitHub or writing anything", async () => {
		const github = fakeGithub();
		const store = fakeStore();
		const decision = await run({
			connection: { gateMode: "image" },
			github,
			store,
		});
		expect(decision).toEqual({ state: "deploy" });
		expect(github.loadWorkflowRuns).not.toHaveBeenCalled();
		expect(github.loadCommitChecks).not.toHaveBeenCalled();
		for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
	});

	it("an overridden release deploys at once, without reading GitHub", async () => {
		const github = fakeGithub();
		const decision = await run({
			release: { gateState: "overridden" },
			github,
		});
		expect(decision).toEqual({ state: "deploy", overridden: true });
		expect(github.loadCommitChecks).not.toHaveBeenCalled();
	});

	it("the first waiting evaluation sets gateStartedAt and records the waiting state", async () => {
		const github = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([
					check("build", "completed", "success"),
					check("test", "in_progress", null),
				]),
			),
		});
		const store = fakeStore();
		const decision = await run({ github, store });
		expect(decision).toMatchObject({
			state: "waiting",
			pendingNames: ["test"],
		});
		expect(store.markGateStarted).toHaveBeenCalledWith("gc-1", new Date(NOW));
		expect(store.recordGateOutcome).toHaveBeenCalledWith("rel-1", {
			gateState: "waiting",
			gateReason: "Waiting for test",
			checkedAt: new Date(NOW),
			gateExpected: { source: "required", names: ["build", "test"] },
		});
		expect(store.clearGateStart).not.toHaveBeenCalled();
	});

	it("a later evaluation keeps the start it has", async () => {
		const github = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([check("build", "completed", "success")]),
			),
		});
		const store = fakeStore();
		await run({
			connection: { gateStartedAt: new Date(NOW - 5 * MINUTE) },
			github,
			store,
		});
		expect(store.markGateStarted).not.toHaveBeenCalled();
	});

	it("a start from before this release belongs to an older release: it starts over", async () => {
		const github = fakeGithub();
		const store = fakeStore();
		// Started 3 hours ago for an older release; this release is 10 minutes old.
		const decision = await run({
			connection: { gateStartedAt: new Date(NOW - 180 * MINUTE) },
			github,
			store,
		});
		expect(decision.state).toBe("waiting");
		expect(store.markGateStarted).toHaveBeenCalledWith("gc-1", new Date(NOW));
	});

	it("a name that never reports blocks after the timeout and blocks the connection", async () => {
		const github = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([check("build", "completed", "success")]),
			),
		});
		const store = fakeStore();
		const decision = await run({
			connection: {
				gateStartedAt: new Date(NOW - 5 * MINUTE),
				gateTimeoutMinutes: 5,
			},
			release: { createdAt: new Date(NOW - 10 * MINUTE) },
			github,
			store,
		});
		expect(decision).toMatchObject({
			state: "blocked",
			reason: "Check test never reported",
		});
		expect(store.blockConnection).toHaveBeenCalledWith(
			"gc-1",
			"Check test never reported",
		);
		expect(store.recordGateOutcome).toHaveBeenCalledWith(
			"rel-1",
			expect.objectContaining({
				gateState: "blocked",
				gateReason: "Check test never reported",
			}),
		);
		expect(store.clearGateStart).not.toHaveBeenCalled();
	});

	it("a block is not written again to a connection that is already blocked", async () => {
		const github = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([check("build", "completed", "failure")]),
			),
		});
		const store = fakeStore();
		await run({
			connection: { state: "blocked" },
			release: { gateState: "blocked" },
			github,
			store,
		});
		expect(store.blockConnection).not.toHaveBeenCalled();
	});

	it("a passing re-run deploys, clears the start and lifts the block", async () => {
		const github = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([
					check("build", "completed", "failure", { id: 1 }),
					check("build", "completed", "success", { id: 9 }),
					check("test", "completed", "success"),
				]),
			),
		});
		const store = fakeStore();
		const decision = await run({
			connection: {
				state: "blocked",
				gateStartedAt: new Date(NOW - 5 * MINUTE),
				deployedSha: "d".repeat(40),
			},
			release: { gateState: "blocked" },
			github,
			store,
		});
		expect(decision).toEqual({ state: "deploy" });
		expect(store.clearGateStart).toHaveBeenCalledWith("gc-1");
		expect(store.unblockConnection).toHaveBeenCalledWith("gc-1", true);
		expect(store.recordGateOutcome).toHaveBeenCalledWith(
			"rel-1",
			expect.objectContaining({ gateState: "passed", gateReason: null }),
		);
	});

	it("a pass does not unblock a connection the gate did not block", async () => {
		const github = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([
					check("build", "completed", "success"),
					check("test", "completed", "success"),
				]),
			),
		});
		const store = fakeStore();
		await run({
			connection: { state: "blocked" },
			release: { gateState: null },
			github,
			store,
		});
		expect(store.unblockConnection).not.toHaveBeenCalled();
	});

	it("learns the expected set once and reuses the saved one", async () => {
		const github = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([check("build", "completed", "success")]),
			),
		});
		const store = fakeStore();
		await run({
			release: { gateExpected: { source: "last-green", names: ["build"] } },
			github,
			store,
		});
		expect(github.loadExpectedCheckSet).not.toHaveBeenCalled();
		const outcome = store.recordGateOutcome.mock.calls[0]?.[1];
		expect(outcome).not.toHaveProperty("gateExpected");
	});

	it("never waits for the release run or other runs of the release workflow", async () => {
		const github = fakeGithub({
			loadWorkflowRuns: vi.fn(async () =>
				ok<GateWorkflowRun[]>([
					releaseRun,
					{
						...releaseRun,
						id: 778,
						status: "completed",
						conclusion: "failure",
					},
				]),
			),
			loadCommitChecks: vi.fn(async () =>
				ok([
					check("build", "completed", "success"),
					check("test", "completed", "success"),
					check("publish", "in_progress", null, { runId: 777 }),
					check("publish", "completed", "failure", { runId: 778 }),
					check("dokploy/production", "in_progress", null, { runId: null }),
				]),
			),
		});
		expect(await run({ github })).toEqual({ state: "deploy" });
	});

	it("skips the check runs of the GitHub App when told its slug", async () => {
		const github = fakeGithub({
			loadExpectedCheckSet: vi.fn(async () =>
				ok({ source: "fallback" as const, names: [] }),
			),
			loadCommitChecks: vi.fn(async () =>
				ok([
					check("test", "completed", "success"),
					check("Deploy", "in_progress", null, {
						appSlug: "dokploy-community",
					}),
				]),
			),
		});
		expect(await run({ github, appSlug: "dokploy-community" })).toEqual({
			state: "deploy",
		});
		expect(github.loadExpectedCheckSet).toHaveBeenCalledWith(
			expect.objectContaining({
				branch: "main",
				workflowPath: WORKFLOW,
				appSlug: "dokploy-community",
			}),
		);
	});

	describe("workflows mode", () => {
		const wf = (
			name: string,
			status: string,
			conclusion: string | null,
			id: number,
		): GateWorkflowRun => ({
			id,
			name,
			path: `.github/workflows/${name.toLowerCase()}.yml`,
			runAttempt: 1,
			status,
			conclusion,
			startedAt: null,
		});

		it("reads workflow runs only and passes when the named workflows pass", async () => {
			const github = fakeGithub({
				loadWorkflowRuns: vi.fn(async () =>
					ok([releaseRun, wf("CI", "completed", "success", 5)]),
				),
			});
			const decision = await run({
				connection: { gateMode: "workflows", gateWorkflows: ["CI"] },
				github,
			});
			expect(decision).toEqual({ state: "deploy" });
			expect(github.loadCommitChecks).not.toHaveBeenCalled();
			expect(github.loadExpectedCheckSet).not.toHaveBeenCalled();
		});

		it("a listed workflow with no run waits, then blocks 'Workflow X never ran'", async () => {
			const github = fakeGithub();
			const store = fakeStore();
			const early = await run({
				connection: { gateMode: "workflows", gateWorkflows: ["Security"] },
				github,
				store,
			});
			expect(early).toMatchObject({
				state: "waiting",
				pendingNames: ["Security"],
			});
			expect(store.markGateStarted).toHaveBeenCalled();
			const late = await run({
				connection: {
					gateMode: "workflows",
					gateWorkflows: ["Security"],
					gateStartedAt: new Date(NOW - 5 * MINUTE),
					gateTimeoutMinutes: 5,
				},
				github,
			});
			expect(late).toMatchObject({
				state: "blocked",
				reason: "Workflow Security never ran",
			});
		});
	});

	describe("when GitHub cannot be read", () => {
		it("a rate limit waits and tries again", async () => {
			const github = fakeGithub({
				loadWorkflowRuns: vi.fn(async () => ({
					kind: "failed" as const,
					failure: { kind: "rate-limited" as const, retryAt: NOW + 1000 },
				})),
			});
			const store = fakeStore();
			const decision = await run({ github, store });
			expect(decision).toMatchObject({
				state: "waiting",
				reason: "GitHub could not be read, trying again",
			});
			expect(store.markGateStarted).toHaveBeenCalled();
		});

		it("a refused token blocks at once, with a way out", async () => {
			const github = fakeGithub({
				loadCommitChecks: vi.fn(async () => ({
					kind: "failed" as const,
					failure: { kind: "forbidden" as const, message: "no" },
				})),
			});
			const decision = await run({ github });
			expect(decision).toMatchObject({
				state: "blocked",
				reason: "GitHub did not let Dokploy read the checks. Reconnect GitHub.",
			});
		});

		it("an outage that outlasts the timeout blocks", async () => {
			const github = fakeGithub({
				loadWorkflowRuns: vi.fn(async () => ({
					kind: "failed" as const,
					failure: { kind: "error" as const, status: 502 },
				})),
			});
			const decision = await run({
				connection: {
					gateStartedAt: new Date(NOW - 5 * MINUTE),
					gateTimeoutMinutes: 5,
				},
				github,
			});
			expect(decision).toMatchObject({
				state: "blocked",
				reason: "GitHub could not be read for 5 minutes",
			});
		});

		it("a failure to learn the expected set is retried, not guessed", async () => {
			const github = fakeGithub({
				loadExpectedCheckSet: vi.fn(async () => ({
					kind: "failed" as const,
					failure: { kind: "error" as const, status: 500 },
				})),
			});
			const store = fakeStore();
			const decision = await run({ github, store });
			expect(decision.state).toBe("waiting");
			const outcome = store.recordGateOutcome.mock.calls[0]?.[1];
			expect(outcome).not.toHaveProperty("gateExpected");
		});
	});
});
