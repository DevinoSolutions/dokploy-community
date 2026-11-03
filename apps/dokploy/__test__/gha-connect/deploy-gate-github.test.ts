import type { ApiDeps } from "@dokploy/server/services/gha-connect/actions-api";
import {
	createGateGithub,
	loadCommitChecks,
	loadExpectedCheckSet,
	loadRecentCommits,
	loadRequiredChecks,
	loadWorkflowRuns,
	namesFromProtection,
	namesFromRules,
	releaseWorkflowRunIds,
} from "@dokploy/server/services/gha-connect/deploy-gate-github";
import { describe, expect, it } from "vitest";
import { type Recorded, type Reply, routedFetch } from "./gha-helpers";

const REF = { owner: "acme", repo: "shop" };
const TOKEN = "gho_secret";
const SHA = "a".repeat(40);
const PREV = "b".repeat(40);
const OLDER = "c".repeat(40);
const WORKFLOW = ".github/workflows/dokploy.yml";

const deps = (routes: Array<[string, Reply | ((call: Recorded) => Reply)]>) => {
	const { fetch, calls } = routedFetch(routes);
	const apiDeps: ApiDeps = { fetch, now: () => 1_000 };
	return { apiDeps, calls };
};

const checkRun = (
	id: number,
	name: string,
	status: string,
	conclusion: string | null,
	extra: Record<string, unknown> = {},
) => ({
	id,
	name,
	status,
	conclusion,
	started_at: "2026-11-03T11:00:00Z",
	app: { slug: "github-actions" },
	details_url: `https://github.com/acme/shop/actions/runs/${1000 + id}/job/${id}`,
	...extra,
});

const checkRuns = (...runs: Array<ReturnType<typeof checkRun>>) => ({
	total_count: runs.length,
	check_runs: runs,
});

const runListing = (
	...runs: Array<{ id: number; name: string; path: string }>
) => ({
	total_count: runs.length,
	workflow_runs: runs.map((run) => ({
		...run,
		status: "completed",
		conclusion: "success",
		run_attempt: 1,
		run_started_at: "2026-11-03T11:00:00Z",
	})),
});

const noStatuses = { total_count: 0, state: "pending", statuses: [] };

describe("required checks of the branch", () => {
	it("reads branch protection contexts and checks", () => {
		expect(
			namesFromProtection({
				protection: {
					required_status_checks: {
						contexts: ["build"],
						checks: [{ context: "build", app_id: 1 }, { context: "lint" }],
					},
				},
			}),
		).toEqual(["build", "build", "lint"]);
		expect(namesFromProtection({ protected: false })).toEqual([]);
		expect(namesFromProtection(null)).toEqual([]);
	});

	it("reads required_status_checks rules of a ruleset and ignores the others", () => {
		expect(
			namesFromRules([
				{ type: "pull_request", parameters: {} },
				{
					type: "required_status_checks",
					parameters: {
						required_status_checks: [{ context: "ci" }, { context: "e2e" }],
					},
				},
			]),
		).toEqual(["ci", "e2e"]);
		expect(namesFromRules({ message: "no" })).toEqual([]);
	});

	it("unions protection and ruleset, deduplicated", async () => {
		const { apiDeps } = deps([
			[
				"/rules/branches/main",
				{
					json: [
						{
							type: "required_status_checks",
							parameters: {
								required_status_checks: [
									{ context: "e2e" },
									{ context: "build" },
								],
							},
						},
					],
				},
			],
			[
				"/branches/main",
				{
					json: {
						protection: { required_status_checks: { contexts: ["build"] } },
					},
				},
			],
		]);
		const read = await loadRequiredChecks(apiDeps, TOKEN, REF, "main");
		expect(read.readable).toBe(true);
		expect(read.names.sort()).toEqual(["build", "e2e"]);
	});

	it("a 403 on both is 'unreadable', not an error", async () => {
		const { apiDeps } = deps([
			["/rules/branches/main", { status: 404 }],
			["/branches/main", { status: 403 }],
		]);
		expect(await loadRequiredChecks(apiDeps, TOKEN, REF, "main")).toEqual({
			names: [],
			readable: false,
		});
	});

	it("encodes a branch with a slash segment by segment", async () => {
		const { apiDeps, calls } = deps([
			["/rules/branches/", { json: [] }],
			["/branches/", { json: {} }],
		]);
		await loadRequiredChecks(apiDeps, TOKEN, REF, "release/2026 11");
		expect(calls.map((c) => c.url)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("/branches/release/2026%2011"),
				expect.stringContaining("/rules/branches/release/2026%2011"),
			]),
		);
	});
});

