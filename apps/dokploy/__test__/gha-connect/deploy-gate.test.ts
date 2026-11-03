import {
	createDefaultExclusion,
	type DeployGateInput,
	describeGateDecision,
	evaluateDeployGate,
	type GateCheck,
	type GateDecision,
	type GateWorkflowRun,
	greenCheckRunNames,
	resolveChecks,
} from "@dokploy/server/services/gha-connect/deploy-gate";
import { describe, expect, it } from "vitest";

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-03T12:00:00Z");
const TRUST = { branch: "main", repository: "acme/shop" };

let nextId = 1;
const id = () => nextId++;

/** A check run of an app that is not GitHub Actions (CircleCI, a bot): it has no workflow run. */
const check = (
	name: string,
	status: "queued" | "in_progress" | "completed",
	conclusion: string | null = null,
	extra: Partial<GateCheck> = {},
): GateCheck => ({
	name,
	kind: "check-run",
	status,
	conclusion: status === "completed" ? (conclusion ?? "success") : null,
	id: id(),
	startedAt: null,
	appSlug: "ci-app",
	appId: 999,
	runId: null,
	checkSuiteId: null,
	...extra,
});
const pass = (name: string, extra: Partial<GateCheck> = {}) =>
	check(name, "completed", "success", extra);
const fail = (name: string, extra: Partial<GateCheck> = {}) =>
	check(name, "completed", "failure", extra);
const running = (name: string, extra: Partial<GateCheck> = {}) =>
	check(name, "in_progress", null, extra);
const statusOf = (
	context: string,
	state: "success" | "failure" | "pending",
	extra: Partial<GateCheck> = {},
): GateCheck => ({
	name: context,
	kind: "status",
	status: state === "pending" ? "in_progress" : "completed",
	conclusion: state === "pending" ? null : state,
	id: id(),
	startedAt: null,
	appSlug: null,
	appId: null,
	runId: null,
	checkSuiteId: null,
	...extra,
});

/** A workflow run that counts: a push to the tracked branch of the connection's repository. */
const workflowRun = (
	name: string,
	status: "queued" | "in_progress" | "completed",
	conclusion: string | null = null,
	extra: Partial<GateWorkflowRun> = {},
): GateWorkflowRun => {
	const runId = id();
	return {
		id: runId,
		name,
		path: `.github/workflows/${name.toLowerCase().replace(/\s+/g, "-")}.yml`,
		runAttempt: 1,
		status,
		conclusion: status === "completed" ? (conclusion ?? "success") : null,
		startedAt: null,
		event: "push",
		headBranch: "main",
		headRepository: "acme/shop",
		checkSuiteId: runId + 50_000,
		...extra,
	};
};

/** A check run of a job of `run`, as GitHub Actions reports it. */
const job = (
	run: GateWorkflowRun,
	name: string,
	status: "queued" | "in_progress" | "completed",
	conclusion: string | null = null,
	extra: Partial<GateCheck> = {},
): GateCheck =>
	check(name, status, conclusion, {
		appSlug: "github-actions",
		appId: 15368,
		runId: run.id,
		checkSuiteId: run.checkSuiteId,
		...extra,
	});

const input = (overrides: Partial<DeployGateInput> = {}): DeployGateInput => ({
	mode: "checks",
	now: NOW,
	startedAt: NOW - 5 * MINUTE,
	timeoutMs: 60 * MINUTE,
	expected: null,
	checks: [],
	workflows: [],
	workflowRuns: [],
	excludedRunIds: [],
	trust: TRUST,
	...overrides,
});

const required = (...names: string[]) => ({
	source: "required" as const,
	names,
});
const lastGreen = (...names: string[]) => ({
	source: "last-green" as const,
	names,
});

const blocked = (decision: GateDecision) => {
	expect(decision.state).toBe("blocked");
	if (decision.state !== "blocked") throw new Error("not blocked");
	return decision;
};
const waiting = (decision: GateDecision) => {
	expect(decision.state).toBe("waiting");
	if (decision.state !== "waiting") throw new Error("not waiting");
	return decision;
};

describe("image mode", () => {
	it("deploys without looking at anything", () => {
		expect(
			evaluateDeployGate(
				input({
					mode: "image",
					checks: [fail("build")],
					expected: required("x"),
				}),
			),
		).toEqual({ state: "deploy" });
	});
});

