import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A deploy call that carries the deploymentId of a registered GitHub Actions row continues that row, once, and only
 * when the row still fits. Anything else behaves as it always did: the deploy writes a row of its own.
 */

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	set: vi.fn(),
	returned: [] as unknown[][],
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { deployments: { findFirst: mocks.findFirst } },
		update: () => ({
			set: (values: Record<string, unknown>) => {
				mocks.set(values);
				return {
					where: () => ({
						returning: () => Promise.resolve(mocks.returned.shift() ?? []),
					}),
				};
			},
		}),
	},
}));

const {
	assertLiveBuildReference,
	endQueuedLiveBuild,
	requestLiveBuildDeploy,
	withdrawLiveBuildDeploy,
	canContinueLiveBuild,
	claimLiveGithubBuild,
	notWaitingForGithubRun,
} = await import("@dokploy/server/services/live-build-claim");

const live = (overrides: Record<string, unknown> = {}) => ({
	deploymentId: "dep-1",
	status: "running",
	buildOrigin: "github-actions",
	externalBuildOnly: true,
	buildRunStatus: "in_progress",
	applicationId: "app-1",
	composeId: null,
	serverId: null,
	buildServerId: null,
	logPath: "/logs/web/web.log",
	description: "",
	...overrides,
});

const claim = {
	deploymentId: "dep-1",
	kind: "application" as const,
	serviceId: "app-1",
	logHost: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.returned.length = 0;
});

describe("canContinueLiveBuild", () => {
	it("accepts a running GitHub Actions row of the same service that no deploy took over", () => {
		expect(canContinueLiveBuild(live(), claim)).toBe(true);
		expect(
			canContinueLiveBuild(live({ buildRunStatus: "queued" }), claim),
		).toBe(true);
	});

	it("also accepts it after its run finished: the deploy call may come late", () => {
		expect(
			canContinueLiveBuild(live({ buildRunStatus: "completed" }), claim),
		).toBe(true);
	});

	it.each([
		["a row of another service", { applicationId: "app-2" }],
		["a row that is not running", { status: "done" }],
		["a row that failed", { status: "error" }],
		["a row a deploy already took over", { externalBuildOnly: false }],
		["a row Dokploy built", { buildOrigin: "dokploy" }],
		["a row with no origin", { buildOrigin: null }],
		["a row without a log", { logPath: "" }],
	])("ignores %s", (_name, overrides) => {
		expect(canContinueLiveBuild(live(overrides), claim)).toBe(false);
	});

	it("looks at the compose column for a compose, and not at the application's", () => {
		const composeClaim = {
			...claim,
			kind: "compose" as const,
			serviceId: "c1",
		};
		expect(canContinueLiveBuild(live(), composeClaim)).toBe(false);
		expect(
			canContinueLiveBuild(
				live({ applicationId: null, composeId: "c1" }),
				composeClaim,
			),
		).toBe(true);
	});

	it("needs the log on the host the deploy appends to", () => {
		expect(
			canContinueLiveBuild(live({ serverId: "srv-1" }), {
				...claim,
				logHost: "srv-1",
			}),
		).toBe(true);
		expect(canContinueLiveBuild(live({ serverId: "srv-1" }), claim)).toBe(
			false,
		);
		// A build server holds the log when there is one.
		expect(
			canContinueLiveBuild(live({ serverId: "srv-1", buildServerId: "b-1" }), {
				...claim,
				logHost: "b-1",
			}),
		).toBe(true);
	});
});

describe("claimLiveGithubBuild", () => {
	it("takes the row over: no longer external-only, run state completed, same row, title kept", async () => {
		const row = live({
			title: "GHA production abc12345 [run 42.1]",
			startedAt: "2026-11-02T10:00:00Z",
		});
		mocks.findFirst.mockResolvedValue(row);
		mocks.returned.push([{ ...row, externalBuildOnly: false }]);

		const claimed = await claimLiveGithubBuild(claim, {
			title: "GHA production abc12345 [run 42.1]",
			description: "d",
		});

		expect(claimed?.deploymentId).toBe("dep-1");
		const set = mocks.set.mock.calls[0]?.[0];
		expect(set).toEqual({
			externalBuildOnly: false,
			buildRunStatus: "completed",
			buildRunStep: null,
			deployStartedAt: expect.any(String),
			description: "d",
		});
		// The registered title stays: the update never writes one.
		expect(set).not.toHaveProperty("title");
	});

	it("appends the deploy's description to the registered one", async () => {
		mocks.findFirst.mockResolvedValue(live({ description: "from the run" }));
		mocks.returned.push([live()]);
		await claimLiveGithubBuild(claim, { description: "Deployed by the run" });
		expect(mocks.set.mock.calls[0]?.[0].description).toBe(
			"from the run - Deployed by the run",
		);
	});

	it("leaves the description alone when the deploy brings none", async () => {
		mocks.findFirst.mockResolvedValue(live({ description: "from the run" }));
		mocks.returned.push([live()]);
		await claimLiveGithubBuild(claim, { title: "t", description: " " });
		expect(mocks.set.mock.calls[0]?.[0]).toEqual({
			externalBuildOnly: false,
			buildRunStatus: "completed",
			buildRunStep: null,
			deployStartedAt: expect.any(String),
		});
	});

	it("returns null, and writes nothing, for a row that does not fit", async () => {
		mocks.findFirst.mockResolvedValue(live({ applicationId: "app-2" }));
		expect(await claimLiveGithubBuild(claim)).toBeNull();
		mocks.findFirst.mockResolvedValue(live({ status: "done" }));
		expect(await claimLiveGithubBuild(claim)).toBeNull();
		mocks.findFirst.mockResolvedValue(undefined);
		expect(await claimLiveGithubBuild(claim)).toBeNull();
		expect(mocks.set).not.toHaveBeenCalled();
	});

	it("loses to a deploy that took the row first: the guarded update changes nothing", async () => {
		mocks.findFirst.mockResolvedValue(live());
		mocks.returned.push([]);
		expect(await claimLiveGithubBuild(claim, { title: "t" })).toBeNull();
	});
});

