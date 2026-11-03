import http from "node:http";
import type { AddressInfo } from "node:net";
import {
	type ApiFetch,
	createActionsApi,
	downloadArtifactZip,
	downloadJobLog,
	listRunJobs,
	readCapped,
} from "@dokploy/server/services/gha-connect/actions-api";
import { afterEach, describe, expect, it } from "vitest";
import { routedFetch } from "./gha-helpers";

const NOW = 1_700_000_000_000;
const REPO = { owner: "DevinoSolutions", repo: "voicelabs" };
const SHA = "a".repeat(40);

const deps = (routes: Parameters<typeof routedFetch>[0]) => {
	const { fetch, calls } = routedFetch(routes);
	return { deps: { fetch, now: () => NOW }, calls };
};

describe("jobs (the second manifest source)", () => {
	const job = {
		id: 5001,
		run_id: 9876543210,
		run_attempt: 2,
		name: "release",
		status: "completed",
		conclusion: "success",
		head_sha: SHA,
		runner_name: "GitHub Actions 7",
		steps: [
			{ name: "Set up job" },
			{ name: "Run DevinoSolutions/dokploy-release@v1" },
		],
	};

	it("lists the jobs of one attempt with their runner and step names", async () => {
		const { deps: d, calls } = deps([["/jobs?", { json: { jobs: [job] } }]]);
		const result = await listRunJobs(d, "t", REPO, 9876543210, 2);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://api.github.com/repos/DevinoSolutions/voicelabs/actions/runs/9876543210/attempts/2/jobs?per_page=100&page=1",
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
					runnerName: "GitHub Actions 7",
					stepNames: ["Set up job", "Run DevinoSolutions/dokploy-release@v1"],
				},
			],
		});
	});

	it("skips a job entry it cannot read and keeps nulls for missing fields", async () => {
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
				{
					id: 7,
					runId: null,
					attempt: null,
					headSha: null,
					runnerName: null,
					stepNames: [],
				},
			],
		});
	});

	it("follows every page of a large run, 100 per page", async () => {
		const page = (n: number, count: number) => ({
			json: {
				total_count: 203,
				jobs: Array.from({ length: count }, (_, i) => ({
					id: n * 1000 + i,
					name: `j${n}-${i}`,
					status: "completed",
				})),
			},
		});
		const { deps: d, calls } = deps([
			["&page=1", page(1, 100)],
			["&page=2", page(2, 100)],
			["&page=3", page(3, 3)],
		]);
		const result = await listRunJobs(d, "t", REPO, 5, 1);
		expect(result.kind === "ok" && result.value).toHaveLength(203);
		expect(calls.map((c) => c.url.split("&page=")[1])).toEqual(["1", "2", "3"]);
	});

	it("stops after ten pages (1000 jobs), however long the run goes on", async () => {
		const full = {
			json: {
				jobs: Array.from({ length: 100 }, (_, i) => ({
					id: i + 1,
					name: "j",
					status: "completed",
				})),
			},
		};
		const { deps: d, calls } = deps([["/jobs?", full]]);
		const result = await listRunJobs(d, "t", REPO, 5, 1);
		expect(calls).toHaveLength(10);
		expect(result.kind === "ok" && result.value).toHaveLength(1000);
	});

	it("fails the whole listing when one page cannot be read", async () => {
		const { deps: d } = deps([
			[
				"&page=1",
				{
					json: {
						jobs: Array.from({ length: 100 }, (_, i) => ({
							id: i + 1,
							name: "j",
							status: "completed",
						})),
					},
				},
			],
			["&page=2", { status: 502 }],
		]);
		expect(await listRunJobs(d, "t", REPO, 5, 1)).toEqual({
			kind: "error",
			status: 502,
		});
	});

	it("maps a failed jobs request like every other call", async () => {
		const { deps: d } = deps([["/jobs?", { status: 404 }]]);
		expect(await listRunJobs(d, "t", REPO, 1, 1)).toEqual({
			kind: "not-found",
		});
	});
});

describe("job logs", () => {
	it("reads a job log as text", async () => {
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
			"actions/runs/5/attempts/1/jobs?per_page=100&page=1",
			"actions/jobs/9/logs",
		]);
	});
});

/** A response whose body is a stream the test can watch. */
const streamed = (
	chunks: () => Uint8Array | null,
	log: { cancelled: boolean; reads: number },
) => {
	const reader = {
		read: async () => {
			log.reads += 1;
			const value = chunks();
			return value ? { done: false, value } : { done: true };
		},
		cancel: async () => {
			log.cancelled = true;
		},
	};
	return {
		ok: true,
		status: 200,
		headers: { get: () => null },
		json: async () => null,
		text: async () => "",
		body: { getReader: () => reader },
	};
};

