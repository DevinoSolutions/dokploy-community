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
	gateBlocked: false,
	repoFullName: "acme/shop",
	repoId: 123,
	gateVersion: 0,
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
	gateCheckedAt: null,
	...overrides,
});

let nextId = 1;
/** A check run of an app that is not GitHub Actions: it has a check suite, but no workflow run. */
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
	appSlug: "ci-app",
	appId: 999,
	runId: null,
	checkSuiteId: 900_000 + nextId,
	...extra,
});

const ok = <T>(value: T): GateRead<T> => ({ kind: "ok", value });
const run = (overrides: Partial<GateWorkflowRun> = {}): GateWorkflowRun => ({
	id: 777,
	name: "Dokploy",
	path: WORKFLOW,
	runAttempt: 1,
	status: "in_progress",
	conclusion: null,
	startedAt: null,
	event: "push",
	headBranch: "main",
	headRepository: "acme/shop",
	headRepositoryId: 123,
	checkSuiteId: 50_777,
	...overrides,
});
const releaseRun = run();

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

const fakeStore = (recorded = true) => {
	const store = {
		clearGateStart: vi.fn(async () => {}),
		recordGateOutcome: vi.fn(
			async (_connectionId: string, _releaseId: string, _o: GateOutcome) =>
				recorded,
		),
	};
	return store satisfies DeployGateStore;
};
const outcomeOf = (store: ReturnType<typeof fakeStore>) =>
	store.recordGateOutcome.mock.calls[0]?.[2] as GateOutcome;

