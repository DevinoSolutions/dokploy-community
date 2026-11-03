import {
	createDefaultExclusion,
	type DeployGateInput,
	describeGateDecision,
	evaluateDeployGate,
	type GateCheck,
	type GateDecision,
	type GateWorkflowRun,
	greenCheckRunNames,
	latestChecksByName,
} from "@dokploy/server/services/gha-connect/deploy-gate";
import { describe, expect, it } from "vitest";

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-03T12:00:00Z");

let nextId = 1;
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
	id: nextId++,
	startedAt: null,
	appSlug: "github-actions",
	runId: null,
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
	id: nextId++,
	startedAt: null,
	appSlug: null,
	runId: null,
	...extra,
});

const workflowRun = (
	name: string,
	status: "queued" | "in_progress" | "completed",
	conclusion: string | null = null,
	extra: Partial<GateWorkflowRun> = {},
): GateWorkflowRun => ({
	id: nextId++,
	name,
	path: `.github/workflows/${name.toLowerCase().replace(/\s+/g, "-")}.yml`,
	runAttempt: 1,
	status,
	conclusion: status === "completed" ? (conclusion ?? "success") : null,
	startedAt: null,
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

	it("ignores checks that are not in the expected set", () => {
		const decision = evaluateDeployGate(
			input({
				expected: required("build"),
				checks: [pass("build"), fail("optional-lint"), running("nightly")],
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
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

describe("checks mode with the checks of the last green commit", () => {
	it("is evaluated like a required set", () => {
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

	it("a new check on this commit that the last green commit did not have is not waited for", () => {
		const decision = evaluateDeployGate(
			input({
				expected: lastGreen("build"),
				checks: [pass("build"), running("brand-new")],
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
	});
});

describe("the latest attempt per name decides", () => {
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
		// The order of the list does not matter.
		expect(
			evaluateDeployGate(
				input({ expected: required("test"), checks: [rerun, first] }),
			),
		).toEqual({ state: "deploy" });
	});

	it("a pass followed by a failing re-run blocks", () => {
		const decision = evaluateDeployGate(
			input({
				expected: required("test"),
				checks: [pass("test"), fail("test")],
			}),
		);
		expect(decision.state).toBe("blocked");
	});

	it("a failure followed by a re-run that is running waits", () => {
		const decision = evaluateDeployGate(
			input({
				expected: required("test"),
				checks: [fail("test"), running("test")],
			}),
		);
		expect(decision.state).toBe("waiting");
	});

	it("start time beats id when both attempts have one", () => {
		const older = fail("test", { id: 900, startedAt: "2026-11-03T11:00:00Z" });
		const newer = pass("test", { id: 100, startedAt: "2026-11-03T11:30:00Z" });
		expect(
			evaluateDeployGate(
				input({ expected: required("test"), checks: [older, newer] }),
			),
		).toEqual({ state: "deploy" });
	});

	it("falls back to the id when start times are missing or equal", () => {
		const same = "2026-11-03T11:00:00Z";
		const older = fail("test", { id: 5, startedAt: same });
		const newer = pass("test", { id: 6, startedAt: same });
		expect(
			evaluateDeployGate(
				input({ expected: required("test"), checks: [older, newer] }),
			),
		).toEqual({ state: "deploy" });
	});

	it("latestChecksByName keeps one per name, oldest first", () => {
		const a1 = pass("a", { id: 1 });
		const a2 = fail("a", { id: 4 });
		const b1 = pass("b", { id: 2 });
		const latest = latestChecksByName([a2, b1, a1], () => false);
		expect(latest.map((c) => [c.name, c.id])).toEqual([
			["b", 2],
			["a", 4],
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
				input({
					expected: required("a", "b"),
					startedAt: NOW - 90 * MINUTE,
				}),
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

	it("a queued check counts as not finished", () => {
		const decision = waiting(
			evaluateDeployGate(
				input({ checks: [pass("build"), check("test", "queued")] }),
			),
		);
		expect(decision.pendingNames).toEqual(["test"]);
	});

	it("a failing check blocks", () => {
		const decision = blocked(
			evaluateDeployGate(input({ checks: [pass("build"), fail("test")] })),
		);
		expect(decision.failedNames).toEqual(["test"]);
	});

	it("a repository with only commit statuses uses them", () => {
		expect(
			evaluateDeployGate(input({ checks: [statusOf("ci/travis", "pending")] }))
				.state,
		).toBe("waiting");
		expect(
			evaluateDeployGate(input({ checks: [statusOf("ci/travis", "success")] })),
		).toEqual({ state: "deploy" });
		const failed = blocked(
			evaluateDeployGate(input({ checks: [statusOf("ci/travis", "failure")] })),
		);
		expect(failed.failedNames).toEqual(["ci/travis"]);
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
		const decision = evaluateDeployGate(
			input({ expected: required("dokploy/deploy"), checks: [pass("build")] }),
		);
		expect(decision).toEqual({ state: "deploy" });
	});
});

describe("what the gate never waits for", () => {
	it("the release run: its checks do not block, wait or count", () => {
		const releaseJob = running("dokploy-release / publish", { runId: 777 });
		const failedReleaseJob = fail("build-and-push", { runId: 777 });
		expect(
			evaluateDeployGate(
				input({
					expected: required("test"),
					checks: [pass("test"), releaseJob, failedReleaseJob],
					excludedRunIds: [777],
				}),
			),
		).toEqual({ state: "deploy" });
		// The same checks from another run do count.
		expect(
			evaluateDeployGate(
				input({
					expected: required("test"),
					checks: [pass("test"), fail("build-and-push", { runId: 778 })],
					excludedRunIds: [777],
				}),
			).state,
		).toBe("deploy");
		expect(
			evaluateDeployGate(
				input({
					checks: [pass("test"), fail("build-and-push", { runId: 778 })],
					excludedRunIds: [777],
				}),
			).state,
		).toBe("blocked");
	});

	it("in the fallback only the release run's checks can be what is running", () => {
		const decision = evaluateDeployGate(
			input({
				checks: [pass("test"), running("publish", { runId: 777 })],
				excludedRunIds: [777],
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
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
		const decision = evaluateDeployGate(
			input({
				expected: required("test", "dokploy/production"),
				checks: [pass("test")],
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
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

	it("matches by workflow name, file name and file name without extension", () => {
		const run = workflowRun("Continuous Integration", "completed", "success", {
			path: ".github/workflows/ci.yml",
		});
		for (const wanted of ["Continuous Integration", "ci.yml", "ci"]) {
			expect(
				evaluateDeployGate(wf({ workflows: [wanted], workflowRuns: [run] })),
				wanted,
			).toEqual({ state: "deploy" });
		}
		expect(
			evaluateDeployGate(wf({ workflows: ["cd"], workflowRuns: [run] })).state,
		).toBe("waiting");
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
		const early = waiting(evaluateDeployGate(base));
		expect(early.pendingNames).toEqual(["Lint"]);
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
		const decision = blocked(
			evaluateDeployGate(wf({ workflowRuns: [failed] })),
		);
		expect(decision.failedNames).toEqual(["CI"]);
		expect(decision.reason).toBe("Workflow CI failed");
		expect(evaluateDeployGate(wf({ workflowRuns: [rerun] }))).toEqual({
			state: "deploy",
		});
	});

	it("the latest run wins when a workflow ran twice on the commit", () => {
		const first = workflowRun("CI", "completed", "failure", { id: 20 });
		const second = workflowRun("CI", "completed", "success", { id: 21 });
		expect(evaluateDeployGate(wf({ workflowRuns: [first, second] }))).toEqual({
			state: "deploy",
		});
		expect(evaluateDeployGate(wf({ workflowRuns: [second, first] }))).toEqual({
			state: "deploy",
		});
	});

	it("a re-run of the same run (higher attempt) replaces the earlier attempt", () => {
		const a1 = workflowRun("CI", "completed", "success", {
			id: 30,
			runAttempt: 1,
		});
		const a2 = workflowRun("CI", "in_progress", null, {
			id: 30,
			runAttempt: 2,
		});
		expect(evaluateDeployGate(wf({ workflowRuns: [a1, a2] })).state).toBe(
			"waiting",
		);
	});

	it("never waits for the release run or other runs of the release workflow", () => {
		const release = workflowRun("CI", "in_progress", null, { id: 99 });
		const decision = evaluateDeployGate(
			wf({
				workflowRuns: [release, workflowRun("CI", "completed", "success")],
				excludedRunIds: [99],
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
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

	it("an empty list blocks with a reason", () => {
		const decision = blocked(evaluateDeployGate(wf({ workflows: [] })));
		expect(decision.reason).toBe("No workflow is chosen for the gate");
	});

	it("does not look at check runs", () => {
		const decision = evaluateDeployGate(
			wf({
				checks: [fail("build")],
				workflowRuns: [workflowRun("CI", "completed", "success")],
			}),
		);
		expect(decision).toEqual({ state: "deploy" });
	});
});

describe("greenCheckRunNames (the last green commit)", () => {
	const keep = () => false;

	it("returns the sorted names when every latest check run passed", () => {
		expect(greenCheckRunNames([pass("test"), pass("build")], keep)).toEqual([
			"build",
			"test",
		]);
	});

	it("is null when something failed, is running, or there is nothing", () => {
		expect(greenCheckRunNames([pass("a"), fail("b")], keep)).toBeNull();
		expect(greenCheckRunNames([pass("a"), running("b")], keep)).toBeNull();
		expect(greenCheckRunNames([], keep)).toBeNull();
	});

	it("a failure that a re-run fixed still counts as green", () => {
		expect(greenCheckRunNames([fail("a"), pass("a")], keep)).toEqual(["a"]);
	});

	it("commit statuses are not part of the set, and a commit with only statuses is not green", () => {
		expect(
			greenCheckRunNames([pass("a"), statusOf("ci/x", "failure")], keep),
		).toEqual(["a"]);
		expect(greenCheckRunNames([statusOf("ci/x", "success")], keep)).toBeNull();
	});

	it("leaves out excluded checks (the release workflow of that commit)", () => {
		const exclude = createDefaultExclusion({ excludedRunIds: [5] });
		expect(
			greenCheckRunNames(
				[pass("test"), pass("publish", { runId: 5 })],
				exclude,
			),
		).toEqual(["test"]);
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