describe("assertLiveBuildReference", () => {
	const ref = {
		deploymentId: "dep-1",
		kind: "application" as const,
		serviceId: "app-1",
	};

	it("refuses an id that does not exist with a 400 that says what to send", async () => {
		mocks.findFirst.mockResolvedValue(undefined);
		await expect(assertLiveBuildReference(ref)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("does not exist"),
		});
	});

	it("refuses an id that belongs to another service, or to the other kind", async () => {
		mocks.findFirst.mockResolvedValue({
			applicationId: "app-2",
			composeId: null,
		});
		await expect(assertLiveBuildReference(ref)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("does not belong to this application"),
		});
		mocks.findFirst.mockResolvedValue({
			applicationId: null,
			composeId: "c1",
		});
		await expect(assertLiveBuildReference(ref)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("lets an id of this service through whatever became of its row", async () => {
		mocks.findFirst.mockResolvedValue({
			applicationId: "app-1",
			composeId: null,
		});
		await expect(assertLiveBuildReference(ref)).resolves.toBeUndefined();
		mocks.findFirst.mockResolvedValue({
			applicationId: null,
			composeId: "c1",
		});
		await expect(
			assertLiveBuildReference({ ...ref, kind: "compose", serviceId: "c1" }),
		).resolves.toBeUndefined();
	});
});

describe("requestLiveBuildDeploy (the mark a deploy call sets before it queues)", () => {
	const ref = {
		deploymentId: "dep-1",
		kind: "application" as const,
		serviceId: "app-1",
	};

	it("marks an open registered row of this service", async () => {
		mocks.findFirst.mockResolvedValue({
			applicationId: "app-1",
			composeId: null,
		});
		mocks.returned.push([{ deploymentId: "dep-1" }]);
		await expect(requestLiveBuildDeploy(ref)).resolves.toBeUndefined();
		expect(mocks.set.mock.calls[0]?.[0]).toEqual({
			deployQueuedAt: expect.any(String),
			buildRunStatus: "deploy_queued",
		});
	});

	it("keeps the 400 for an unknown id and does not write", async () => {
		mocks.findFirst.mockResolvedValue(undefined);
		await expect(requestLiveBuildDeploy(ref)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.set).not.toHaveBeenCalled();
	});

	it("answers 409 when the row can no longer be continued", async () => {
		mocks.findFirst.mockResolvedValue({
			applicationId: "app-1",
			composeId: null,
		});
		mocks.returned.push([]);
		await expect(requestLiveBuildDeploy(ref)).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("Retry without deploymentId"),
		});
	});

	it("withdraws the mark and ends a row whose deploy was removed", async () => {
		await withdrawLiveBuildDeploy("dep-1");
		expect(mocks.set.mock.calls[0]?.[0]).toEqual({
			deployQueuedAt: null,
			buildRunStatus: "in_progress",
		});
		mocks.returned.push([{ deploymentId: "dep-1" }]);
		expect(await endQueuedLiveBuild("dep-1", "cancelled", "gone")).toBe(true);
		expect(mocks.set.mock.calls[1]?.[0]).toMatchObject({
			status: "cancelled",
			errorMessage: "gone",
			buildRunStatus: "completed",
		});
		expect(await endQueuedLiveBuild("dep-1", "cancelled", "gone")).toBe(false);
	});
});

describe("notWaitingForGithubRun (the watchdog and restart exemption)", () => {
	it("keeps in every row that is not a registered row nothing took over", () => {
		if (!notWaitingForGithubRun) throw new Error("no condition");
		const { sql, params } = new PgDialect().sqlToQuery(notWaitingForGithubRun);
		expect(sql).toBe('"deployment"."externalBuildOnly" = $1');
		expect(params).toEqual([false]);
	});
});