describe("downloads stop at their byte cap", () => {
	it("cancels a stream the moment it passes the cap, instead of reading it all", async () => {
		const log = { cancelled: false, reads: 0 };
		const fetch: ApiFetch = async () => streamed(() => new Uint8Array(40), log); // never ends
		const result = await downloadJobLog(
			{ fetch, now: () => NOW },
			"t",
			REPO,
			1,
			100,
		);
		expect(result).toEqual({ kind: "error", status: 413 });
		expect(log.cancelled).toBe(true);
		expect(log.reads).toBe(3);
	});

	it("does the same for the artifact download", async () => {
		const log = { cancelled: false, reads: 0 };
		const fetch: ApiFetch = async () => streamed(() => new Uint8Array(40), log);
		const result = await downloadArtifactZip(
			{ fetch, now: () => NOW },
			"t",
			REPO,
			7,
			100,
		);
		expect(result).toEqual({ kind: "error", status: 413 });
		expect(log.cancelled).toBe(true);
	});

	it("joins the chunks of a stream that ends within the cap", async () => {
		const log = { cancelled: false, reads: 0 };
		const parts = [
			new TextEncoder().encode("ab"),
			new TextEncoder().encode("cd"),
		];
		const fetch: ApiFetch = async () =>
			streamed(() => parts.shift() ?? null, log);
		expect(
			await downloadJobLog({ fetch, now: () => NOW }, "t", REPO, 1, 100),
		).toEqual({
			kind: "ok",
			value: "abcd",
			etag: null,
		});
		expect(log.cancelled).toBe(false);
	});

	it("refuses a declared length above the cap before reading anything", async () => {
		const log = { cancelled: false, reads: 0 };
		const response = {
			...streamed(() => new Uint8Array(1), log),
			headers: { get: (n: string) => (n === "content-length" ? "999" : null) },
		};
		expect(await readCapped(response, 100)).toBeNull();
		expect(log.reads).toBe(0);
	});

	it("reports a stream that breaks as a network failure", async () => {
		const fetch: ApiFetch = async () => ({
			...streamed(() => null, { cancelled: false, reads: 0 }),
			body: {
				getReader: () => ({
					read: async () => {
						throw new Error("reset");
					},
					cancel: async () => undefined,
				}),
			},
		});
		expect(
			await downloadJobLog({ fetch, now: () => NOW }, "t", REPO, 1, 100),
		).toEqual({
			kind: "error",
			status: 0,
		});
	});
});

describe("the redirect to the signed blob URL (a real one)", () => {
	const servers: http.Server[] = [];
	afterEach(async () => {
		await Promise.all(
			servers.splice(0).map(
				(server) =>
					new Promise<void>((resolve) => {
						server.closeAllConnections();
						server.close(() => resolve());
					}),
			),
		);
	});

	const listen = (handler: http.RequestListener) =>
		new Promise<number>((resolve) => {
			const server = http.createServer(handler);
			servers.push(server);
			server.listen(0, "127.0.0.1", () =>
				resolve((server.address() as AddressInfo).port),
			);
		});

	/** GitHub (302 to the blob) and the blob store are two origins: two ports. */
	const github = async (blob: Buffer) => {
		const seen = {
			api: [] as string[],
			blobAuthorization: undefined as string | undefined | null,
		};
		const blobPort = await listen((req, res) => {
			seen.blobAuthorization = req.headers.authorization ?? null;
			res.writeHead(200, { "content-length": blob.length });
			res.end(blob);
		});
		const apiPort = await listen((req, res) => {
			seen.api.push(`${req.url ?? ""}|${req.headers.authorization ?? ""}`);
			res.writeHead(302, { location: `http://127.0.0.1:${blobPort}/blob` });
			res.end();
		});
		// Real fetch, with the one thing a test cannot reach rewritten: api.github.com is this server.
		const fetch: ApiFetch = (url, init) =>
			globalThis.fetch(
				url.replace("https://api.github.com", `http://127.0.0.1:${apiPort}`),
				{
					...(init as RequestInit),
					redirect: "follow",
				},
			) as unknown as ReturnType<ApiFetch>;
		return { seen, deps: { fetch, now: () => NOW } };
	};

	it("follows the 302 for a job log and sends the token to GitHub only, not to the blob store", async () => {
		const { seen, deps: d } = await github(Buffer.from("log text\n"));
		const result = await downloadJobLog(d, "gho_secret", REPO, 5001, 1024);
		expect(result).toEqual({ kind: "ok", value: "log text\n", etag: null });
		expect(seen.api).toEqual([
			"/repos/DevinoSolutions/voicelabs/actions/jobs/5001/logs|Bearer gho_secret",
		]);
		expect(seen.blobAuthorization).toBeNull();
	});

	it("does the same for an artifact", async () => {
		const zip = Buffer.from([1, 2, 3, 4]);
		const { seen, deps: d } = await github(zip);
		const result = await downloadArtifactZip(d, "gho_secret", REPO, 77, 1024);
		expect(result).toEqual({
			kind: "ok",
			value: new Uint8Array(zip),
			etag: null,
		});
		expect(seen.api[0]).toContain(
			"/actions/artifacts/77/zip|Bearer gho_secret",
		);
		expect(seen.blobAuthorization).toBeNull();
	});

	it("stops reading a blob that is larger than the cap", async () => {
		const { deps: d } = await github(Buffer.alloc(64 * 1024, 97));
		expect(await downloadJobLog(d, "t", REPO, 1, 1000)).toEqual({
			kind: "error",
			status: 413,
		});
	});
});