describe("checks mode with the required checks of the branch", () => {
	it("deploys when every required check passed (success, neutral and skipped pass)", () => {
		const decision = evaluateDeployGate(
			input({
				expected: required("build", "lint", "e2e"),
				checks: [
					pass("build"),
					check("lint", "completed", "neutral"),
					check("e2e", "completed", "skipped"),
				],
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
	});

	it("waits on a check that is still running, and names it", () => {
		const decision = waiting(
			evaluateDeployGate(
				input({
					expected: required("build", "test"),
					checks: [pass("build"), running("test")],
				}),
			),
		);
		expect(decision.pendingNames).toEqual(["test"]);
		expect(decision.reason).toBe("Waiting for test");
	});

	it("waits on a check that has not been created yet", () => {
		const decision = waiting(
			evaluateDeployGate(
				input({ expected: required("build", "test"), checks: [pass("build")] }),
			),
		);
		expect(decision.pendingNames).toEqual(["test"]);
	});

	it("blocks on a failing check and names it, even while others still run", () => {
		const decision = blocked(
			evaluateDeployGate(
				input({
					expected: required("build", "test", "e2e"),
					checks: [fail("test"), running("e2e")],
				}),
			),
		);
		expect(decision.failedNames).toEqual(["test"]);
		expect(decision.reason).toBe("Check test failed");
	});

	it("treats cancelled, timed out and action required as failures", () => {
		for (const conclusion of ["cancelled", "timed_out", "action_required"]) {
			const decision = evaluateDeployGate(
				input({
					expected: required("build"),
					checks: [check("build", "completed", conclusion)],
				}),
			);
			expect(decision.state, conclusion).toBe("blocked");
		}
	});

	it("a required check may be a commit status context", () => {
		const decision = evaluateDeployGate(
			input({
				expected: required("ci/circleci: build"),
				checks: [statusOf("ci/circleci: build", "success")],
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
	});
});

describe("the expected set decides what to wait for, not what may fail", () => {
	it("a failing check outside the expected set blocks", () => {
		const decision = blocked(
			evaluateDeployGate(
				input({
					expected: required("build"),
					checks: [pass("build"), fail("optional-lint")],
				}),
			),
		);
		expect(decision.failedNames).toEqual(["optional-lint"]);
		expect(decision.reason).toBe("Check optional-lint failed");
	});

	it("a failing commit status outside the expected set blocks", () => {
		const decision = evaluateDeployGate(
			input({
				expected: required("build"),
				checks: [pass("build"), statusOf("ci/legacy", "failure")],
			}),
		);
		expect(decision.state).toBe("blocked");
	});

	it("a check outside the expected set that is still running is not waited for", () => {
		const decision = evaluateDeployGate(
			input({
				expected: required("build"),
				checks: [pass("build"), running("nightly")],
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
	});

	it("a failed workflow run with no check run at all blocks too (it failed before any job)", () => {
		const startup = workflowRun("CI", "completed", "startup_failure");
		const decision = blocked(
			evaluateDeployGate(
				input({
					expected: required("build"),
					checks: [pass("build")],
					workflowRuns: [startup],
				}),
			),
		);
		expect(decision.reason).toBe("Workflow CI failed");
	});

	it("last-green: a new check the last green commit did not have is not waited for, but failing blocks", () => {
		expect(
			evaluateDeployGate(
				input({
					expected: lastGreen("build"),
					checks: [pass("build"), running("brand-new")],
				}),
			),
		).toEqual({ state: "deploy" });
		expect(
			evaluateDeployGate(
				input({
					expected: lastGreen("build"),
					checks: [pass("build"), fail("brand-new")],
				}),
			).state,
		).toBe("blocked");
	});

	it("last-green: is evaluated like a required set", () => {
		const decision = waiting(
			evaluateDeployGate(
				input({
					expected: lastGreen("build", "test"),
					checks: [pass("build")],
				}),
			),
		);
		expect(decision.pendingNames).toEqual(["test"]);
	});
});

describe("the latest attempt decides", () => {
	it("a failure followed by a passing re-run deploys (re-evaluation un-blocks)", () => {
		const first = fail("test");
		const rerun = pass("test");
		expect(
			blocked(
				evaluateDeployGate(
					input({ expected: required("test"), checks: [first] }),
				),
			).failedNames,
		).toEqual(["test"]);
		expect(
			evaluateDeployGate(
				input({ expected: required("test"), checks: [first, rerun] }),
			),
		).toEqual({ state: "deploy" });
		expect(
			evaluateDeployGate(
				input({ expected: required("test"), checks: [rerun, first] }),
			),
		).toEqual({ state: "deploy" });
	});

	it("a pass followed by a failing re-run blocks; a failure followed by a running re-run waits", () => {
		expect(
			evaluateDeployGate(
				input({
					expected: required("test"),
					checks: [pass("test"), fail("test")],
				}),
			).state,
		).toBe("blocked");
		expect(
			evaluateDeployGate(
				input({
					expected: required("test"),
					checks: [fail("test"), running("test")],
				}),
			).state,
		).toBe("waiting");
	});

	it("start time beats id when both attempts have one; the id decides otherwise", () => {
		const older = fail("test", { id: 900, startedAt: "2026-11-03T11:00:00Z" });
		const newer = pass("test", { id: 100, startedAt: "2026-11-03T11:30:00Z" });
		expect(
			evaluateDeployGate(
				input({ expected: required("test"), checks: [older, newer] }),
			),
		).toEqual({ state: "deploy" });
		const same = "2026-11-03T11:00:00Z";
		expect(
			evaluateDeployGate(
				input({
					expected: required("test"),
					checks: [
						fail("test", { id: 5, startedAt: same }),
						pass("test", { id: 6, startedAt: same }),
					],
				}),
			),
		).toEqual({ state: "deploy" });
	});

	it("an older run of a workflow does not count once a newer run exists", () => {
		const older = workflowRun("CI", "completed", "failure", { id: 10 });
		const newer = workflowRun("CI", "completed", "success", { id: 20 });
		const base = {
			expected: required("build"),
			checks: [
				job(older, "build", "completed", "failure"),
				job(newer, "build", "completed", "success"),
			],
		};
		expect(
			evaluateDeployGate(input({ ...base, workflowRuns: [older, newer] })),
		).toEqual({ state: "deploy" });
		// And the other way round: the newer run failed.
		const failedNewer = workflowRun("CI", "completed", "failure", { id: 30 });
		expect(
			evaluateDeployGate(
				input({
					expected: required("build"),
					checks: [
						job(newer, "build", "completed", "success"),
						job(failedNewer, "build", "completed", "failure"),
					],
					workflowRuns: [newer, failedNewer],
				}),
			).state,
		).toBe("blocked");
	});

	it("a re-run of the same run (higher attempt) replaces the earlier attempt", () => {
		const a1 = workflowRun("CI", "completed", "failure", {
			id: 40,
			runAttempt: 1,
		});
		const a2 = workflowRun("CI", "in_progress", null, {
			id: 40,
			runAttempt: 2,
		});
		const decision = evaluateDeployGate(
			input({ expected: required("build"), workflowRuns: [a1, a2], checks: [] }),
		);
		expect(decision.state).toBe("waiting");
	});
});

describe("results that do not count (a result must not be spoofable)", () => {
	it("a pull request run, even a newer passing one, cannot turn a failed push check green", () => {
		const push = workflowRun("CI", "completed", "failure", { id: 100 });
		const fork = workflowRun("CI", "completed", "success", {
			id: 200,
			event: "pull_request",
			headBranch: "feature",
			headRepository: "evil/shop",
		});
		const decision = blocked(
			evaluateDeployGate(
				input({
					expected: required("build"),
					workflowRuns: [push, fork],
					checks: [
						job(push, "build", "completed", "failure"),
						job(fork, "build", "completed", "success"),
					],
				}),
			),
		);
		expect(decision.failedNames).toContain("build");
	});

	it("a run from another branch or another repository does not count", () => {
		for (const other of [
			{ headBranch: "dev" },
			{ headRepository: "evil/shop" },
			{ event: "pull_request" },
			{ event: "schedule" },
		]) {
			const run = workflowRun("CI", "completed", "success", other);
			const decision = evaluateDeployGate(
				input({
					expected: required("build"),
					workflowRuns: [run],
					checks: [job(run, "build", "completed", "success")],
				}),
			);
			expect(decision.state, JSON.stringify(other)).toBe("waiting");
		}
	});

	it("a manual dispatch of the tracked branch counts, and the repository compares case-insensitively", () => {
		const run = workflowRun("CI", "completed", "success", {
			event: "workflow_dispatch",
			headRepository: "Acme/Shop",
		});
		expect(
			evaluateDeployGate(
				input({
					expected: required("build"),
					workflowRuns: [run],
					checks: [job(run, "build", "completed", "success")],
				}),
			),
		).toEqual({ state: "deploy" });
	});

	it("two workflows sharing a job name cannot hide each other's failure", () => {
		const ci = workflowRun("CI", "completed", "failure", { id: 100 });
		const other = workflowRun("Other", "completed", "success", { id: 200 });
		const decision = blocked(
			evaluateDeployGate(
				input({
					expected: required("build"),
					workflowRuns: [ci, other],
					checks: [
						job(ci, "build", "completed", "failure"),
						job(other, "build", "completed", "success"),
					],
				}),
			),
		);
		expect(decision.failedNames).toContain("build");
	});

	it("a GitHub Actions check run whose run is not listed is not trusted", () => {
		const stray = check("build", "completed", "success", {
			appSlug: "github-actions",
			runId: 424242,
		});
		const decision = waiting(
			evaluateDeployGate(input({ expected: required("build"), checks: [stray] })),
		);
		expect(decision.pendingNames).toEqual(["build"]);
		// ... and one with no run at all claiming to be Actions is not either.
		const noRun = check("build", "completed", "success", {
			appSlug: "github-actions",
		});
		expect(
			evaluateDeployGate(input({ expected: required("build"), checks: [noRun] }))
				.state,
		).toBe("waiting");
	});

	it("a check run finds its run by check suite when the details URL names none", () => {
		const run = workflowRun("CI", "completed", "success");
		const viaSuite = job(run, "build", "completed", "success", { runId: null });
		expect(
			evaluateDeployGate(
				input({
					expected: required("build"),
					workflowRuns: [run],
					checks: [viaSuite],
				}),
			),
		).toEqual({ state: "deploy" });
	});

	it("a newer commit status never overrides a failed check run of the same name", () => {
		const decision = evaluateDeployGate(
			input({
				expected: required("build"),
				checks: [
					fail("build", { id: 1, startedAt: "2026-11-03T11:00:00Z" }),
					statusOf("build", "success", {
						id: 2,
						startedAt: "2026-11-03T11:30:00Z",
					}),
				],
			}),
		);
		expect(decision.state).toBe("blocked");
	});

	it("a status counts for a name no check run reports", () => {
		expect(
			evaluateDeployGate(
				input({
					expected: required("ci/legacy"),
					checks: [statusOf("ci/legacy", "success")],
				}),
			),
		).toEqual({ state: "deploy" });
	});

	it("a required check pinned to an app is satisfied by that app only", () => {
		const expected = {
			source: "required" as const,
			names: ["build"],
			appIds: { build: 15368 },
		};
		const other = pass("build", { appId: 777 });
		const asStatus = statusOf("build", "success");
		expect(
			evaluateDeployGate(
				input({ expected, checks: [other, asStatus] }),
			).state,
		).toBe("waiting");
		const right = pass("build", { appId: 15368 });
		expect(
			evaluateDeployGate(input({ expected, checks: [other, right] })),
		).toEqual({ state: "deploy" });
	});

	it("resolveChecks keeps one result per workflow and name", () => {
		const ci = workflowRun("CI", "completed", "success");
		const resolved = resolveChecks({
			checks: [
				job(ci, "build", "completed", "success"),
				job(ci, "test", "completed", "success"),
				statusOf("ci/x", "success"),
			],
			workflowRuns: [ci],
			trust: TRUST,
			excludedRunIds: [],
			isExcluded: () => false,
		});
		expect(resolved.map((r) => r.name).sort()).toEqual([
			"build",
			"ci/x",
			"test",
		]);
	});
});

describe("a name that never reports", () => {
	it("waits until the timeout, then blocks with 'Check X never reported'", () => {
		const base = input({
			expected: required("build", "deploy-preview"),
			checks: [pass("build")],
		});
		expect(evaluateDeployGate(base).state).toBe("waiting");
		const late = blocked(
			evaluateDeployGate({ ...base, startedAt: NOW - 61 * MINUTE }),
		);
		expect(late.reason).toBe("Check deploy-preview never reported");
		expect(late.neverReported).toEqual(["deploy-preview"]);
		expect(late.failedNames).toEqual([]);
	});

	it("blocks exactly at the timeout, not a minute before", () => {
		const base = input({ expected: required("x"), timeoutMs: 30 * MINUTE });
		expect(
			evaluateDeployGate({ ...base, startedAt: NOW - 29 * MINUTE }).state,
		).toBe("waiting");
		expect(
			evaluateDeployGate({ ...base, startedAt: NOW - 30 * MINUTE }).state,
		).toBe("blocked");
	});

	it("names several at once", () => {
		const decision = blocked(
			evaluateDeployGate(
				input({ expected: required("a", "b"), startedAt: NOW - 90 * MINUTE }),
			),
		);
		expect(decision.reason).toBe("Checks a, b never reported");
	});

	it("a check that started but did not finish in time is told apart", () => {
		const decision = blocked(
			evaluateDeployGate(
				input({
					expected: required("build", "slow"),
					checks: [pass("build"), running("slow")],
					startedAt: NOW - 61 * MINUTE,
				}),
			),
		);
		expect(decision.unfinished).toEqual(["slow"]);
		expect(decision.neverReported).toEqual([]);
		expect(decision.reason).toBe("Check slow did not finish in 60 minutes");
	});

	it("a fresh re-run after the timeout waits; it is measured from its own start", () => {
		const base = input({
			expected: required("slow"),
			startedAt: NOW - 90 * MINUTE,
		});
		const fresh = running("slow", {
			startedAt: new Date(NOW - 2 * MINUTE).toISOString(),
		});
		expect(evaluateDeployGate({ ...base, checks: [fresh] }).state).toBe(
			"waiting",
		);
		const stale = running("slow", {
			startedAt: new Date(NOW - 61 * MINUTE).toISOString(),
		});
		expect(evaluateDeployGate({ ...base, checks: [stale] }).state).toBe(
			"blocked",
		);
	});

	it("a failure still says failed after the timeout", () => {
		const decision = blocked(
			evaluateDeployGate(
				input({
					expected: required("a", "b"),
					checks: [fail("a")],
					startedAt: NOW - 90 * MINUTE,
				}),
			),
		);
		expect(decision.failedNames).toEqual(["a"]);
	});

	it("the first evaluation has no start yet and never times out", () => {
		const decision = evaluateDeployGate(
			input({
				expected: required("a"),
				startedAt: null,
				timeoutMs: 5 * MINUTE,
			}),
		);
		expect(decision.state).toBe("waiting");
	});
});

describe("the fallback: no expected set", () => {
	it("check runs: waits for the first one, then for none to be running", () => {
		const noneYet = waiting(evaluateDeployGate(input({ expected: null })));
		expect(noneYet.reason).toBe("Waiting for the first check to start");
		expect(
			evaluateDeployGate(
				input({
					expected: { source: "fallback", names: [] },
					checks: [pass("build"), running("test")],
				}),
			).state,
		).toBe("waiting");
		expect(
			evaluateDeployGate(input({ checks: [pass("build"), pass("test")] })),
		).toEqual({ state: "deploy" });
	});

	it("a queued check counts as not finished; a failing one blocks", () => {
		const decision = waiting(
			evaluateDeployGate(
				input({ checks: [pass("build"), check("test", "queued")] }),
			),
		);
		expect(decision.pendingNames).toEqual(["test"]);
		expect(
			blocked(evaluateDeployGate(input({ checks: [pass("build"), fail("test")] })))
				.failedNames,
		).toEqual(["test"]);
	});

	it("a repository with only commit statuses uses them", () => {
		expect(
			evaluateDeployGate(input({ checks: [statusOf("ci/travis", "pending")] }))
				.state,
		).toBe("waiting");
		expect(
			evaluateDeployGate(input({ checks: [statusOf("ci/travis", "success")] })),
		).toEqual({ state: "deploy" });
		expect(
			blocked(
				evaluateDeployGate(input({ checks: [statusOf("ci/travis", "failure")] })),
			).failedNames,
		).toEqual(["ci/travis"]);
	});

	it("a status that went from pending to success is judged by its latest state", () => {
		const decision = evaluateDeployGate(
			input({
				checks: [
					statusOf("ci/travis", "pending", {
						id: 1,
						startedAt: "2026-11-03T11:00:00Z",
					}),
					statusOf("ci/travis", "success", {
						id: 2,
						startedAt: "2026-11-03T11:10:00Z",
					}),
				],
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
	});

	it("nothing ever reporting blocks at the timeout", () => {
		const decision = blocked(
			evaluateDeployGate(input({ startedAt: NOW - 61 * MINUTE })),
		);
		expect(decision.reason).toBe(
			"No checks reported on this commit in 60 minutes",
		);
	});

	it("an expected set with no usable names is the fallback", () => {
		expect(
			evaluateDeployGate(
				input({ expected: required("dokploy/deploy"), checks: [pass("build")] }),
			),
		).toEqual({ state: "deploy" });
	});

	it("does not deploy between jobs: a workflow run still going waits, even with every check so far green", () => {
		const ci = workflowRun("CI", "in_progress");
		const decision = waiting(
			evaluateDeployGate(
				input({
					workflowRuns: [ci],
					checks: [job(ci, "lint", "completed", "success")],
				}),
			),
		);
		expect(decision.pendingNames).toEqual(["CI"]);
	});

	it("waits for a run that has no check run yet, and blocks on a failed one", () => {
		expect(
			evaluateDeployGate(input({ workflowRuns: [workflowRun("CI", "queued")] }))
				.state,
		).toBe("waiting");
		const decision = blocked(
			evaluateDeployGate(
				input({
					checks: [pass("lint")],
					workflowRuns: [workflowRun("CI", "completed", "failure")],
				}),
			),
		);
		expect(decision.reason).toBe("Workflow CI failed");
	});

	it("does not wait for the release run, nor for a run that does not count", () => {
		const release = workflowRun("Dokploy", "in_progress");
		const fork = workflowRun("CI", "in_progress", null, {
			event: "pull_request",
			headRepository: "evil/shop",
		});
		expect(
			evaluateDeployGate(
				input({
					checks: [pass("test")],
					workflowRuns: [release, fork],
					excludedRunIds: [release.id],
				}),
			),
		).toEqual({ state: "deploy" });
	});
});

describe("what the gate never waits for", () => {
	it("the release run: its checks do not block, wait or count", () => {
		const release = workflowRun("Dokploy", "in_progress", null, { id: 777 });
		const other = workflowRun("Other", "completed", "failure", { id: 778 });
		const decision = evaluateDeployGate(
			input({
				expected: required("test"),
				workflowRuns: [release, other],
				checks: [
					pass("test"),
					job(release, "publish", "in_progress"),
					job(release, "build-and-push", "completed", "failure"),
				],
				excludedRunIds: [777, 778],
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
		// The same failure from a run that is not excluded does count.
		const counted = workflowRun("Other", "completed", "failure", { id: 779 });
		expect(
			evaluateDeployGate(
				input({
					expected: required("test"),
					workflowRuns: [release, counted],
					checks: [pass("test"), job(counted, "build-and-push", "completed", "failure")],
					excludedRunIds: [777],
				}),
			).state,
		).toBe("blocked");
	});

	it("Dokploy's own statuses (dokploy/ prefix)", () => {
		const decision = evaluateDeployGate(
			input({
				checks: [
					pass("test"),
					statusOf("dokploy/production", "pending"),
					statusOf("Dokploy/other", "failure"),
				],
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
	});

	it("check runs of the GitHub App Dokploy acts as", () => {
		const decision = evaluateDeployGate(
			input({
				appSlug: "dokploy-community",
				checks: [
					pass("test"),
					running("Deploy", { appSlug: "dokploy-community" }),
				],
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
	});

	it("an expected name that is Dokploy's own is dropped from the set", () => {
		expect(
			evaluateDeployGate(
				input({
					expected: required("test", "dokploy/production"),
					checks: [pass("test")],
				}),
			),
		).toEqual({ state: "deploy" });
	});

	it("the predicate can be replaced", () => {
		const decision = evaluateDeployGate(
			input({
				checks: [pass("test"), running("flaky-nightly")],
				isExcluded: (c) => c.name === "flaky-nightly",
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
	});

	it("createDefaultExclusion covers prefix, app and run", () => {
		const exclude = createDefaultExclusion({
			appSlug: "me",
			excludedRunIds: [5],
		});
		const base = {
			name: "x",
			kind: "check-run" as const,
			appSlug: null,
			runId: null,
		};
		expect(exclude(base)).toBe(false);
		expect(exclude({ ...base, name: "dokploy/x" })).toBe(true);
		expect(exclude({ ...base, appSlug: "me" })).toBe(true);
		expect(exclude({ ...base, runId: 5 })).toBe(true);
		expect(exclude({ ...base, runId: 6 })).toBe(false);
	});
});

describe("workflows mode", () => {
	const wf = (overrides: Partial<DeployGateInput> = {}) =>
		input({ mode: "workflows", workflows: ["CI"], ...overrides });

	it("deploys when the named workflow passed on the commit", () => {
		expect(
			evaluateDeployGate(
				wf({ workflowRuns: [workflowRun("CI", "completed", "success")] }),
			),
		).toEqual({ state: "deploy" });
	});

	it("a .yml entry matches the workflow file only, any other entry the workflow name only", () => {
		const run = workflowRun("Continuous Integration", "completed", "success", {
			path: ".github/workflows/ci.yml",
		});
		for (const wanted of ["Continuous Integration", "ci.yml"]) {
			expect(
				evaluateDeployGate(wf({ workflows: [wanted], workflowRuns: [run] })),
				wanted,
			).toEqual({ state: "deploy" });
		}
		// A name entry does not match a file, and a file entry does not match a name.
		for (const wanted of ["ci", ".github/other.yml", "Continuous Integration.yml"]) {
			expect(
				evaluateDeployGate(wf({ workflows: [wanted], workflowRuns: [run] })).state,
				wanted,
			).toBe("waiting");
		}
		const named = workflowRun("ci.yml", "completed", "success", {
			path: ".github/workflows/other.yaml",
		});
		expect(
			evaluateDeployGate(wf({ workflows: ["ci.yml"], workflowRuns: [named] })).state,
		).toBe("waiting");
		expect(
			evaluateDeployGate(wf({ workflows: ["other.yaml"], workflowRuns: [named] })),
		).toEqual({ state: "deploy" });
	});

	it("waits while it runs and names it", () => {
		const decision = waiting(
			evaluateDeployGate(
				wf({ workflowRuns: [workflowRun("CI", "in_progress")] }),
			),
		);
		expect(decision.pendingNames).toEqual(["CI"]);
	});

	it("a workflow that has no run yet waits, then is blocked 'Workflow X never ran'", () => {
		const base = wf({
			workflows: ["CI", "Lint"],
			workflowRuns: [workflowRun("CI", "completed", "success")],
		});
		expect(waiting(evaluateDeployGate(base)).pendingNames).toEqual(["Lint"]);
		const late = blocked(
			evaluateDeployGate({ ...base, startedAt: NOW - 61 * MINUTE }),
		);
		expect(late.reason).toBe("Workflow Lint never ran");
		expect(late.neverReported).toEqual(["Lint"]);
	});

	it("a failing workflow blocks; a later passing re-run un-blocks", () => {
		const failed = workflowRun("CI", "completed", "failure", {
			id: 10,
			runAttempt: 1,
		});
		const rerun = workflowRun("CI", "completed", "success", {
			id: 10,
			runAttempt: 2,
		});
		const decision = blocked(evaluateDeployGate(wf({ workflowRuns: [failed] })));
		expect(decision.reason).toBe("Workflow CI failed");
		expect(evaluateDeployGate(wf({ workflowRuns: [rerun] }))).toEqual({
			state: "deploy",
		});
	});

	it("the latest run of the workflow wins when it ran twice on the commit", () => {
		const first = workflowRun("CI", "completed", "failure", { id: 20 });
		const second = workflowRun("CI", "completed", "success", { id: 21 });
		for (const order of [
			[first, second],
			[second, first],
		]) {
			expect(evaluateDeployGate(wf({ workflowRuns: order }))).toEqual({
				state: "deploy",
			});
		}
	});

	it("a pull request run of a workflow by that name does not satisfy the gate", () => {
		const fork = workflowRun("CI", "completed", "success", {
			event: "pull_request",
			headRepository: "evil/shop",
			headBranch: "main",
		});
		expect(evaluateDeployGate(wf({ workflowRuns: [fork] })).state).toBe(
			"waiting",
		);
		const real = workflowRun("CI", "completed", "failure", { id: 1 });
		expect(
			evaluateDeployGate(wf({ workflowRuns: [real, { ...fork, id: 2 }] })).state,
		).toBe("blocked");
	});

	it("two workflows with the same name must both pass", () => {
		const a = workflowRun("CI", "completed", "success", {
			path: ".github/workflows/a.yml",
		});
		const b = workflowRun("CI", "completed", "failure", {
			path: ".github/workflows/b.yml",
		});
		expect(evaluateDeployGate(wf({ workflowRuns: [a, b] })).state).toBe(
			"blocked",
		);
	});

	it("never waits for the release run or other runs of the release workflow", () => {
		const release = workflowRun("CI", "in_progress", null, { id: 99 });
		expect(
			evaluateDeployGate(
				wf({
					workflowRuns: [release, workflowRun("CI", "completed", "success")],
					excludedRunIds: [99],
				}),
			),
		).toEqual({ state: "deploy" });
		expect(
			evaluateDeployGate(wf({ workflowRuns: [release], excludedRunIds: [99] }))
				.state,
		).toBe("waiting");
	});

	it("needs every listed workflow", () => {
		const decision = waiting(
			evaluateDeployGate(
				wf({
					workflows: ["CI", "Security"],
					workflowRuns: [
						workflowRun("CI", "completed", "success"),
						workflowRun("Security", "queued"),
					],
				}),
			),
		);
		expect(decision.pendingNames).toEqual(["Security"]);
	});

	it("an empty list blocks with a reason; check runs are not looked at", () => {
		expect(
			blocked(evaluateDeployGate(wf({ workflows: [] }))).reason,
		).toBe("No workflow is chosen for the gate");
		expect(
			evaluateDeployGate(
				wf({
					checks: [fail("build")],
					workflowRuns: [workflowRun("CI", "completed", "success")],
				}),
			),
		).toEqual({ state: "deploy" });
	});
});

describe("greenCheckRunNames (the last green commit)", () => {
	const green = (over: Partial<Parameters<typeof greenCheckRunNames>[0]>) =>
		greenCheckRunNames({
			checks: [],
			workflowRuns: [],
			trust: TRUST,
			excludedRunIds: [],
			isExcluded: () => false,
			...over,
		});

	it("returns the sorted names when every check run that counts passed", () => {
		expect(green({ checks: [pass("test"), pass("build")] })).toEqual([
			"build",
			"test",
		]);
	});

	it("is null when something failed, is running, or there is nothing", () => {
		expect(green({ checks: [pass("a"), fail("b")] })).toBeNull();
		expect(green({ checks: [pass("a"), running("b")] })).toBeNull();
		expect(green({ checks: [] })).toBeNull();
	});

	it("is null when a workflow run of the commit failed or is still running", () => {
		const ci = workflowRun("CI", "completed", "success");
		expect(
			green({
				checks: [job(ci, "build", "completed", "success")],
				workflowRuns: [ci, workflowRun("Other", "completed", "failure")],
			}),
		).toBeNull();
		expect(
			green({
				checks: [job(ci, "build", "completed", "success")],
				workflowRuns: [ci, workflowRun("Other", "in_progress")],
			}),
		).toBeNull();
	});

	it("commit statuses are not part of the set, and a commit with only statuses is not green", () => {
		expect(green({ checks: [pass("a"), statusOf("ci/x", "failure")] })).toEqual([
			"a",
		]);
		expect(green({ checks: [statusOf("ci/x", "success")] })).toBeNull();
	});

	it("leaves out the release workflow of that commit, so its jobs are never required", () => {
		const release = workflowRun("Dokploy", "completed", "success", { id: 5 });
		const ci = workflowRun("CI", "completed", "success", { id: 6 });
		const excludedRunIds = [release.id];
		expect(
			green({
				checks: [
					job(ci, "test", "completed", "success"),
					job(release, "publish", "completed", "success"),
				],
				workflowRuns: [release, ci],
				excludedRunIds,
				isExcluded: createDefaultExclusion({ excludedRunIds }),
			}),
		).toEqual(["test"]);
	});

	it("ignores the checks of a run that does not count (a fork pull request)", () => {
		const fork = workflowRun("CI", "completed", "success", {
			event: "pull_request",
			headRepository: "evil/shop",
		});
		expect(
			green({
				checks: [job(fork, "build", "completed", "success")],
				workflowRuns: [fork],
			}),
		).toBeNull();
	});
});

describe("describeGateDecision", () => {
	it("words each state", () => {
		expect(describeGateDecision({ state: "deploy" })).toBe("CI passed");
		expect(describeGateDecision({ state: "deploy", overridden: true })).toBe(
			"Deployed without waiting for CI",
		);
		expect(
			describeGateDecision({ state: "waiting", reason: "x", pendingNames: [] }),
		).toBe("Waiting for CI");
		expect(
			describeGateDecision({
				state: "waiting",
				reason: "x",
				pendingNames: ["build", "test"],
			}),
		).toBe("Waiting for CI: build, test");
		expect(
			describeGateDecision({
				state: "waiting",
				reason: "x",
				pendingNames: ["a", "b", "c", "d", "e"],
			}),
		).toBe("Waiting for CI: a, b, c and 2 more");
		expect(
			describeGateDecision({
				state: "blocked",
				reason: "Check test failed",
				failedNames: ["test"],
				neverReported: [],
				unfinished: [],
			}),
		).toBe("Check test failed");
	});

	it("keeps GitHub's 140 characters", () => {
		const text = describeGateDecision({
			state: "blocked",
			reason: "x".repeat(300),
			failedNames: [],
			neverReported: [],
			unfinished: [],
		});
		expect(text).toHaveLength(140);
		expect(text.endsWith("…")).toBe(true);
	});
});