const runGate = (
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
		const decision = await runGate({
			connection: { gateMode: "image" },
			github,
			store,
		});
		expect(decision).toEqual({ state: "deploy" });
		expect(github.loadWorkflowRuns).not.toHaveBeenCalled();
		expect(github.loadCommitChecks).not.toHaveBeenCalled();
		expect(store.recordGateOutcome).not.toHaveBeenCalled();
		expect(store.clearGateStart).not.toHaveBeenCalled();
	});

	it("an overridden release deploys at once, without reading GitHub", async () => {
		const github = fakeGithub();
		const decision = await runGate({
			release: { gateState: "overridden" },
			github,
		});
		expect(decision).toEqual({ state: "deploy", overridden: true });
		expect(github.loadCommitChecks).not.toHaveBeenCalled();
	});

	it("the first waiting evaluation marks the start and records the waiting state with the learned set", async () => {
		const github = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([
					check("build", "completed", "success"),
					check("test", "in_progress", null),
				]),
			),
		});
		const store = fakeStore();
		const decision = await runGate({ github, store });
		expect(decision).toMatchObject({
			state: "waiting",
			pendingNames: ["test"],
		});
		expect(store.recordGateOutcome).toHaveBeenCalledWith("gc-1", "rel-1", {
			gateState: "waiting",
			gateReason: "Waiting for test",
			checkedAt: new Date(NOW),
			previousCheckedAt: null,
			gateVersion: 0,
			gateExpected: { source: "required", names: ["build", "test"] },
			gateStart: "mark",
			connection: "keep",
			hasRelease: false,
		});
	});

	it("hands the compare-and-set value (the gateCheckedAt it read) to the store", async () => {
		const seen = new Date(NOW - MINUTE);
		const store = fakeStore();
		await runGate({ release: { gateCheckedAt: seen }, store });
		expect(outcomeOf(store).previousCheckedAt).toEqual(seen);
	});

	it("hands the gateVersion it read to the store, so a settings change in between discards the write", async () => {
		const store = fakeStore();
		await runGate({ connection: { gateVersion: 7 }, store });
		expect(outcomeOf(store).gateVersion).toBe(7);
	});

	it("passes the repository id to the expected-set read and compares run repositories by it", async () => {
		const github = fakeGithub({
			loadWorkflowRuns: vi.fn(async () =>
				ok<GateWorkflowRun[]>([run({ headRepositoryId: 999 })]),
			),
		});
		await runGate({ github });
		expect(github.loadExpectedCheckSet).toHaveBeenCalledWith(
			expect.objectContaining({ repositoryId: 123 }),
		);
	});

	it("a later evaluation keeps the start it has", async () => {
		const store = fakeStore();
		await runGate({
			connection: { gateStartedAt: new Date(NOW - 5 * MINUTE) },
			store,
		});
		expect(outcomeOf(store).gateStart).toBe("keep");
	});

	it("a start from before this release belongs to an older release: it starts over", async () => {
		const store = fakeStore();
		const decision = await runGate({
			connection: { gateStartedAt: new Date(NOW - 180 * MINUTE) },
			store,
		});
		expect(decision.state).toBe("waiting");
		expect(outcomeOf(store).gateStart).toBe("mark");
	});

	it("a name that never reports blocks after the timeout and blocks the connection", async () => {
		const github = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([check("build", "completed", "success")]),
			),
		});
		const store = fakeStore();
		const decision = await runGate({
			connection: {
				gateStartedAt: new Date(NOW - 5 * MINUTE),
				gateTimeoutMinutes: 5,
			},
			github,
			store,
		});
		expect(decision).toMatchObject({
			state: "blocked",
			reason: "Check test never reported",
		});
		expect(outcomeOf(store)).toMatchObject({
			gateState: "blocked",
			gateReason: "Check test never reported",
			connection: "block",
			gateStart: "keep",
		});
		expect(store.clearGateStart).not.toHaveBeenCalled();
	});

	it("keeps a block the gate did not set: it neither replaces nor lifts it", async () => {
		const failing = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([check("build", "completed", "failure")]),
			),
		});
		const store = fakeStore();
		await runGate({
			connection: { state: "blocked", gateBlocked: false },
			github: failing,
			store,
		});
		expect(outcomeOf(store).connection).toBe("keep");
		const passing = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([
					check("build", "completed", "success"),
					check("test", "completed", "success"),
				]),
			),
		});
		const store2 = fakeStore();
		await runGate({
			connection: { state: "blocked", gateBlocked: false },
			release: { gateState: "blocked" },
			github: passing,
			store: store2,
		});
		expect(outcomeOf(store2).connection).toBe("keep");
	});

	it("the gate's own block is refreshed when it blocks again", async () => {
		const github = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([check("build", "completed", "failure")]),
			),
		});
		const store = fakeStore();
		await runGate({
			connection: { state: "blocked", gateBlocked: true },
			release: { gateState: "blocked" },
			github,
			store,
		});
		expect(outcomeOf(store).connection).toBe("block");
	});

	it("a passing re-run deploys, clears the start and lifts the gate's block", async () => {
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
		const decision = await runGate({
			connection: {
				state: "blocked",
				gateBlocked: true,
				gateStartedAt: new Date(NOW - 5 * MINUTE),
				deployedSha: "d".repeat(40),
			},
			release: { gateState: "blocked" },
			github,
			store,
		});
		expect(decision).toEqual({ state: "deploy" });
		expect(outcomeOf(store)).toMatchObject({
			gateState: "passed",
			gateReason: null,
			gateStart: "clear",
			connection: "unblock",
			hasRelease: true,
		});
	});

	it("a re-run that is only waiting also lifts the gate's block", async () => {
		const github = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([
					check("build", "completed", "success"),
					check("test", "in_progress", null),
				]),
			),
		});
		const store = fakeStore();
		await runGate({
			connection: {
				state: "blocked",
				gateBlocked: true,
				gateStartedAt: new Date(NOW - 5 * MINUTE),
			},
			release: { gateState: "blocked" },
			github,
			store,
		});
		expect(outcomeOf(store)).toMatchObject({
			gateState: "waiting",
			connection: "unblock",
		});
	});

	it("does nothing and does not deploy when the store says the release changed meanwhile", async () => {
		const github = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([
					check("build", "completed", "success"),
					check("test", "completed", "success"),
				]),
			),
		});
		const decision = await runGate({ github, store: fakeStore(false) });
		expect(decision).toMatchObject({
			state: "waiting",
			reason: "Checking again",
		});
	});

	it("learns the expected set once and reuses the saved one", async () => {
		const github = fakeGithub({
			loadCommitChecks: vi.fn(async () =>
				ok([check("build", "completed", "success")]),
			),
		});
		const store = fakeStore();
		await runGate({
			release: { gateExpected: { source: "last-green", names: ["build"] } },
			github,
			store,
		});
		expect(github.loadExpectedCheckSet).not.toHaveBeenCalled();
		expect(outcomeOf(store)).not.toHaveProperty("gateExpected");
	});

	it("never waits for the release run or other runs of the release workflow", async () => {
		const other = run({
			id: 778,
			status: "completed",
			conclusion: "failure",
			checkSuiteId: 50_778,
		});
		const github = fakeGithub({
			loadWorkflowRuns: vi.fn(async () => ok([releaseRun, other])),
			loadCommitChecks: vi.fn(async () =>
				ok([
					check("build", "completed", "success"),
					check("test", "completed", "success"),
					check("publish", "in_progress", null, {
						appSlug: "github-actions",
						runId: 777,
					}),
					check("publish", "completed", "failure", {
						appSlug: "github-actions",
						runId: 778,
					}),
					check("dokploy/production", "in_progress", null),
				]),
			),
		});
		expect(await runGate({ github })).toEqual({ state: "deploy" });
	});

	it("passes where runs must come from: the tracked branch of this repository", async () => {
		const ci = run({
			id: 5,
			name: "CI",
			path: ".github/workflows/ci.yml",
			status: "completed",
			conclusion: "success",
			checkSuiteId: 50_005,
		});
		const fork = {
			...ci,
			id: 6,
			event: "pull_request",
			headRepository: "evil/shop",
			headRepositoryId: 999,
		};
		const github = fakeGithub({
			loadWorkflowRuns: vi.fn(async () => ok([releaseRun, fork])),
		});
		const decision = await runGate({
			connection: { gateMode: "workflows", gateWorkflows: ["CI"] },
			github,
		});
		expect(decision.state).toBe("waiting");
		const github2 = fakeGithub({
			loadWorkflowRuns: vi.fn(async () => ok([releaseRun, ci])),
		});
		expect(
			await runGate({
				connection: { gateMode: "workflows", gateWorkflows: ["CI"] },
				github: github2,
			}),
		).toEqual({ state: "deploy" });
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
		expect(await runGate({ github, appSlug: "dokploy-community" })).toEqual({
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
		): GateWorkflowRun =>
			run({
				id,
				name,
				path: `.github/workflows/${name.toLowerCase()}.yml`,
				status,
				conclusion,
				checkSuiteId: id + 50_000,
			});

		it("reads workflow runs only and passes when the named workflows pass", async () => {
			const github = fakeGithub({
				loadWorkflowRuns: vi.fn(async () =>
					ok([releaseRun, wf("CI", "completed", "success", 5)]),
				),
			});
			const decision = await runGate({
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
			const early = await runGate({
				connection: { gateMode: "workflows", gateWorkflows: ["Security"] },
				github,
				store,
			});
			expect(early).toMatchObject({
				state: "waiting",
				pendingNames: ["Security"],
			});
			expect(outcomeOf(store).gateStart).toBe("mark");
			const late = await runGate({
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
			const decision = await runGate({ github, store });
			expect(decision).toMatchObject({
				state: "waiting",
				reason: "GitHub could not be read, trying again",
			});
			expect(outcomeOf(store).gateStart).toBe("mark");
		});

		it("a refused token blocks at once, with a way out", async () => {
			const github = fakeGithub({
				loadCommitChecks: vi.fn(async () => ({
					kind: "failed" as const,
					failure: { kind: "forbidden" as const, message: "no" },
				})),
			});
			expect(await runGate({ github })).toMatchObject({
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
			expect(
				await runGate({
					connection: {
						gateStartedAt: new Date(NOW - 5 * MINUTE),
						gateTimeoutMinutes: 5,
					},
					github,
				}),
			).toMatchObject({
				state: "blocked",
				reason: "GitHub could not be read for 5 minutes",
			});
		});

		it("branch protection that cannot be read waits and is not guessed or saved", async () => {
			const github = fakeGithub({
				loadExpectedCheckSet: vi.fn(async () => ({
					kind: "failed" as const,
					failure: { kind: "error" as const, status: 500 },
					stage: "protection" as const,
				})),
			});
			const store = fakeStore();
			const decision = await runGate({ github, store });
			expect(decision).toMatchObject({
				state: "waiting",
				reason: "could not read branch protection, retrying",
			});
			expect(github.loadCommitChecks).not.toHaveBeenCalled();
			expect(outcomeOf(store)).not.toHaveProperty("gateExpected");
		});

		it("history that cannot be read waits with the general reason", async () => {
			const github = fakeGithub({
				loadExpectedCheckSet: vi.fn(async () => ({
					kind: "failed" as const,
					failure: { kind: "error" as const, status: 500 },
					stage: "history" as const,
				})),
			});
			expect(await runGate({ github })).toMatchObject({
				reason: "GitHub could not be read, trying again",
			});
		});
	});
});
