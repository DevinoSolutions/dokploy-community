import {
	resetWakeRequests,
	wakeGhaConnection,
} from "@dokploy/server/services/gha-connect/wake";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listEnabledGithubWatches: vi.fn(),
	listGhaConnections: vi.fn(),
	findGithubWatch: vi.fn(),
	upsertGithubWatch: vi.fn(),
	deleteGithubWatch: vi.fn(),
	deleteGhaConnection: vi.fn(),
	removeGhcrWatchConfigDirs: vi.fn(),
	reportServiceGone: vi.fn(),
	pollWatch: vi.fn(),
	pollGhaConnection: vi.fn(),
	appFindFirst: vi.fn(),
	composeFindFirst: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	getDokployUrl: vi.fn(),
	registerExternalBuild: vi.fn(),
}));
vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			applications: { findFirst: mocks.appFindFirst },
			compose: { findFirst: mocks.composeFindFirst },
		},
	},
}));
vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: vi.fn(), getJobs: vi.fn() },
}));
vi.mock("@/server/queues/gha-connection-deps", () => ({
	createGhaConnectionPollDeps: () => ({ marker: "connection-deps" }),
	pollGhaConnection: mocks.pollGhaConnection,
}));
vi.mock("@dokploy/server/utils/process/background", () => ({
	runBackgroundJob: async (_name: string, fn: () => Promise<void>) => fn(),
}));
vi.mock("@dokploy/server/services/gha-connect", async (importOriginal) => ({
	...(await importOriginal<object>()),
	listGhaConnections: mocks.listGhaConnections,
	deleteGhaConnection: mocks.deleteGhaConnection,
}));
vi.mock(
	"@dokploy/server/services/github-deployments",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		listEnabledGithubWatches: mocks.listEnabledGithubWatches,
		findGithubWatch: mocks.findGithubWatch,
		upsertGithubWatch: mocks.upsertGithubWatch,
		deleteGithubWatch: mocks.deleteGithubWatch,
		removeGhcrWatchConfigDirs: mocks.removeGhcrWatchConfigDirs,
		reportServiceGone: mocks.reportServiceGone,
		pollWatch: mocks.pollWatch,
	}),
);

const poller = await import("@/server/queues/github-deployments-poller");

const NOW = Date.now();
const watchRecord = (overrides: Record<string, unknown> = {}) => ({
	watchId: "w1",
	organizationId: "org1",
	serviceType: "compose",
	serviceId: "svc1",
	connectionId: "gh1",
	owner: "acme",
	repo: "shop",
	environment: "production",
	enabled: true,
	lastSeenDeploymentId: 5,
	etag: null,
	inflightDeploymentId: null,
	inflightStartedAt: null,
	postLogUrl: false,
	lastCheckedAt: null,
	...overrides,
});
const connectionRow = (overrides: Record<string, unknown> = {}) => ({
	ghaConnectionId: "gc1",
	serviceType: "compose",
	serviceId: "svc1",
	lastActivityAt: new Date(NOW),
	createdAt: new Date(NOW - 3_600_000),
	...overrides,
});
const deps = () => ({ log: vi.fn() }) as never;

beforeEach(() => {
	vi.clearAllMocks();
	resetWakeRequests();
	mocks.listGhaConnections.mockResolvedValue([]);
	mocks.listEnabledGithubWatches.mockResolvedValue([]);
	mocks.findGithubWatch.mockResolvedValue(null);
	mocks.appFindFirst.mockResolvedValue({ applicationId: "x" });
	mocks.composeFindFirst.mockResolvedValue({ composeId: "svc1" });
	mocks.pollWatch.mockResolvedValue(undefined);
	mocks.pollGhaConnection.mockResolvedValue(undefined);
});