describe("commit checks", () => {
	it("merges check runs and commit statuses into one list, with the run behind each check", async () => {
		const { apiDeps } = deps([
			[
				`/commits/${SHA}/check-runs`,
				{
					json: checkRuns(
						checkRun(1, "build", "completed", "success"),
						checkRun(2, "test", "in_progress", null),
					),
				},
			],
			[
				`/commits/${SHA}/status`,
				{
					json: {
						total_count: 2,
						statuses: [
							{
								id: 50,
								context: "ci/legacy",
								state: "success",
								updated_at: "2026-11-03T11:05:00Z",
							},
							{
								id: 51,
								context: "ci/other",
								state: "error",
								updated_at: "2026-11-03T11:06:00Z",
							},
							{
								id: 52,
								context: "ci/queued",
								state: "pending",
								updated_at: "2026-11-03T11:06:00Z",
							},
						],
					},
				},
			],
		]);
		const read = await loadCommitChecks(apiDeps, TOKEN, REF, SHA);
		expect(read.kind).toBe("ok");
		if (read.kind !== "ok") return;
		expect(
			read.value.map((c) => [c.name, c.kind, c.status, c.conclusion]),
		).toEqual([
			["build", "check-run", "completed", "success"],
			["test", "check-run", "in_progress", null],
			["ci/legacy", "status", "completed", "success"],
			["ci/other", "status", "completed", "failure"],
			["ci/queued", "status", "in_progress", null],
		]);
		expect(read.value[0]).toMatchObject({
			runId: 1001,
			appSlug: "github-actions",
			id: 1,
		});
	});

	it("a repository with only commit statuses has zero check runs and still reads", async () => {
		const { apiDeps } = deps([
			[
				`/commits/${SHA}/check-runs`,
				{ json: { total_count: 0, check_runs: [] } },
			],
			[
				`/commits/${SHA}/status`,
				{
					json: {
						statuses: [{ id: 1, context: "ci/travis", state: "success" }],
					},
				},
			],
		]);
		const read = await loadCommitChecks(apiDeps, TOKEN, REF, SHA);
		expect(read).toMatchObject({ kind: "ok" });
		if (read.kind === "ok") expect(read.value).toHaveLength(1);
	});

	it("a token that cannot read statuses still gets the check runs", async () => {
		const { apiDeps } = deps([
			[
				`/commits/${SHA}/check-runs`,
				{ json: checkRuns(checkRun(1, "build", "completed", "success")) },
			],
			[`/commits/${SHA}/status`, { status: 403 }],
		]);
		const read = await loadCommitChecks(apiDeps, TOKEN, REF, SHA);
		expect(read.kind === "ok" && read.value).toHaveLength(1);
	});

	it("a check run read that fails is a failure, never an empty list", async () => {
		const { apiDeps } = deps([
			[`/commits/${SHA}/check-runs`, { status: 500 }],
			[`/commits/${SHA}/status`, { json: noStatuses }],
		]);
		const read = await loadCommitChecks(apiDeps, TOKEN, REF, SHA);
		expect(read).toEqual({
			kind: "failed",
			failure: { kind: "error", status: 500 },
		});
	});

	it("pages through check runs until it has them all", async () => {
		const page1 = Array.from({ length: 100 }, (_, i) =>
			checkRun(i + 1, `job-${i}`, "completed", "success"),
		);
		const page2 = [checkRun(500, "last", "completed", "success")];
		const { apiDeps, calls } = deps([
			[
				"/check-runs?",
				(call) =>
					call.url.includes("page=2")
						? { json: { total_count: 101, check_runs: page2 } }
						: { json: { total_count: 101, check_runs: page1 } },
			],
			["/status", { json: noStatuses }],
		]);
		const read = await loadCommitChecks(apiDeps, TOKEN, REF, SHA);
		expect(read.kind === "ok" && read.value).toHaveLength(101);
		expect(calls.filter((c) => c.url.includes("/check-runs?"))).toHaveLength(2);
	});

	it("refuses a ref that is not a commit id", async () => {
		const { apiDeps, calls } = deps([]);
		expect(
			(await loadCommitChecks(apiDeps, TOKEN, REF, "main/../x")).kind,
		).toBe("failed");
		expect(calls).toHaveLength(0);
	});

	it("sends the token only as the Authorization header", async () => {
		const { apiDeps, calls } = deps([
			["/check-runs", { json: checkRuns() }],
			["/status", { json: noStatuses }],
		]);
		await loadCommitChecks(apiDeps, TOKEN, REF, SHA);
		for (const call of calls) {
			expect(call.url).not.toContain(TOKEN);
			expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
		}
	});
});

