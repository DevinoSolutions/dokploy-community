import { GITHUB_RUN_STEP_UNREADABLE } from "@dokploy/server/services/build-origin-shared";
import {
	createGithubRunPoller,
	DEPLOY_TAKEOVER_GRACE_MS,
	type LiveRunRow,
	MAX_LIVE_ROW_AGE_MS,
	MAX_READS_PER_PASS,
	POLL_INTERVAL_MS,
	type PollerDeps,
	RUN_UNREADABLE_LINE,
	type RunFetchResult,
	UNAUTHENTICATED_POLL_INTERVAL_MS,
	UNREADABLE_POLL_INTERVAL_MS,
} from "@dokploy/server/services/github-run-poller";
import {
	GITHUB_LOG_PREFIX,
	type GithubRunJob,
} from "@dokploy/server/services/github-run-progress";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The decisions of the live-row poller, with no GitHub, database or host: what it writes, when it asks again, and
 * when it ends a row.
 */

const START = Date.parse("2026-11-02T10:00:00Z");

const row = (overrides: Partial<LiveRunRow> = {}): LiveRunRow => ({
	deploymentId: "dep-1",
	applicationId: "app-1",
	composeId: null,
	serverId: null,
	buildServerId: null,
	logPath: "/logs/app/app.log",
	buildRepository: "acme/web",
	buildRunId: "42",
	buildRunUrl: "https://github.com/acme/web/actions/runs/42",
	buildRunStatus: "in_progress",
	buildRunStep: null,
	startedAt: new Date(START).toISOString(),
	createdAt: new Date(START).toISOString(),
	...overrides,
});

const building: GithubRunJob[] = [
	{
		name: "build",
		status: "in_progress",
		conclusion: null,
		steps: [
			{
				number: 1,
				name: "Checkout",
				status: "completed",
				conclusion: "success",
				started_at: "2026-11-02T10:00:00Z",
				completed_at: "2026-11-02T10:00:07Z",
			},
			{
				number: 2,
				name: "Build image",
				status: "in_progress",
				conclusion: null,
				started_at: "2026-11-02T10:00:07Z",
			},
		],
	},
];

const finished = (conclusion: string): GithubRunJob[] => [
	{
		name: "build",
		status: "completed",
		conclusion,
		steps: [
			{
				number: 1,
				name: "Build image",
				status: "completed",
				conclusion,
				started_at: "2026-11-02T10:00:00Z",
				completed_at: "2026-11-02T10:02:13Z",
			},
		],
	},
];

const ok = (
	jobs: GithubRunJob[],
	extra: Partial<Extract<RunFetchResult, { kind: "ok" }>> = {},
): RunFetchResult => ({
	kind: "ok",
	jobs,
	run: null,
	authenticated: true,
	rateLimitRemaining: 4000,
	rateLimitResetAt: null,
	...extra,
});

let clock = START + 60_000;
let rows: LiveRunRow[];
let log: string;
const fetchRun = vi.fn<PollerDeps["fetchRun"]>();
const appended: string[][] = [];
const setProgress = vi.fn<PollerDeps["setProgress"]>();
const markRunFinished = vi.fn<PollerDeps["markRunFinished"]>();
const endRow = vi.fn<PollerDeps["endRow"]>();
const readLog = vi.fn<PollerDeps["readLog"]>();

const makePoller = () =>
	createGithubRunPoller({
		now: () => clock,
		listLiveRows: async () => rows,
		fetchRun,
		readLog,
		appendLines: async (_row, lines) => {
			appended.push([...lines]);
			log += `${lines.join("\n")}\n`;
		},
		setProgress,
		markRunFinished,
		endRow,
	});

const writtenLines = () => appended.flat();

beforeEach(() => {
	vi.clearAllMocks();
	clock = START + 60_000;
	rows = [row()];
	log = "Initializing deployment\n";
	appended.length = 0;
	readLog.mockImplementation(async () => log);
	setProgress.mockResolvedValue(true);
	markRunFinished.mockResolvedValue(true);
	endRow.mockResolvedValue(true);
	fetchRun.mockResolvedValue(ok(building));
});

