import type { GhaConnectionRow } from "@dokploy/server/services/gha-connect";
import { resetConnectionPollState } from "@dokploy/server/services/gha-connect/poll";
import { resetPollState } from "@dokploy/server/services/github-deployments/poll-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Reply } from "./gha-helpers";
import { harness, NOW, watchRow } from "./poll-harness";

const mocks = vi.hoisted(() => ({
	applyConnectionEvent: vi.fn(),
	renameGhaConnectionRepository: vi.fn(),
	recordRunSeen: vi.fn(),
	listPendingReleases: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	registerExternalBuild: vi.fn(),
}));
vi.mock("@dokploy/server/db", () => ({ db: {} }));
vi.mock("@dokploy/server/services/backup", () => ({ findBackupById: vi.fn() }));
vi.mock("@dokploy/server/utils/backups/compose", () => ({
	runComposeBackup: vi.fn(),
}));
vi.mock("@dokploy/server/services/gha-connect", async (importOriginal) => ({
	...(await importOriginal<object>()),
	applyConnectionEvent: mocks.applyConnectionEvent,
	renameGhaConnectionRepository: mocks.renameGhaConnectionRepository,
	recordRunSeen: mocks.recordRunSeen,
	listPendingReleases: mocks.listPendingReleases,
}));

const deps = await import("@/server/queues/gha-connection-deps");

const REPO_OK: Reply = {
	json: {
		id: 42,
		name: "voicelabs",
		owner: { login: "DevinoSolutions" },
		full_name: "DevinoSolutions/voicelabs",
		default_branch: "dev",
	},
	headers: { etag: 'W/"repo1"' },
};
const BRANCH = { json: { commit: { sha: "a".repeat(40) } } };
const RUNS = { json: { workflow_runs: [] } };

const row = (overrides: Partial<GhaConnectionRow> = {}): GhaConnectionRow =>
	({
		ghaConnectionId: "c1",
		organizationId: "org1",
		serviceType: "compose",
		serviceId: "svc1",
		githubConnectionId: "gh1",
		repoId: 42,
		repoFullName: "DevinoSolutions/voicelabs",
		workflowPath: ".github/workflows/dokploy-web-build-deploy.yml",
		trackedBranch: "dev",
		environment: "development",
		serviceKey: "web",
		state: "waiting",
		deployedSha: null,
		lastRunSeenId: null,
		...overrides,
	}) as GhaConnectionRow;

const routes = (repo: Reply | Reply[] = REPO_OK) => {
	const repos = Array.isArray(repo) ? [...repo] : null;
	return [
		[
			"/repositories/42",
			() => (repos ? (repos.shift() ?? { status: 304 }) : (repo as Reply)),
		],
		["/branches/dev", BRANCH],
		["/actions/workflows/", RUNS],
		["/contents/", { status: 404 }],
	] as Array<[string, Reply | (() => Reply)]>;
};

const hits = (h: ReturnType<typeof harness>, needle: string) =>
	h.calls.filter((c) => c.url.includes(needle)).length;

beforeEach(() => {
	vi.clearAllMocks();
	resetPollState();
	resetConnectionPollState();
	deps.resetGhaConnectionState();
	mocks.renameGhaConnectionRepository.mockResolvedValue(true);
	mocks.listPendingReleases.mockResolvedValue([]);
});

