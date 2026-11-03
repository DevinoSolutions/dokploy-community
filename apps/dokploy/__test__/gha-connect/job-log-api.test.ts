import {
	createActionsApi,
	downloadJobLog,
	listRunJobs,
} from "@dokploy/server/services/gha-connect/actions-api";
import { describe, expect, it } from "vitest";
import { routedFetch } from "./gha-helpers";

const NOW = 1_700_000_000_000;
const REPO = { owner: "DevinoSolutions", repo: "voicelabs" };
const SHA = "a".repeat(40);

const deps = (routes: Parameters<typeof routedFetch>[0]) => {
	const { fetch, calls } = routedFetch(routes);
	return { deps: { fetch, now: () => NOW }, calls };
};

describe("jobs and job logs (the second manifest source)", () => {
	const job = {
		id: 5001,
		run_id: 9876543210,
		run_attempt: 2,
		name: "release",
		status: "completed",
		conclusion: "success",
		head_sha: SHA,
		steps: [
			{ name: "Set up job" },
			{ name: "Run DevinoSolutions/dokploy-release@v1" },
		],
	};

	it("lists the jobs of one attempt with their step names", async () => {
		const { deps: d, calls } = deps([["/jobs?", { json: { jobs: [job] } }]]);
		const result = await listRunJobs(d, "t", REPO, 9876543210, 2);
		expect(calls[0]?.url).toBe(
			"https://api.github.com/repos/DevinoSolutions/voicelabs/actions/runs/9876543210/attempts/2/jobs?per_page=100",
		);
		expect(result).toMatchObject({
			kind: "ok",
			value: [
				{
					id: 5001,
					runId: 9876543210,
					attempt: 2,
					name: "release",
					status: "completed",
					conclusion: "success",
					headSha: SHA,
					stepNames: ["Set up job", "Run DevinoSolutions/dokploy-release@v1"],
				},
			],
		});
	});

	it("skips a job entry it cannot read and keeps nulls for missing run fields", async () => {
		const { deps: d } = deps([
			[
				"/jobs?",
				{
					json: {
						jobs: [{ nope: true }, { id: 7, name: "x", status: "queued" }],
					},
				},
			],
		]);
		expect(await listRunJobs(d, "t", REPO, 1, 1)).toMatchObject({
			kind: "ok",
			value: [
				{ id: 7, runId: null, attempt: null, headSha: null, stepNames: [] },
			],
		});
	});

	it("maps a failed jobs request like every other call", async () => {
		const { deps: d } = deps([["/jobs?", { status: 404 }]]);
		expect(await listRunJobs(d, "t", REPO, 1, 1)).toEqual({
			kind: "not-found",
		});
	});

	it("reads a job log as text from the redirect target", async () => {
		const bytes = new TextEncoder().encode("2026-11-03T12:00:00Z hello\n");
		const { deps: d, calls } = deps([["/jobs/5001/logs", { bytes }]]);
		expect(await downloadJobLog(d, "t", REPO, 5001, 1024)).toEqual({
			kind: "ok",
			value: "2026-11-03T12:00:00Z hello\n",
			etag: null,
		});
		expect(calls[0]?.url).toBe(
			"https://api.github.com/repos/DevinoSolutions/voicelabs/actions/jobs/5001/logs",
		);
	});

	it("refuses a log above the limit, by declared length and by actual length", async () => {
		const bytes = new Uint8Array(100);
		const declared = deps([
			["/logs", { bytes, headers: { "content-length": "100" } }],
		]);
		expect(await downloadJobLog(declared.deps, "t", REPO, 1, 50)).toEqual({
			kind: "error",
			status: 413,
		});
		const undeclared = deps([["/logs", { bytes }]]);
		expect(await downloadJobLog(undeclared.deps, "t", REPO, 1, 50)).toEqual({
			kind: "error",
			status: 413,
		});
	});

	it.each([
		[401, { kind: "unauthorized" }],
		[404, { kind: "not-found" }],
		[410, { kind: "not-found" }],
		[500, { kind: "error", status: 500 }],
	])("maps HTTP %s of a log request", async (status, expected) => {
		const { deps: d } = deps([["/logs", { status }]]);
		expect(await downloadJobLog(d, "t", REPO, 1, 50)).toEqual(expected);
	});

	it("tells a rate limit from a refusal on a log request", async () => {
		const limited = deps([
			[
				"/logs",
				{ status: 403, headers: { "retry-after": "30" }, text: "rate limit" },
			],
		]);
		expect(await downloadJobLog(limited.deps, "t", REPO, 1, 50)).toEqual({
			kind: "rate-limited",
			retryAt: NOW + 30_000,
		});
		const refused = deps([["/logs", { status: 403, text: "no" }]]);
		expect(await downloadJobLog(refused.deps, "t", REPO, 1, 50)).toMatchObject({
			kind: "forbidden",
		});
	});

	it("reports a network failure as status 0", async () => {
		const d = {
			fetch: async () => {
				throw new Error("offline");
			},
			now: () => NOW,
		};
		expect(await downloadJobLog(d, "t", REPO, 1, 50)).toEqual({
			kind: "error",
			status: 0,
		});
	});

	it("refuses a job id that is not a positive integer without calling GitHub", async () => {
		const { deps: d, calls } = deps([["/", {}]]);
		expect(await downloadJobLog(d, "t", REPO, 0, 50)).toEqual({
			kind: "not-found",
		});
		expect(await downloadJobLog(d, "t", REPO, 1.5, 50)).toEqual({
			kind: "not-found",
		});
		expect(calls).toHaveLength(0);
	});

	it("is part of the bound api", async () => {
		const { deps: d, calls } = deps([
			["/jobs?", { json: { jobs: [] } }],
			["/logs", { bytes: new Uint8Array() }],
		]);
		const api = createActionsApi(d, "gho_x", REPO);
		await api.runJobs(5, 1);
		await api.jobLog(9, 10);
		expect(
			calls.map((c) => c.url.split("/repos/DevinoSolutions/voicelabs/")[1]),
		).toEqual([
			"actions/runs/5/attempts/1/jobs?per_page=100",
			"actions/jobs/9/logs",
		]);
	});
});