describe("following a run", () => {
	it("puts the state and the step on the row and the step lines in the log", async () => {
		await makePoller().poll();

		expect(setProgress).toHaveBeenCalledWith("dep-1", {
			buildRunStatus: "in_progress",
			buildRunStep: "build · Build image (2/2)",
		});
		expect(writtenLines()).toEqual([
			`${GITHUB_LOG_PREFIX} build › Checkout started`,
			`${GITHUB_LOG_PREFIX} build › Checkout completed in 7s`,
			`${GITHUB_LOG_PREFIX} build › Build image started`,
		]);
	});

	it("asks again only after the interval, and writes nothing when nothing moved", async () => {
		const poller = makePoller();
		await poller.poll();
		expect(fetchRun).toHaveBeenCalledTimes(1);

		clock += POLL_INTERVAL_MS - 1;
		await poller.poll();
		expect(fetchRun).toHaveBeenCalledTimes(1);

		clock += 1;
		await poller.poll();
		expect(fetchRun).toHaveBeenCalledTimes(2);
		// Same jobs: no second write of the row, no repeated lines.
		expect(setProgress).toHaveBeenCalledTimes(1);
		expect(writtenLines()).toHaveLength(3);
	});

	it("waits 60 s between reads without a token", async () => {
		fetchRun.mockResolvedValue(ok(building, { authenticated: false }));
		const poller = makePoller();
		await poller.poll();
		clock += POLL_INTERVAL_MS;
		await poller.poll();
		expect(fetchRun).toHaveBeenCalledTimes(1);
		clock += UNAUTHENTICATED_POLL_INTERVAL_MS;
		await poller.poll();
		expect(fetchRun).toHaveBeenCalledTimes(2);
	});

	it("writes no line twice after a restart: it reads the log it finds", async () => {
		await makePoller().poll();
		const before = writtenLines().length;
		// A new process: no memory, the same log.
		await makePoller().poll();
		expect(writtenLines()).toHaveLength(before);
	});

	it("backs off when GitHub says to, and when the limit is nearly used up", async () => {
		fetchRun.mockResolvedValueOnce({ kind: "backoff", retryAfterMs: 120_000 });
		const poller = makePoller();
		await poller.poll();
		clock += 119_000;
		await poller.poll();
		expect(fetchRun).toHaveBeenCalledTimes(1);
		clock += 1_000;
		fetchRun.mockResolvedValue(
			ok(building, {
				rateLimitRemaining: 2,
				rateLimitResetAt: clock + 5 * 60_000,
			}),
		);
		await poller.poll();
		expect(fetchRun).toHaveBeenCalledTimes(2);
		clock += POLL_INTERVAL_MS;
		await poller.poll();
		// The window has not reset yet: the last requests are kept.
		expect(fetchRun).toHaveBeenCalledTimes(2);
	});

	it("says once that the run cannot be read, and tries again in five minutes", async () => {
		fetchRun.mockResolvedValue({ kind: "unreadable" });
		const poller = makePoller();
		await poller.poll();
		expect(writtenLines()).toEqual([RUN_UNREADABLE_LINE]);

		clock += UNREADABLE_POLL_INTERVAL_MS - 1;
		await poller.poll();
		expect(fetchRun).toHaveBeenCalledTimes(1);
		clock += 1;
		await poller.poll();
		expect(fetchRun).toHaveBeenCalledTimes(2);
		expect(writtenLines()).toEqual([RUN_UNREADABLE_LINE]);
		expect(endRow).not.toHaveBeenCalled();
	});

	it("marks a row whose run cannot be read as building with hidden steps, not as waiting to start", async () => {
		fetchRun.mockResolvedValue({ kind: "unreadable" });
		rows = [row({ buildRunStatus: "queued" })];
		const poller = makePoller();
		await poller.poll();
		expect(setProgress).toHaveBeenCalledTimes(1);
		expect(setProgress).toHaveBeenCalledWith("dep-1", {
			buildRunStatus: "in_progress",
			buildRunStep: GITHUB_RUN_STEP_UNREADABLE,
		});
		// Asked again later: the marker is written once.
		clock += UNREADABLE_POLL_INTERVAL_MS;
		await poller.poll();
		expect(setProgress).toHaveBeenCalledTimes(1);
	});

	it("keeps a step already shown when the run turns unreadable", async () => {
		fetchRun.mockResolvedValue({ kind: "unreadable" });
		rows = [row({ buildRunStep: "build · Build image (3/7)" })];
		const poller = makePoller();
		await poller.poll();
		expect(setProgress).not.toHaveBeenCalled();
	});

	it("lets go of a row a deploy took over", async () => {
		setProgress.mockResolvedValue(false);
		const poller = makePoller();
		await poller.poll();
		expect(poller.followedCount()).toBe(0);
		clock += POLL_INTERVAL_MS;
		rows = [];
		await poller.poll();
		expect(fetchRun).toHaveBeenCalledTimes(1);
	});
});