describe("pollGhaConnection", () => {
	it("marks the connection disconnected and reads nothing when the token is gone", async () => {
		const h = harness({ deployments: null, routes: routes() });
		h.deps.loadToken = async () => null;
		await deps.pollGhaConnection(watchRow(), row(), h.deps);
		expect(mocks.applyConnectionEvent).toHaveBeenCalledWith("c1", {
			type: "token-revoked",
		});
		expect(h.calls).toEqual([]);
	});

	it("restores a disconnected connection when the token is back, then polls", async () => {
		const h = harness({ deployments: null, routes: routes() });
		await deps.pollGhaConnection(
			watchRow(),
			row({ state: "disconnected", deployedSha: "b".repeat(40) }),
			h.deps,
		);
		expect(mocks.applyConnectionEvent).toHaveBeenCalledWith("c1", {
			type: "token-restored",
			hasRelease: true,
		});
		expect(hits(h, "/deployments?")).toBe(1);
	});

	it("follows a renamed repository by its id on the same tick, before listing the Deployments", async () => {
		const renamed: Reply = {
			json: {
				id: 42,
				name: "voicelabs-v2",
				owner: { login: "DevinoSolutions" },
				full_name: "DevinoSolutions/voicelabs-v2",
				default_branch: "dev",
			},
			headers: { etag: 'W/"repo2"' },
		};
		const h = harness({ deployments: null, routes: routes(renamed) });
		const watch = watchRow();
		await deps.pollGhaConnection(watch, row(), h.deps);
		expect(mocks.renameGhaConnectionRepository).toHaveBeenCalledWith(
			"c1",
			"DevinoSolutions/voicelabs-v2",
		);
		expect(watch.repo).toBe("voicelabs-v2");
		const list = h.calls.find((c) => c.url.includes("/deployments?"));
		expect(list?.url).toContain(
			"/repos/DevinoSolutions/voicelabs-v2/deployments",
		);
	});

	it("asks for the name on every tick with the last ETag, so an unchanged name costs nothing", async () => {
		const h = harness({
			deployments: null,
			routes: routes([REPO_OK, { status: 304 }, { status: 304 }]),
		});
		for (let i = 0; i < 3; i++) {
			await deps.pollGhaConnection(watchRow(), row(), h.deps);
		}
		const repoCalls = h.calls.filter((c) => c.url.includes("/repositories/42"));
		// Once for the name check of the first tick, and the upkeep of the first tick reads it again;
		// the later ticks only do the name check.
		expect(repoCalls.length).toBeGreaterThanOrEqual(3);
		expect(repoCalls[1]?.headers["If-None-Match"]).toBe('W/"repo1"');
		expect(mocks.renameGhaConnectionRepository).not.toHaveBeenCalled();
	});

	it("runs the upkeep at most every two minutes, and at once after Check now", async () => {
		const h = harness({ deployments: null, routes: routes() });
		await deps.pollGhaConnection(watchRow(), row(), h.deps);
		await deps.pollGhaConnection(watchRow(), row(), h.deps);
		expect(hits(h, "/branches/dev")).toBe(1);
		await deps.pollGhaConnection(watchRow(), row(), h.deps, { woken: true });
		expect(hits(h, "/branches/dev")).toBe(2);
		// The Deployments are polled on every tick regardless.
		expect(hits(h, "/deployments?")).toBe(3);
	});

	it("Check now clears the back-off of the watch", async () => {
		const h = harness({ deployments: null, routes: routes() });
		h.blocks.set("watch:w1", NOW + 300_000);
		await deps.pollGhaConnection(watchRow(), row(), h.deps, { woken: true });
		expect(hits(h, "/deployments?")).toBe(1);
	});

	it("reads nothing at all while the connection is paused, not even the name or the upkeep", async () => {
		const h = harness({ deployments: null, routes: routes() });
		h.blocks.set("connection:gh1", NOW + 60_000);
		await deps.pollGhaConnection(watchRow(), row(), h.deps);
		expect(h.calls).toEqual([]);
		h.blocks.clear();
		h.blocks.set("watch:w1", NOW + 60_000);
		await deps.pollGhaConnection(watchRow(), row(), h.deps);
		expect(h.calls).toEqual([]);
	});

	it("a rate-limited upkeep read pauses the connection for what GitHub said", async () => {
		const h = harness({
			deployments: null,
			routes: [
				["/repositories/42", REPO_OK],
				["/branches/dev", { status: 429, headers: { "retry-after": "60" } }],
				["/actions/workflows/", RUNS],
			],
		});
		await deps.pollGhaConnection(watchRow(), row(), h.deps);
		expect(h.blocks.get("connection:gh1")).toBe(NOW + 60_000);
		// The Deployments poll that follows honours the pause.
		expect(hits(h, "/deployments?")).toBe(0);
	});

	it("a rate-limited name check pauses the connection and lists nothing", async () => {
		const h = harness({
			deployments: null,
			routes: [
				["/repositories/42", { status: 429, headers: { "retry-after": "30" } }],
			],
		});
		await deps.pollGhaConnection(watchRow(), row(), h.deps);
		expect(h.blocks.get("connection:gh1")).toBe(NOW + 30_000);
		expect(hits(h, "/deployments?")).toBe(0);
	});

	it("writes a rename that failed to save once GitHub answers 304 with the saved name", async () => {
		const renamed: Reply = {
			json: {
				id: 42,
				name: "voicelabs-v2",
				owner: { login: "DevinoSolutions" },
				full_name: "DevinoSolutions/voicelabs-v2",
				default_branch: "dev",
			},
			headers: { etag: 'W/"repo2"' },
		};
		const h = harness({
			deployments: null,
			routes: routes([renamed, { status: 304 }, { status: 304 }]),
		});
		// The first write is lost (another worker held the row); the stored name stays old.
		mocks.renameGhaConnectionRepository.mockResolvedValueOnce(false);
		await deps.pollGhaConnection(watchRow(), row(), h.deps);
		expect(mocks.renameGhaConnectionRepository).toHaveBeenCalledTimes(1);
		// The next tick: 304, but the row still has the old name.
		await deps.pollGhaConnection(watchRow(), row(), h.deps);
		expect(mocks.renameGhaConnectionRepository).toHaveBeenCalledTimes(2);
		expect(mocks.renameGhaConnectionRepository).toHaveBeenLastCalledWith(
			"c1",
			"DevinoSolutions/voicelabs-v2",
		);
		// Written: a 304 with a row that has the new name does nothing more.
		await deps.pollGhaConnection(
			watchRow(),
			row({ repoFullName: "DevinoSolutions/voicelabs-v2" }),
			h.deps,
		);
		expect(mocks.renameGhaConnectionRepository).toHaveBeenCalledTimes(2);
	});

	it("a failing upkeep read costs its own information, never the poll after it", async () => {
		const h = harness({
			deployments: null,
			routes: [
				["/repositories/42", { status: 500 }],
				["/branches/dev", { status: 500 }],
				["/actions/workflows/", { status: 500 }],
			],
		});
		await deps.pollGhaConnection(watchRow(), row(), h.deps);
		expect(hits(h, "/deployments?")).toBe(1);
		// GitHub being unreachable is never "stale".
		expect(
			mocks.applyConnectionEvent.mock.calls.filter(
				([, e]) => e.type === "stale",
			),
		).toEqual([]);
	});

	it("first tick after a boot reads GitHub again (nothing is remembered in memory) and replays nothing", async () => {
		const h = harness({
			deployments: [
				{
					id: 11,
					task: "dokploy:web",
					payload: {
						schema: "dokploy.deployment/v1",
						run_id: 100,
						run_attempt: 1,
						artifact: "dokploy-release",
					},
				},
			],
			processed: [
				{
					runId: 100,
					attempt: 1,
					outcome: "accepted",
					at: new Date(NOW).toISOString(),
				},
			],
			routes: routes(),
		});
		await deps.pollGhaConnection(watchRow(), row(), h.deps);
		expect(hits(h, "/branches/dev")).toBe(1);
		expect(hits(h, "/repositories/42")).toBeGreaterThan(0);
		expect(h.accepted).toEqual([]);
		expect(h.statuses()).toEqual([]);
	});

	const staleScenario = async () => {
		const long = (ms: number) => new Date(NOW - ms).toISOString();
		const h = harness({
			deployments: null,
			routes: [
				["/repositories/42", REPO_OK],
				["/branches/dev", BRANCH],
				["/compare/", { json: { status: "ahead" } }],
				[
					"/actions/workflows/",
					{
						json: {
							workflow_runs: [
								{
									id: 900,
									run_attempt: 1,
									path: ".github/workflows/dokploy-web-build-deploy.yml",
									head_branch: "dev",
									head_sha: "a".repeat(40),
									event: "push",
									status: "completed",
									conclusion: "success",
									repository: { id: 42 },
									head_repository: { id: 42 },
									html_url:
										"https://github.com/DevinoSolutions/voicelabs/actions/runs/900",
									run_started_at: long(3 * 60 * 60 * 1000),
									updated_at: long(170 * 60 * 1000),
								},
							],
						},
					},
				],
				[
					"/contents/",
					{
						json: {
							content: Buffer.from("name: x").toString("base64"),
							encoding: "base64",
						},
					},
				],
			],
		});
		await deps.pollGhaConnection(
			watchRow(),
			row({ state: "waiting", deployedSha: "b".repeat(40) }),
			h.deps,
		);
		return mocks.applyConnectionEvent.mock.calls.filter(
			([, e]) => e.type === "stale",
		);
	};

	it("reports Stale when the head was built long ago and no release was accepted", async () => {
		expect(await staleScenario()).toHaveLength(1);
	});

	it("tells the stale rule about releases waiting at the gate, so a waiting release is not Stale", async () => {
		mocks.listPendingReleases.mockResolvedValue([{ sha: "a".repeat(40) }]);
		expect(await staleScenario()).toEqual([]);
	});
});
