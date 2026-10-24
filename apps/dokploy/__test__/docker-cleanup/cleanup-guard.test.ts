import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-7344: the nightly cleanup deleted a freshly built image in the middle of a
 * registry push. The guard checks the host for running or queued deployments
 * (a build server counts for the builds it runs) and holds the cleanup back.
 */

const mocks = vi.hoisted(() => ({
	runningRows: vi.fn(),
	applications: vi.fn(),
	composes: vi.fn(),
	queueJobs: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			deployments: { findMany: mocks.runningRows },
			applications: { findMany: mocks.applications },
			compose: { findMany: mocks.composes },
		},
	},
}));

vi.mock("@dokploy/server/services/deployment-queue-journal", () => ({
	listQueueJobs: mocks.queueJobs,
}));

import {
	countActiveDeploymentsOnHost,
	DOCKER_CLEANUP_MAX_WAIT_MS,
	DOCKER_CLEANUP_RETRY_MS,
	runDockerCleanupWhenIdle,
} from "@dokploy/server/utils/docker/cleanup-guard";

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	mocks.runningRows.mockReset().mockResolvedValue([]);
	mocks.applications.mockReset().mockResolvedValue([]);
	mocks.composes.mockReset().mockResolvedValue([]);
	mocks.queueJobs.mockReset().mockResolvedValue([]);
});

const logged = () =>
	vi.mocked(console.log).mock.calls.map((call) => String(call[0]));

describe("countActiveDeploymentsOnHost", () => {
	it("is 0 on an idle host", async () => {
		expect(await countActiveDeploymentsOnHost("srv-a")).toBe(0);
		expect(await countActiveDeploymentsOnHost(null)).toBe(0);
	});

	it("counts a running deployment on the host it runs on", async () => {
		mocks.runningRows.mockResolvedValue([
			{
				serverId: "srv-a",
				buildServerId: null,
				application: null,
				compose: null,
			},
		]);
		expect(await countActiveDeploymentsOnHost("srv-a")).toBe(1);
		expect(await countActiveDeploymentsOnHost("srv-b")).toBe(0);
		expect(await countActiveDeploymentsOnHost(null)).toBe(0);
	});

	it("counts a deployment with no server as running on the Dokploy server", async () => {
		mocks.runningRows.mockResolvedValue([
			{ serverId: null, buildServerId: null, application: null, compose: null },
		]);
		expect(await countActiveDeploymentsOnHost(null)).toBe(1);
		expect(await countActiveDeploymentsOnHost(undefined)).toBe(1);
		expect(await countActiveDeploymentsOnHost("srv-a")).toBe(0);
	});

	it("counts a build on a build server for that build server", async () => {
		// An application deployed to srv-a, built on build server bld-1.
		mocks.runningRows.mockResolvedValue([
			{
				serverId: "srv-a",
				buildServerId: "bld-1",
				application: { serverId: "srv-a", buildServerId: "bld-1" },
				compose: null,
			},
		]);
		expect(await countActiveDeploymentsOnHost("bld-1")).toBe(1);
		expect(await countActiveDeploymentsOnHost("srv-a")).toBe(1);
		expect(await countActiveDeploymentsOnHost("srv-c")).toBe(0);
	});

	it("takes a compose deployment's build server from the compose, not the row", async () => {
		// createDeploymentCompose records the serving server only, so the build
		// server has to come from the compose itself.
		mocks.runningRows.mockResolvedValue([
			{
				serverId: "srv-a",
				buildServerId: null,
				application: null,
				compose: { serverId: "srv-a", buildServerId: "bld-1" },
			},
		]);
		expect(await countActiveDeploymentsOnHost("bld-1")).toBe(1);
		expect(await countActiveDeploymentsOnHost("srv-a")).toBe(1);
		expect(await countActiveDeploymentsOnHost("bld-2")).toBe(0);
	});

	it("counts queued and starting jobs from the queue journal by their service's hosts", async () => {
		mocks.queueJobs.mockResolvedValue([
			{ payload: { applicationType: "application", applicationId: "app-1" } },
			{ payload: { applicationType: "compose", composeId: "cmp-1" } },
			{ payload: { applicationType: "compose", composeId: "cmp-local" } },
		]);
		mocks.applications.mockResolvedValue([
			{ applicationId: "app-1", serverId: "srv-a", buildServerId: null },
		]);
		mocks.composes.mockResolvedValue([
			{ composeId: "cmp-1", serverId: "srv-b", buildServerId: "bld-1" },
			{ composeId: "cmp-local", serverId: null, buildServerId: null },
		]);

		expect(await countActiveDeploymentsOnHost("srv-a")).toBe(1);
		expect(await countActiveDeploymentsOnHost("srv-b")).toBe(1);
		// bld-1 is only the build server of cmp-1.
		expect(await countActiveDeploymentsOnHost("bld-1")).toBe(1);
		expect(await countActiveDeploymentsOnHost(null)).toBe(1);
		expect(await countActiveDeploymentsOnHost("srv-z")).toBe(0);
	});

	it("ignores queue journal rows older than 12 hours, like stale running rows", async () => {
		const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000);
		mocks.queueJobs.mockResolvedValue([
			{
				enqueuedAt: hoursAgo(30),
				payload: { applicationType: "application", applicationId: "stuck" },
			},
			{
				enqueuedAt: hoursAgo(1),
				payload: { applicationType: "application", applicationId: "fresh" },
			},
		]);
		mocks.applications.mockResolvedValue([
			{ applicationId: "stuck", serverId: "srv-a", buildServerId: null },
			{ applicationId: "fresh", serverId: "srv-a", buildServerId: null },
		]);
		expect(await countActiveDeploymentsOnHost("srv-a")).toBe(1);

		mocks.queueJobs.mockResolvedValue([
			{
				enqueuedAt: hoursAgo(30),
				payload: { applicationType: "application", applicationId: "stuck" },
			},
		]);
		expect(await countActiveDeploymentsOnHost("srv-a")).toBe(0);
	});

	it("ignores a queued job whose service no longer exists", async () => {
		mocks.queueJobs.mockResolvedValue([
			{ payload: { applicationType: "application", applicationId: "gone" } },
			{ payload: {} },
		]);
		expect(await countActiveDeploymentsOnHost(null)).toBe(0);
	});

	it("adds up running deployments and queued jobs", async () => {
		mocks.runningRows.mockResolvedValue([
			{
				serverId: "srv-a",
				buildServerId: null,
				application: null,
				compose: null,
			},
			{
				serverId: "srv-a",
				buildServerId: null,
				application: null,
				compose: null,
			},
		]);
		mocks.queueJobs.mockResolvedValue([
			{ payload: { applicationType: "application", applicationId: "app-1" } },
		]);
		mocks.applications.mockResolvedValue([
			{ applicationId: "app-1", serverId: "srv-a", buildServerId: null },
		]);
		expect(await countActiveDeploymentsOnHost("srv-a")).toBe(3);
	});
});