describe("a run that ends", () => {
	it("ends the row as error when the run failed and no deploy took over", async () => {
		fetchRun.mockResolvedValue(ok(finished("failure")));
		await makePoller().poll();

		expect(endRow).toHaveBeenCalledWith("dep-1", {
			status: "error",
			errorMessage: "GitHub Actions run #42 failed. The run has the details.",
		});
		expect(writtenLines().at(-2)).toBe(
			`${GITHUB_LOG_PREFIX} GitHub Actions run #42 failed.`,
		);
		expect(writtenLines().at(-1)).toBe(
			`${GITHUB_LOG_PREFIX} Open the run: https://github.com/acme/web/actions/runs/42`,
		);
		expect(markRunFinished).not.toHaveBeenCalled();
	});

	it("ends the row as cancelled when the run was cancelled", async () => {
		fetchRun.mockResolvedValue(ok(finished("cancelled")));
		await makePoller().poll();
		expect(endRow).toHaveBeenCalledWith("dep-1", {
			status: "cancelled",
			errorMessage:
				"GitHub Actions run #42 was cancelled. The run has the details.",
		});
	});

	it("writes nothing more when a deploy took the row over while the run ended", async () => {
		endRow.mockResolvedValue(false);
		fetchRun.mockResolvedValue(ok(finished("failure")));
		await makePoller().poll();
		// The step lines of the last read are written; the failure text is not.
		expect(writtenLines().join("\n")).not.toContain("failed. The");
		expect(writtenLines().join("\n")).not.toContain("Open the run");
	});

	it("marks the run completed when it succeeded, and keeps the row for the deploy to take over", async () => {
		fetchRun.mockResolvedValue(ok(finished("success")));
		const poller = makePoller();
		await poller.poll();

		expect(markRunFinished).toHaveBeenCalledWith("dep-1");
		expect(endRow).not.toHaveBeenCalled();
		expect(writtenLines().at(-1)).toBe(
			`${GITHUB_LOG_PREFIX} Run #42 finished. Waiting for the workflow's deploy to take it over.`,
		);
		expect(poller.followedCount()).toBe(1);
	});

	it("does not ask GitHub again once the run succeeded, and closes the row after the 10 minute grace", async () => {
		fetchRun.mockResolvedValue(ok(finished("success")));
		const poller = makePoller();
		await poller.poll();
		fetchRun.mockClear();

		// Inside the grace: nothing is read, nothing is ended.
		clock += DEPLOY_TAKEOVER_GRACE_MS - 1_000;
		await poller.poll();
		expect(fetchRun).not.toHaveBeenCalled();
		expect(endRow).not.toHaveBeenCalled();

		// Past it: the run finished and nobody deployed.
		clock += 2_000;
		await poller.poll();
		expect(fetchRun).not.toHaveBeenCalled();
		expect(endRow).toHaveBeenCalledWith("dep-1", {
			status: "error",
			errorMessage:
				"GitHub Actions run #42 finished without deploying to Dokploy. Open the run for details.",
		});
		expect(writtenLines().at(-2)).toContain("finished without deploying");
		expect(writtenLines().at(-1)).toContain("Open the run");
		expect(poller.followedCount()).toBe(0);
	});

	it("starts the grace for a row already marked completed (a restart in between) without reading GitHub", async () => {
		rows = [row({ buildRunStatus: "completed" })];
		const poller = makePoller();
		await poller.poll();
		expect(fetchRun).not.toHaveBeenCalled();
		expect(endRow).not.toHaveBeenCalled();

		clock += DEPLOY_TAKEOVER_GRACE_MS + 1_000;
		await poller.poll();
		expect(endRow).toHaveBeenCalledWith(
			"dep-1",
			expect.objectContaining({ status: "error" }),
		);
	});

	it("lets go, without writing, of a completed row a deploy took over inside the grace", async () => {
		fetchRun.mockResolvedValue(ok(finished("success")));
		const poller = makePoller();
		await poller.poll();
		rows = [];
		clock += 1_000;
		await poller.poll();
		expect(poller.followedCount()).toBe(0);
		expect(endRow).not.toHaveBeenCalled();
	});

	it("takes the run's own word on the conclusion and waits while the run is not over", async () => {
		fetchRun.mockResolvedValueOnce(
			ok(finished("success"), {
				run: { status: "in_progress", conclusion: null },
			}),
		);
		const poller = makePoller();
		await poller.poll();
		expect(markRunFinished).not.toHaveBeenCalled();
		expect(endRow).not.toHaveBeenCalled();

		clock += POLL_INTERVAL_MS;
		fetchRun.mockResolvedValue(
			ok(finished("success"), {
				run: { status: "completed", conclusion: "failure" },
			}),
		);
		await poller.poll();
		expect(endRow).toHaveBeenCalledWith(
			"dep-1",
			expect.objectContaining({ status: "error" }),
		);
	});

	it("ends a run whose jobs were all skipped as cancelled", async () => {
		fetchRun.mockResolvedValue(
			ok([
				{
					name: "build",
					status: "completed",
					conclusion: "skipped",
					steps: [],
				},
			]),
		);
		await makePoller().poll();
		expect(endRow).toHaveBeenCalledWith("dep-1", {
			status: "cancelled",
			errorMessage: "Build skipped",
		});
	});
});