describe("runGithubDeploymentsTick: which poll a watch gets", () => {
	it("a plain watch goes to the plain poll, a connection's watch to the connection poll", async () => {
		mocks.listGhaConnections.mockResolvedValue([connectionRow()]);
		mocks.listEnabledGithubWatches.mockResolvedValue([
			watchRecord({ watchId: "plain", serviceId: "other" }),
			watchRecord(),
		]);
		mocks.composeFindFirst.mockResolvedValue({ composeId: "x" });
		await poller.runGithubDeploymentsTick(deps());
		expect(mocks.pollWatch).toHaveBeenCalledTimes(1);
		expect(mocks.pollWatch.mock.calls[0]?.[0]).toMatchObject({
			watchId: "plain",
			ghaConnectionId: null,
		});
		expect(mocks.pollGhaConnection).toHaveBeenCalledTimes(1);
		expect(mocks.pollGhaConnection.mock.calls[0]?.[0]).toMatchObject({
			watchId: "w1",
			ghaConnectionId: "gc1",
		});
		expect(mocks.pollGhaConnection.mock.calls[0]?.[2]).toEqual({
			marker: "connection-deps",
		});
	});

	it("turns on the watch Connect left disabled, so its first poll baselines", async () => {
		mocks.listGhaConnections.mockResolvedValue([connectionRow()]);
		mocks.findGithubWatch.mockResolvedValue(watchRecord({ enabled: false }));
		await poller.runGithubDeploymentsTick(deps());
		expect(mocks.upsertGithubWatch).toHaveBeenCalledWith(
			expect.objectContaining({
				serviceType: "compose",
				serviceId: "svc1",
				owner: "acme",
				repo: "shop",
				environment: "production",
				enabled: true,
			}),
		);
	});

	it("leaves a watch that is already on alone", async () => {
		mocks.listGhaConnections.mockResolvedValue([connectionRow()]);
		mocks.findGithubWatch.mockResolvedValue(watchRecord());
		await poller.runGithubDeploymentsTick(deps());
		expect(mocks.upsertGithubWatch).not.toHaveBeenCalled();
	});

	it("polls a connection that is due and skips one polled a moment ago", async () => {
		mocks.listGhaConnections.mockResolvedValue([connectionRow()]);
		mocks.listEnabledGithubWatches.mockResolvedValue([
			watchRecord({ lastCheckedAt: new Date(NOW - 5_000) }),
		]);
		await poller.runGithubDeploymentsTick(deps());
		expect(mocks.pollGhaConnection).not.toHaveBeenCalled();

		mocks.listEnabledGithubWatches.mockResolvedValue([
			watchRecord({ lastCheckedAt: new Date(NOW - 30_000) }),
		]);
		await poller.runGithubDeploymentsTick(deps());
		expect(mocks.pollGhaConnection).toHaveBeenCalledTimes(1);
	});

	it("slows down to every two minutes after a day without a run or a release", async () => {
		mocks.listGhaConnections.mockResolvedValue([
			connectionRow({ lastActivityAt: new Date(NOW - 25 * 3_600_000) }),
		]);
		mocks.listEnabledGithubWatches.mockResolvedValue([
			watchRecord({ lastCheckedAt: new Date(NOW - 60_000) }),
		]);
		await poller.runGithubDeploymentsTick(deps());
		expect(mocks.pollGhaConnection).not.toHaveBeenCalled();
		mocks.listEnabledGithubWatches.mockResolvedValue([
			watchRecord({ lastCheckedAt: new Date(NOW - 125_000) }),
		]);
		await poller.runGithubDeploymentsTick(deps());
		expect(mocks.pollGhaConnection).toHaveBeenCalledTimes(1);
	});

	it("Check now polls an idle, just-polled connection on the next tick, once", async () => {
		mocks.listGhaConnections.mockResolvedValue([
			connectionRow({ lastActivityAt: new Date(NOW - 25 * 3_600_000) }),
		]);
		mocks.listEnabledGithubWatches.mockResolvedValue([
			watchRecord({ lastCheckedAt: new Date(NOW - 10_000) }),
		]);
		wakeGhaConnection("gc1");
		await poller.runGithubDeploymentsTick(deps());
		expect(mocks.pollGhaConnection).toHaveBeenCalledTimes(1);
		expect(mocks.pollGhaConnection.mock.calls[0]?.[3]).toEqual({ woken: true });
		await poller.runGithubDeploymentsTick(deps());
		expect(mocks.pollGhaConnection).toHaveBeenCalledTimes(1);
	});

	it("one connection failing does not stop the others", async () => {
		mocks.listGhaConnections.mockResolvedValue([
			connectionRow(),
			connectionRow({ ghaConnectionId: "gc2", serviceId: "svc2" }),
		]);
		mocks.listEnabledGithubWatches.mockResolvedValue([
			watchRecord(),
			watchRecord({ watchId: "w2", serviceId: "svc2" }),
		]);
		mocks.composeFindFirst.mockResolvedValue({ composeId: "x" });
		mocks.pollGhaConnection.mockRejectedValueOnce(new Error("boom"));
		const d = deps();
		await poller.runGithubDeploymentsTick(d);
		expect(mocks.pollGhaConnection).toHaveBeenCalledTimes(2);
	});

	it("when a service is gone, its watch and its connection go with it", async () => {
		mocks.listGhaConnections.mockResolvedValue([connectionRow()]);
		mocks.listEnabledGithubWatches.mockResolvedValue([watchRecord()]);
		mocks.composeFindFirst.mockResolvedValue(undefined);
		await poller.runGithubDeploymentsTick(deps());
		expect(mocks.deleteGithubWatch).toHaveBeenCalledWith("compose", "svc1");
		expect(mocks.deleteGhaConnection).toHaveBeenCalledWith("compose", "svc1");
		expect(mocks.pollGhaConnection).not.toHaveBeenCalled();
	});

	it("stops between watches once told to", async () => {
		mocks.listGhaConnections.mockResolvedValue([connectionRow()]);
		mocks.listEnabledGithubWatches.mockResolvedValue([watchRecord()]);
		await poller.runGithubDeploymentsTick(deps(), () => true);
		expect(mocks.pollGhaConnection).not.toHaveBeenCalled();
	});
});
