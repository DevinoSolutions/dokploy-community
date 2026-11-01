import {
	applications,
	compose,
	githubDeploymentWatch,
} from "@dokploy/server/db/schema";
import type { WatchRow } from "@dokploy/server/services/github-deployments";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedFetch } from "./helpers";

const mocks = vi.hoisted(() => ({
	events: [] as string[],
	updates: [] as Array<{
		tx: number;
		table: unknown;
		values: Record<string, unknown>;
	}>,
	txCount: 0,
	lockedRow: null as Record<string, unknown> | null,
	failCommitOfTx: 0,
	queueAdd: vi.fn(),
	getJobs: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	getDokployUrl: vi.fn(),
	selectFields: [] as unknown[],
	selectRows: [] as unknown[],
	appFindFirst: vi.fn(),
	composeFindFirst: vi.fn(),
	listEnabledGithubWatches: vi.fn(),
	deleteGithubWatch: vi.fn(),
	removeGhcrWatchConfigDirs: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
	getDokployUrl: mocks.getDokployUrl,
}));

vi.mock("@dokploy/server/db", () => {
	const makeTx = (id: number) => ({
		select: () => ({
			from: () => ({
				where: () => ({ for: async () => [mocks.lockedRow] }),
			}),
		}),
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: async () => {
					mocks.updates.push({ tx: id, table, values });
					mocks.events.push(`tx${id}:write`);
				},
			}),
		}),
	});
	return {
		db: {
			transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
				mocks.txCount += 1;
				const id = mocks.txCount;
				mocks.events.push(`tx${id}:begin`);
				const result = await fn(makeTx(id));
				if (mocks.failCommitOfTx === id) {
					mocks.events.push(`tx${id}:rollback`);
					throw new Error("commit failed");
				}
				mocks.events.push(`tx${id}:commit`);
				return result;
			},
			select: (fields: unknown) => {
				mocks.selectFields.push(fields);
				return {
					from: () => ({
						where: () => ({
							orderBy: () => ({ limit: async () => mocks.selectRows }),
						}),
					}),
				};
			},
			query: {
				applications: { findFirst: mocks.appFindFirst },
				compose: { findFirst: mocks.composeFindFirst },
			},
		},
	};
});

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: {
		add: async (...args: unknown[]) => {
			mocks.events.push("queue:add");
			return mocks.queueAdd(...args);
		},
		getJobs: mocks.getJobs,
	},
}));

vi.mock("@dokploy/server/utils/process/background", () => ({
	runBackgroundJob: async (_name: string, fn: () => Promise<void>) => fn(),
}));

vi.mock(
	"@dokploy/server/services/github-deployments",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		listEnabledGithubWatches: mocks.listEnabledGithubWatches,
		deleteGithubWatch: mocks.deleteGithubWatch,
		removeGhcrWatchConfigDirs: mocks.removeGhcrWatchConfigDirs,
	}),
);

const poller = await import("@/server/queues/github-deployments-poller");

const DIGEST_OLD = `sha256:${"a".repeat(64)}`;
const DIGEST_NEW = `sha256:${"b".repeat(64)}`;
const REPO = "ghcr.io/devinosolutions/sendly-web";
const payload = {
	kind: "deploy" as const,
	image: `${REPO}@${DIGEST_NEW}`,
	repository: REPO,
	digest: DIGEST_NEW,
};
const deployment = { id: 120 };

const watchRow = (overrides: Partial<WatchRow> = {}): WatchRow => ({
	watchId: "w1",
	organizationId: "org-a",
	serviceType: "application",
	serviceId: "app-1",
	connectionId: "conn-1",
	owner: "DevinoSolutions",
	repo: "sendly",
	environment: "production",
	enabled: true,
	lastSeenDeploymentId: 100,
	etag: null,
	inflightDeploymentId: null,
	inflightStartedAt: null,
	postLogUrl: false,
	...overrides,
});

/** What the database holds for the watch, as the poll saw it. */
const lockedFor = (
	watch: WatchRow,
	overrides: Record<string, unknown> = {},
) => ({
	watchId: watch.watchId,
	enabled: watch.enabled,
	inflightDeploymentId: watch.inflightDeploymentId,
	owner: watch.owner,
	repo: watch.repo,
	environment: watch.environment,
	connectionId: watch.connectionId,
	lastSeenDeploymentId: watch.lastSeenDeploymentId,
	...overrides,
});