describe("the six hour limit", () => {
	it("ends a row nothing took over: run finished without deploying", async () => {
		clock = START + MAX_LIVE_ROW_AGE_MS + 1;
		await makePoller().poll();

		expect(fetchRun).not.toHaveBeenCalled();
		expect(endRow).toHaveBeenCalledWith("dep-1", {
			status: "error",
			errorMessage: expect.stringContaining("finished without deploying"),
		});
		expect(writtenLines()[0]).toContain("finished without deploying");
	});

	it("leaves a younger row alone", async () => {
		clock = START + MAX_LIVE_ROW_AGE_MS - 1;
		await makePoller().poll();
		expect(endRow).not.toHaveBeenCalled();
		expect(fetchRun).toHaveBeenCalledTimes(1);
	});
});

describe("robustness", () => {
	it("keeps following the other rows when one fails", async () => {
		rows = [row({ deploymentId: "bad" }), row({ deploymentId: "good" })];
		fetchRun.mockRejectedValueOnce(new Error("network down"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await makePoller().poll();
		expect(setProgress).toHaveBeenCalledWith("good", expect.anything());
		error.mockRestore();
	});

	it("does nothing, and asks nothing, when no row waits", async () => {
		rows = [];
		await makePoller().poll();
		expect(fetchRun).not.toHaveBeenCalled();
	});

	it("does not start a second pass while one runs", async () => {
		let release: () => void = () => {};
		fetchRun.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () => resolve(ok(building));
				}),
		);
		const poller = makePoller();
		const first = poller.poll();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await poller.poll();
		release();
		await first;
		expect(fetchRun).toHaveBeenCalledTimes(1);
	});
});

describe("a deploy that waits in Dokploy's queue", () => {
	it("is never read, ended or counted down while it waits, even after a failed run and 6 hours", async () => {
		rows = [row({ deployQueuedAt: new Date(START).toISOString() })];
		const poller = makePoller();
		clock = START + 7 * 60 * 60_000;
		await poller.poll();
		expect(fetchRun).not.toHaveBeenCalled();
		expect(endRow).not.toHaveBeenCalled();
		expect(poller.followedCount()).toBe(1);
	});

	it("is ended only by the 24 hour backstop, when the queued deploy never ran", async () => {
		rows = [row({ deployQueuedAt: new Date(START).toISOString() })];
		const poller = makePoller();
		clock = START + 25 * 60 * 60_000;
		await poller.poll();
		expect(endRow).toHaveBeenCalledWith("dep-1", {
			status: "error",
			deployQueued: true,
			errorMessage: expect.stringContaining("never started within 24 hours"),
		});
	});
});

describe("many live rows", () => {
	it("reads at most 25 runs per pass and serves the rows read longest ago first, so none starves", async () => {
		rows = Array.from({ length: 30 }, (_, i) =>
			row({
				deploymentId: `dep-${i}`,
				buildRunId: String(100 + i),
				createdAt: new Date(START + i).toISOString(),
				startedAt: new Date(START + i).toISOString(),
			}),
		);
		fetchRun.mockResolvedValue(ok(building));
		const poller = makePoller();
		await poller.poll();
		expect(fetchRun).toHaveBeenCalledTimes(MAX_READS_PER_PASS);
		const first = new Set(fetchRun.mock.calls.map(([r]) => r.deploymentId));
		expect(first.has("dep-29")).toBe(false);

		fetchRun.mockClear();
		clock += POLL_INTERVAL_MS;
		await poller.poll();
		// The five rows never read come first; the rest follow within the budget.
		const second = fetchRun.mock.calls.map(([r]) => r.deploymentId);
		expect(second.slice(0, 5).sort()).toEqual(
			["dep-25", "dep-26", "dep-27", "dep-28", "dep-29"].sort(),
		);
	});
});