describe("runDockerCleanupWhenIdle", () => {
	const setup = (counts: Array<number | Error>) => {
		const run = vi.fn();
		const sleep = vi.fn().mockResolvedValue(undefined);
		let call = 0;
		const countActive = vi.fn(async () => {
			const next = counts[Math.min(call++, counts.length - 1)] as
				| number
				| Error;
			if (next instanceof Error) throw next;
			return next;
		});
		return { run, sleep, countActive };
	};

	it("runs straight away when the host is idle", async () => {
		const { run, sleep, countActive } = setup([0]);
		const outcome = await runDockerCleanupWhenIdle({
			serverId: "srv-a",
			hostLabel: "server a",
			run,
			sleep,
			countActive,
		});
		expect(outcome).toBe("ran");
		expect(run).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
		expect(countActive).toHaveBeenCalledWith("srv-a");
	});

	it("defers while a deployment is active, logs it, and runs once the host is idle", async () => {
		const { run, sleep, countActive } = setup([2, 1, 0]);
		const outcome = await runDockerCleanupWhenIdle({
			serverId: "srv-a",
			hostLabel: "server a (srv-a)",
			run,
			sleep,
			countActive,
		});
		expect(outcome).toBe("ran");
		expect(run).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(15 * 60 * 1000);
		expect(logged()).toContain(
			"Docker cleanup deferred: 2 deployment(s) active on server a (srv-a)",
		);
		expect(logged()).toContain(
			"Docker cleanup deferred: 1 deployment(s) active on server a (srv-a)",
		);
	});

	it("checks the Dokploy server with no serverId", async () => {
		const { run, sleep, countActive } = setup([0]);
		await runDockerCleanupWhenIdle({
			hostLabel: "the Dokploy server",
			run,
			sleep,
			countActive,
		});
		expect(countActive).toHaveBeenCalledWith(undefined);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("gives up after 3 hours without ever running, then logs it", async () => {
		expect(DOCKER_CLEANUP_RETRY_MS).toBe(15 * 60 * 1000);
		expect(DOCKER_CLEANUP_MAX_WAIT_MS).toBe(3 * 60 * 60 * 1000);
		const { run, sleep, countActive } = setup([1]);
		const outcome = await runDockerCleanupWhenIdle({
			serverId: "srv-a",
			hostLabel: "server a",
			run,
			sleep,
			countActive,
		});
		expect(outcome).toBe("gave-up");
		expect(run).not.toHaveBeenCalled();
		// Checks at 0, 15, ... 180 minutes: 13 checks, 12 waits of 15 minutes.
		expect(countActive).toHaveBeenCalledTimes(13);
		expect(sleep).toHaveBeenCalledTimes(12);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("Docker cleanup skipped on server a"),
		);
	});

	it("still runs when the host goes idle on the last check", async () => {
		const { run, sleep, countActive } = setup([...Array(12).fill(1), 0]);
		const outcome = await runDockerCleanupWhenIdle({
			serverId: "srv-a",
			hostLabel: "server a",
			run,
			sleep,
			countActive,
		});
		expect(outcome).toBe("ran");
		expect(countActive).toHaveBeenCalledTimes(13);
	});

	it("treats a failed check as busy and never runs on it", async () => {
		const { run, sleep, countActive } = setup([new Error("db down"), 0]);
		const outcome = await runDockerCleanupWhenIdle({
			serverId: "srv-a",
			hostLabel: "server a",
			run,
			sleep,
			countActive,
		});
		expect(outcome).toBe("ran");
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(logged()).toContain(
			"Docker cleanup deferred: could not check active deployments on server a",
		);

		const failing = setup([new Error("db down")]);
		expect(
			await runDockerCleanupWhenIdle({
				serverId: "srv-a",
				hostLabel: "server a",
				...failing,
			}),
		).toBe("gave-up");
		expect(failing.run).not.toHaveBeenCalled();
	});

	it("stops waiting when the job was cancelled or replaced", async () => {
		const { run, sleep, countActive } = setup([1]);
		let alive = true;
		sleep.mockImplementation(async () => {
			alive = false;
		});
		const outcome = await runDockerCleanupWhenIdle({
			serverId: "srv-a",
			hostLabel: "server a",
			run,
			sleep,
			countActive,
			shouldContinue: () => alive,
		});
		expect(outcome).toBe("superseded");
		expect(run).not.toHaveBeenCalled();
		expect(countActive).toHaveBeenCalledTimes(1);
	});

	it("does not start a second wait on a host that is already waiting", async () => {
		let release: () => void = () => {};
		const first = setup([1, 0]);
		first.sleep.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const firstRun = runDockerCleanupWhenIdle({
			serverId: "srv-a",
			hostLabel: "server a",
			...first,
		});
		// Let the first call reach its sleep.
		await vi.waitFor(() => expect(first.sleep).toHaveBeenCalled());

		const second = setup([0]);
		const outcome = await runDockerCleanupWhenIdle({
			serverId: "srv-a",
			hostLabel: "server a",
			...second,
		});
		expect(outcome).toBe("already-waiting");
		expect(second.run).not.toHaveBeenCalled();

		// Another host is independent.
		const other = setup([0]);
		expect(
			await runDockerCleanupWhenIdle({
				serverId: "srv-b",
				hostLabel: "server b",
				...other,
			}),
		).toBe("ran");

		release();
		expect(await firstRun).toBe("ran");
		// The slot is free again afterwards.
		const again = setup([0]);
		expect(
			await runDockerCleanupWhenIdle({
				serverId: "srv-a",
				hostLabel: "server a",
				...again,
			}),
		).toBe("ran");
	});

	it("lets a build on a build server hold back that build server's cleanup only", async () => {
		// End to end through the real counter: srv-a builds on bld-1.
		mocks.runningRows.mockResolvedValue([
			{
				serverId: "srv-a",
				buildServerId: "bld-1",
				application: { serverId: "srv-a", buildServerId: "bld-1" },
				compose: null,
			},
		]);
		const busy = { run: vi.fn(), sleep: vi.fn().mockResolvedValue(undefined) };
		expect(
			await runDockerCleanupWhenIdle({
				serverId: "bld-1",
				hostLabel: "build server",
				...busy,
			}),
		).toBe("gave-up");
		expect(busy.run).not.toHaveBeenCalled();

		const idle = { run: vi.fn(), sleep: vi.fn().mockResolvedValue(undefined) };
		expect(
			await runDockerCleanupWhenIdle({
				serverId: "srv-c",
				hostLabel: "server c",
				...idle,
			}),
		).toBe("ran");
		expect(idle.run).toHaveBeenCalledTimes(1);
	});
});