const app = (overrides: Record<string, unknown> = {}) => ({
	applicationId: "app-1",
	appName: "web",
	sourceType: "docker",
	dockerImage: `${REPO}@${DIGEST_OLD}`,
	serverId: null,
	environmentId: "env-1",
	environment: { projectId: "proj-1", project: { organizationId: "org-a" } },
	...overrides,
});
const COMPOSE_FILE = `services:\n  web:\n    image: ${REPO}@${DIGEST_OLD}\n`;
const stack = (overrides: Record<string, unknown> = {}) => ({
	composeId: "c-1",
	sourceType: "raw",
	composeFile: COMPOSE_FILE,
	serverId: null,
	environmentId: "env-1",
	environment: { projectId: "proj-1", project: { organizationId: "org-a" } },
	...overrides,
});

const deps = () => poller.createGithubDeploymentsPollDeps();

beforeEach(() => {
	vi.clearAllMocks();
	mocks.events = [];
	mocks.updates = [];
	mocks.txCount = 0;
	mocks.failCommitOfTx = 0;
	mocks.selectFields = [];
	mocks.selectRows = [];
	mocks.lockedRow = lockedFor(watchRow());
	mocks.queueAdd.mockResolvedValue({ id: "job-1" });
	mocks.getJobs.mockResolvedValue([]);
	mocks.findApplicationById.mockResolvedValue(app());
	mocks.findComposeById.mockResolvedValue(stack());
	mocks.getDokployUrl.mockResolvedValue("https://dokploy.example");
	mocks.listEnabledGithubWatches.mockResolvedValue([]);
	mocks.deleteGithubWatch.mockResolvedValue(undefined);
	mocks.removeGhcrWatchConfigDirs.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("startDeploy: application", () => {
	it("writes the cursor, the in-flight mark and the new image in ONE transaction, then enqueues after the commit", async () => {
		const watch = watchRow();
		const outcome = await deps().startDeploy(watch, deployment, payload);

		expect(outcome).toEqual({ kind: "started", logUrl: undefined });
		expect(mocks.events).toEqual([
			"tx1:begin",
			"tx1:write",
			"tx1:write",
			"tx1:commit",
			"queue:add",
		]);
		const claim = mocks.updates.find((u) => u.table === githubDeploymentWatch);
		expect(claim?.values).toMatchObject({
			lastSeenDeploymentId: 120,
			inflightDeploymentId: 120,
		});
		const image = mocks.updates.find((u) => u.table === applications);
		expect(image?.values).toEqual({ dockerImage: payload.image });
		expect(image?.tx).toBe(1);
		// The job carries the service, the title that identifies the GitHub deployment, no image.
		expect(mocks.queueAdd.mock.calls[0]?.[1]).toMatchObject({
			applicationId: "app-1",
			applicationType: "application",
			type: "deploy",
			titleLog: poller.githubDeploymentTitle(120),
		});
	});

	it("a failed commit enqueues nothing and writes nothing outside the transaction", async () => {
		mocks.failCommitOfTx = 1;
		await expect(
			deps().startDeploy(watchRow(), deployment, payload),
		).rejects.toThrow("commit failed");
		expect(mocks.queueAdd).not.toHaveBeenCalled();
		expect(mocks.updates.every((u) => u.tx === 1)).toBe(true);
		expect(mocks.events).toContain("tx1:rollback");
		expect(mocks.events).not.toContain("queue:add");
	});

	it("a failed enqueue puts the image, the cursor and the in-flight mark back", async () => {
		mocks.queueAdd.mockRejectedValue(new Error("queue closed"));
		await expect(
			deps().startDeploy(watchRow(), deployment, payload),
		).rejects.toThrow("queue closed");

		const undo = mocks.updates.filter((u) => u.tx === 2);
		expect(undo.find((u) => u.table === githubDeploymentWatch)?.values).toEqual(
			{
				lastSeenDeploymentId: 100,
				inflightDeploymentId: null,
				inflightStartedAt: null,
			},
		);
		expect(undo.find((u) => u.table === applications)?.values).toEqual({
			dockerImage: `${REPO}@${DIGEST_OLD}`,
		});
		expect(mocks.events.slice(-5)).toEqual([
			"queue:add",
			"tx2:begin",
			"tx2:write",
			"tx2:write",
			"tx2:commit",
		]);
	});

	it("builds the dashboard link only for a watch that opted in", async () => {
		const plain = await deps().startDeploy(watchRow(), deployment, payload);
		expect(plain).toMatchObject({ kind: "started", logUrl: undefined });

		mocks.txCount = 0;
		const watch = watchRow({ postLogUrl: true });
		mocks.lockedRow = lockedFor(watch);
		const linked = await deps().startDeploy(watch, deployment, payload);
		expect(linked).toMatchObject({
			kind: "started",
			logUrl: expect.stringContaining(
				"https://dokploy.example/dashboard/project/proj-1/environment/env-1/services/application/app-1",
			),
		});
	});

	it("rejects an image of another repository without writing anything or enqueuing", async () => {
		const outcome = await deps().startDeploy(watchRow(), deployment, {
			...payload,
			repository: "ghcr.io/other/app",
			image: `ghcr.io/other/app@${DIGEST_NEW}`,
		});
		expect(outcome.kind).toBe("rejected");
		expect(mocks.updates).toEqual([]);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("rejects a service of another organization", async () => {
		mocks.findApplicationById.mockResolvedValue(
			app({
				environment: { projectId: "p", project: { organizationId: "org-b" } },
			}),
		);
		const outcome = await deps().startDeploy(watchRow(), deployment, payload);
		expect(outcome.kind).toBe("rejected");
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});
});

describe("startDeploy: the locked row must still match what the tick decided on", () => {
	it.each([
		["another repository", { repo: "other" }],
		["another owner", { owner: "Other" }],
		["another environment", { environment: "staging" }],
		["another connection", { connectionId: "conn-2" }],
		["a cursor that moved", { lastSeenDeploymentId: 110 }],
		["a cursor at or beyond this deployment", { lastSeenDeploymentId: 120 }],
		["a cursor that was reset", { lastSeenDeploymentId: null }],
		["a deployment already in flight", { inflightDeploymentId: 99 }],
		["a watch that was turned off", { enabled: false }],
	])("is stale after %s", async (_name, change) => {
		mocks.lockedRow = lockedFor(watchRow(), change);
		const outcome = await deps().startDeploy(watchRow(), deployment, payload);
		expect(outcome).toEqual({ kind: "stale" });
		expect(mocks.updates).toEqual([]);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("is stale when the watch is gone", async () => {
		mocks.lockedRow = null;
		expect(await deps().startDeploy(watchRow(), deployment, payload)).toEqual({
			kind: "stale",
		});
	});
});

describe("startDeploy: compose", () => {
	const composeWatch = () =>
		watchRow({ serviceType: "compose", serviceId: "c-1" });

	it("pins the digest in the compose file inside the transaction", async () => {
		const watch = composeWatch();
		mocks.lockedRow = lockedFor(watch);
		const outcome = await deps().startDeploy(watch, deployment, payload);
		expect(outcome.kind).toBe("started");
		const written = mocks.updates.find((u) => u.table === compose);
		expect(written?.tx).toBe(1);
		expect(written?.values.composeFile).toBe(
			COMPOSE_FILE.replace(DIGEST_OLD, DIGEST_NEW),
		);
		expect(mocks.events.indexOf("tx1:commit")).toBeLessThan(
			mocks.events.indexOf("queue:add"),
		);
	});

	it("a failed enqueue restores the compose file it wrote", async () => {
		const watch = composeWatch();
		mocks.lockedRow = lockedFor(watch);
		mocks.queueAdd.mockRejectedValue(new Error("queue closed"));
		await expect(
			deps().startDeploy(watch, deployment, payload),
		).rejects.toThrow();
		const restore = mocks.updates.find(
			(u) => u.tx === 2 && u.table === compose,
		);
		expect(restore?.values).toEqual({ composeFile: COMPOSE_FILE });
	});

	it("leaves the compose file alone when the digest is already pinned", async () => {
		const watch = composeWatch();
		mocks.lockedRow = lockedFor(watch);
		mocks.findComposeById.mockResolvedValue(
			stack({ composeFile: COMPOSE_FILE.replace(DIGEST_OLD, DIGEST_NEW) }),
		);
		await deps().startDeploy(watch, deployment, payload);
		expect(mocks.updates.some((u) => u.table === compose)).toBe(false);
	});
});

describe("inspectInflight", () => {
	const inflight = (overrides: Partial<WatchRow> = {}) =>
		watchRow({
			inflightDeploymentId: 120,
			inflightStartedAt: new Date(),
			...overrides,
		});

	it("reads only the status of the Dokploy deployment, never its error message", async () => {
		mocks.selectRows = [{ status: "error" }];
		const state = await deps().inspectInflight(inflight());
		expect(state).toEqual({ state: "error", logUrl: undefined });
		expect(Object.keys(mocks.selectFields[0] as object)).toEqual(["status"]);
	});

	it("builds a link only for a watch that opted in", async () => {
		mocks.selectRows = [{ status: "done" }];
		expect(await deps().inspectInflight(inflight())).toEqual({
			state: "done",
			logUrl: undefined,
		});
		const linked = await deps().inspectInflight(inflight({ postLogUrl: true }));
		expect(linked).toMatchObject({
			state: "done",
			logUrl: expect.stringContaining("/services/application/app-1"),
		});
	});

	it("maps the deployment states", async () => {
		for (const [status, expected] of [
			["done", "done"],
			["error", "error"],
			["cancelled", "cancelled"],
			["running", "running"],
		] as const) {
			mocks.selectRows = [{ status }];
			expect((await deps().inspectInflight(inflight())).state).toBe(expected);
		}
	});

	it("is running while the job still waits in the queue, and missing when it does not", async () => {
		mocks.selectRows = [];
		mocks.getJobs.mockResolvedValue([
			{ data: { titleLog: poller.githubDeploymentTitle(120) } },
		]);
		expect((await deps().inspectInflight(inflight())).state).toBe("running");
		mocks.getJobs.mockResolvedValue([]);
		expect((await deps().inspectInflight(inflight())).state).toBe("missing");
	});
});

describe("the tick", () => {
	const record = (overrides: Record<string, unknown> = {}) => ({
		...watchRow(),
		...overrides,
	});

	it("tells GitHub a deployment in flight failed, then drops the watch and its docker login, when the service is gone", async () => {
		mocks.listEnabledGithubWatches.mockResolvedValue([
			record({ inflightDeploymentId: 120, inflightStartedAt: new Date() }),
		]);
		mocks.appFindFirst.mockResolvedValue(undefined);
		const { fetch, calls } = scriptedFetch([{ status: 201, json: {} }]);
		const poll = {
			...deps(),
			fetch,
			loadToken: async () => "gho_secret",
		};
		await poller.runGithubDeploymentsTick(poll);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/deployments/120/statuses");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
			state: "failure",
		});
		expect(mocks.deleteGithubWatch).toHaveBeenCalledWith(
			"application",
			"app-1",
		);
		expect(mocks.removeGhcrWatchConfigDirs).toHaveBeenCalledWith(
			["w1"],
			"org-a",
		);
	});

	it("posts nothing for a deleted service that had nothing in flight", async () => {
		mocks.listEnabledGithubWatches.mockResolvedValue([record()]);
		mocks.composeFindFirst.mockResolvedValue(undefined);
		mocks.appFindFirst.mockResolvedValue(undefined);
		const { fetch, calls } = scriptedFetch([{ status: 201, json: {} }]);
		await poller.runGithubDeploymentsTick({ ...deps(), fetch });
		expect(calls).toHaveLength(0);
		expect(mocks.deleteGithubWatch).toHaveBeenCalled();
	});

	it("does not start on another watch once told to stop", async () => {
		mocks.listEnabledGithubWatches.mockResolvedValue([
			record(),
			record({ watchId: "w2", serviceId: "app-2" }),
		]);
		mocks.appFindFirst.mockResolvedValue(undefined);
		await poller.runGithubDeploymentsTick(deps(), () => true);
		expect(mocks.appFindFirst).not.toHaveBeenCalled();
		expect(mocks.deleteGithubWatch).not.toHaveBeenCalled();
	});
});

describe("the poller's stop handle", () => {
	it("ticks on the interval and stops ticking after the handle is called", async () => {
		vi.useFakeTimers();
		const stop = poller.startGithubDeploymentsPoller(deps(), 1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.listEnabledGithubWatches).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(mocks.listEnabledGithubWatches).toHaveBeenCalledTimes(3);

		stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(mocks.listEnabledGithubWatches).toHaveBeenCalledTimes(3);
		// Stopping twice is harmless.
		expect(() => stop()).not.toThrow();
	});
});