describe("workflow runs of a commit", () => {
	it("reads name, path, attempt and state of each run", async () => {
		const { apiDeps, calls } = deps([
			[
				"/actions/runs?",
				{
					json: {
						total_count: 1,
						workflow_runs: [
							{
								id: 9,
								name: "CI",
								path: ".github/workflows/ci.yml@refs/heads/main",
								run_attempt: 2,
								status: "completed",
								conclusion: "failure",
								run_started_at: "2026-11-03T11:00:00Z",
							},
						],
					},
				},
			],
		]);
		const read = await loadWorkflowRuns(apiDeps, TOKEN, REF, SHA);
		expect(calls[0]?.url).toContain(`head_sha=${SHA}`);
		expect(read).toEqual({
			kind: "ok",
			value: [
				{
					id: 9,
					name: "CI",
					path: ".github/workflows/ci.yml",
					runAttempt: 2,
					status: "completed",
					conclusion: "failure",
					startedAt: "2026-11-03T11:00:00Z",
				},
			],
		});
	});

	it("releaseWorkflowRunIds picks the runs of the release workflow file", () => {
		expect(
			releaseWorkflowRunIds(
				[
					{
						id: 1,
						name: "Dokploy",
						path: WORKFLOW,
						runAttempt: 1,
						status: "completed",
						conclusion: "success",
						startedAt: null,
					},
					{
						id: 2,
						name: "CI",
						path: ".github/workflows/ci.yml",
						runAttempt: 1,
						status: "completed",
						conclusion: "success",
						startedAt: null,
					},
				],
				WORKFLOW,
			),
		).toEqual([1]);
	});
});

