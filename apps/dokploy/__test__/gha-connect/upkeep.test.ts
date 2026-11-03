import type {
	ApiResult,
	RepositoryInfo,
	RunInfo,
} from "@dokploy/server/services/gha-connect/actions-api";
import {
	runUpkeep,
	type UpkeepInput,
	type UpkeepReads,
} from "@dokploy/server/services/gha-connect/upkeep";
import { describe, expect, it } from "vitest";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const A = "a".repeat(40);
const B = "b".repeat(40);

const ok = <T>(value: T): ApiResult<T> => ({ kind: "ok", value, etag: null });

const repo = (fullName = "acme/shop"): RepositoryInfo => ({
	id: 7,
	owner: "acme",
	name: "shop",
	fullName,
	defaultBranch: "main",
	isPrivate: false,
});

const run = (over: Partial<RunInfo> = {}): RunInfo => ({
	id: 100,
	attempt: 1,
	path: ".github/workflows/dokploy.yml",
	headBranch: "main",
	headSha: B,
	event: "push",
	status: "completed",
	conclusion: "success",
	repositoryId: 7,
	headRepositoryId: 7,
	htmlUrl: "https://github.com/acme/shop/actions/runs/100",
	runStartedAt: "2026-11-03T10:00:00Z",
	updatedAt: "2026-11-03T10:05:00Z",
	...over,
});

const input = (over: Partial<UpkeepInput> = {}): UpkeepInput => ({
	now: NOW,
	state: "connected",
	repoId: 7,
	repoFullName: "acme/shop",
	trackedBranch: "main",
	workflowPath: ".github/workflows/dokploy.yml",
	deployedSha: A,
	...over,
});

const reads = (over: Partial<UpkeepReads> = {}): UpkeepReads => ({
	repository: async () => ok(repo()),
	branchHead: async () => ok({ sha: B }),
	workflowRuns: async () => ok([run()]),
	compare: async () => ok("ahead"),
	workflowFile: async () => ok("name: dokploy"),
	...over,
});

describe("runUpkeep", () => {
	it("reports a rename without touching the state", async () => {
		const result = await runUpkeep(
			input(),
			reads({ repository: async () => ok(repo("acme/shop-v2")) }),
		);
		expect(result.renamedTo).toBe("acme/shop-v2");
		expect(result.complete).toBe(true);
	});

	it("goes stale when a finished run for the head published nothing within the tolerance", async () => {
		const result = await runUpkeep(input(), reads());
		expect(result.events).toEqual([
			{
				type: "stale",
				reason: "GitHub Actions has not published commit bbbbbbb.",
			},
		]);
	});

	it("is not stale when the head is the deployed commit", async () => {
		const result = await runUpkeep(
			input({ deployedSha: B }),
			reads({ compare: async () => ok("identical") }),
		);
		expect(result.events).toEqual([]);
	});

	it("is not stale when no run exists for the head (a push that triggered nothing)", async () => {
		const result = await runUpkeep(
			input(),
			reads({ workflowRuns: async () => ok([run({ headSha: A })]) }),
		);
		expect(result.events).toEqual([]);
	});

	it("returns to fresh from stale once the head is the deployed commit", async () => {
		const result = await runUpkeep(
			input({ state: "stale", deployedSha: B }),
			reads({ compare: async () => ok("identical") }),
		);
		expect(result.events).toEqual([{ type: "fresh", hasRelease: true }]);
	});

	it("treats a deployed commit that left the branch as stale", async () => {
		const result = await runUpkeep(
			input(),
			reads({ compare: async () => ok("diverged") }),
		);
		expect(result.events).toEqual([
			{
				type: "stale",
				reason: "The deployed commit is no longer on the branch.",
			},
		]);
	});

	it("treats a deleted branch as stale", async () => {
		const result = await runUpkeep(
			input(),
			reads({ branchHead: async () => ({ kind: "not-found" }) }),
		);
		expect(result.events[0]).toEqual({
			type: "stale",
			reason: "Branch main was deleted or renamed.",
		});
	});

	it("treats a removed workflow file as stale", async () => {
		const result = await runUpkeep(
			input(),
			reads({ workflowFile: async () => ({ kind: "not-found" }) }),
		);
		expect(result.events[0]).toEqual({
			type: "stale",
			reason: "dokploy.yml was removed from main.",
		});
	});

	it("says a run queued for too long has no runner", async () => {
		const queued = run({
			id: 101,
			status: "queued",
			conclusion: null,
			runStartedAt: "2026-11-03T11:00:00Z",
			updatedAt: "2026-11-03T11:00:00Z",
		});
		const result = await runUpkeep(
			input(),
			reads({ workflowRuns: async () => ok([queued]) }),
		);
		expect(result.events).toEqual([
			{ type: "stale", reason: "Queued for 60 minutes, is a runner online?" },
		]);
		expect(result.liveRuns.map((r) => r.id)).toEqual([101]);
	});

	it("lists only same-repository push or dispatch runs of the tracked branch as live", async () => {
		const running = (over: Partial<RunInfo>) =>
			run({ status: "in_progress", conclusion: null, ...over });
		const result = await runUpkeep(
			input({ state: "waiting", deployedSha: null }),
			reads({
				workflowRuns: async () =>
					ok([
						running({ id: 1 }),
						running({ id: 2, event: "pull_request" }),
						running({ id: 3, headBranch: "feature" }),
						running({ id: 4, headRepositoryId: 99 }),
						running({ id: 5, event: "workflow_dispatch" }),
					]),
			}),
		);
		expect(result.liveRuns.map((r) => r.id)).toEqual([1, 5]);
		expect(result.newestRunId).toBe(5);
	});

	it("asks again later, and never reports stale, when GitHub could not be read", async () => {
		const result = await runUpkeep(
			input(),
			reads({ workflowRuns: async () => ({ kind: "error", status: 502 }) }),
		);
		expect(result.complete).toBe(false);
		expect(result.events).toEqual([]);
	});

	it("reports a missing repository only for a watched state", async () => {
		const gone = reads({ repository: async () => ({ kind: "not-found" }) });
		expect((await runUpkeep(input(), gone)).events).toHaveLength(1);
		expect((await runUpkeep(input({ state: "blocked" }), gone)).events).toEqual(
			[],
		);
	});

	it("does nothing for a state that is not watched", async () => {
		const result = await runUpkeep(input({ state: "blocked" }), reads());
		expect(result.events).toEqual([]);
		expect(result.complete).toBe(true);
	});
});