describe("the expected check set", () => {
	const input = { branch: "main", sha: SHA, workflowPath: WORKFLOW };

	it("403 on protection falls to the ruleset", async () => {
		const { apiDeps } = deps([
			[
				"/rules/branches/main",
				{
					json: [
						{
							type: "required_status_checks",
							parameters: { required_status_checks: [{ context: "ci" }] },
						},
					],
				},
			],
			["/branches/main", { status: 403 }],
		]);
		expect(await loadExpectedCheckSet(apiDeps, TOKEN, REF, input)).toEqual({
			kind: "ok",
			value: { source: "required", names: ["ci"] },
		});
	});

	it("403 on protection and ruleset falls to the last green commit among the last ten", async () => {
		const { apiDeps, calls } = deps([
			["/rules/branches/main", { status: 404 }],
			["/branches/main", { status: 403 }],
			[
				"/commits?sha=main",
				{ json: [{ sha: SHA }, { sha: PREV }, { sha: OLDER }] },
			],
			// The commit being released is never a candidate; PREV has a red check; OLDER is green.
			[
				`/commits/${PREV}/check-runs`,
				{
					json: checkRuns(
						checkRun(1, "build", "completed", "success"),
						checkRun(2, "test", "completed", "failure"),
					),
				},
			],
			[
				`/commits/${OLDER}/check-runs`,
				{
					json: checkRuns(
						checkRun(3, "build", "completed", "success"),
						checkRun(4, "test", "completed", "success"),
						// The release workflow of that commit: its jobs are not part of "all checks".
						checkRun(5, "publish", "completed", "success", {
							details_url:
								"https://github.com/acme/shop/actions/runs/4242/job/5",
						}),
					),
				},
			],
			[`/commits/${PREV}/status`, { json: noStatuses }],
			[`/commits/${OLDER}/status`, { json: noStatuses }],
			[
				`/actions/runs?head_sha=${OLDER}`,
				{ json: runListing({ id: 4242, name: "Dokploy", path: WORKFLOW }) },
			],
			[`/actions/runs?head_sha=${PREV}`, { json: runListing() }],
		]);
		const set = await loadExpectedCheckSet(apiDeps, TOKEN, REF, input);
		expect(set).toEqual({
			kind: "ok",
			value: { source: "last-green", names: ["build", "test"] },
		});
		expect(calls.some((c) => c.url.includes(`/commits/${SHA}/`))).toBe(false);
	});

	it("no green commit among the last ten (or no check runs at all) is the fallback", async () => {
		const { apiDeps } = deps([
			["/rules/branches/main", { status: 404 }],
			["/branches/main", { status: 404 }],
			["/commits?sha=main", { json: [{ sha: SHA }, { sha: PREV }] }],
			[
				`/commits/${PREV}/check-runs`,
				{ json: { total_count: 0, check_runs: [] } },
			],
			[
				`/commits/${PREV}/status`,
				{
					json: {
						statuses: [{ id: 1, context: "ci/travis", state: "success" }],
					},
				},
			],
			["/actions/runs?", { json: runListing() }],
		]);
		expect(await loadExpectedCheckSet(apiDeps, TOKEN, REF, input)).toEqual({
			kind: "ok",
			value: { source: "fallback", names: [] },
		});
	});

	it("required checks that are only Dokploy's own do not count", async () => {
		const { apiDeps } = deps([
			["/rules/branches/main", { json: [] }],
			[
				"/branches/main",
				{
					json: {
						protection: {
							required_status_checks: { contexts: ["dokploy/production"] },
						},
					},
				},
			],
			["/commits?sha=main", { json: [{ sha: SHA }] }],
		]);
		expect(await loadExpectedCheckSet(apiDeps, TOKEN, REF, input)).toEqual({
			kind: "ok",
			value: { source: "fallback", names: [] },
		});
	});

	it("a rate limit while looking at history is a failure to retry, not a fallback", async () => {
		const { apiDeps } = deps([
			["/rules/branches/main", { status: 404 }],
			["/branches/main", { status: 404 }],
			["/commits?sha=main", { json: [{ sha: PREV }] }],
			[
				`/commits/${PREV}/check-runs`,
				{
					status: 403,
					text: "rate limit exceeded",
					headers: {
						"x-ratelimit-remaining": "0",
						"x-ratelimit-reset": "2000",
					},
				},
			],
			[`/commits/${PREV}/status`, { json: noStatuses }],
			["/actions/runs?", { json: runListing() }],
		]);
		const set = await loadExpectedCheckSet(apiDeps, TOKEN, REF, input);
		expect(set.kind).toBe("failed");
	});

	it("an unlistable branch has no history: fallback", async () => {
		const { apiDeps } = deps([
			["/rules/branches/main", { status: 404 }],
			["/branches/main", { status: 404 }],
			["/commits?sha=main", { status: 404 }],
		]);
		const set = await loadExpectedCheckSet(apiDeps, TOKEN, REF, input);
		expect(set).toEqual({
			kind: "ok",
			value: { source: "fallback", names: [] },
		});
	});
});

describe("loadRecentCommits and createGateGithub", () => {
	it("lists the shas of the branch newest first", async () => {
		const { apiDeps, calls } = deps([
			["/commits?sha=dev", { json: [{ sha: SHA }, { sha: PREV }] }],
		]);
		expect(await loadRecentCommits(apiDeps, TOKEN, REF, "dev", 10)).toEqual({
			kind: "ok",
			value: [SHA, PREV],
		});
		expect(calls[0]?.url).toContain("per_page=10");
	});

	it("binds the reads to one repository and token", async () => {
		const { apiDeps, calls } = deps([
			["/check-runs", { json: checkRuns() }],
			["/status", { json: noStatuses }],
			["/actions/runs?", { json: runListing() }],
		]);
		const github = createGateGithub(apiDeps, TOKEN, REF);
		await github.loadCommitChecks(SHA);
		await github.loadWorkflowRuns(SHA);
		expect(calls.every((c) => c.url.includes("/repos/acme/shop/"))).toBe(true);
	});
});
