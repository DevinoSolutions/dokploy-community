import { waitForSwarmServiceStable } from "@dokploy/server/utils/docker/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listTasksMock, getRemoteDockerMock } = vi.hoisted(() => {
	const listTasks = vi.fn();
	const getRemoteDocker = vi.fn(async () => ({ listTasks }));
	return { listTasksMock: listTasks, getRemoteDockerMock: getRemoteDocker };
});

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: getRemoteDockerMock,
}));

// Short window / poll to keep tests fast; mocked listTasks resolves instantly.
const WINDOW_MS = 400;
const POLL_MS = 20;

type Task = {
	Status?: { State?: string; Err?: string; Message?: string };
	DesiredState?: string;
	UpdatedAt?: string;
};

const runningTask = (opts: Partial<Task> = {}): Task => ({
	Status: { State: "running" },
	DesiredState: "running",
	UpdatedAt: new Date().toISOString(),
	...opts,
});

const startingTask = (opts: Partial<Task> = {}): Task => ({
	Status: { State: "starting" },
	DesiredState: "running",
	UpdatedAt: new Date().toISOString(),
	...opts,
});

describe("waitForSwarmServiceStable", () => {
	beforeEach(() => {
		listTasksMock.mockReset();
	});

	it("returns stable when a task reaches running and stays there", async () => {
		listTasksMock.mockResolvedValue([runningTask()]);

		const result = await waitForSwarmServiceStable("app", {
			windowMs: WINDOW_MS,
			pollMs: POLL_MS,
		});

		expect(result).toEqual({ stable: true });
	});

	it("does not false-positive on the rolling-update handover between two tasks", async () => {
		// The outgoing task is already marked for shutdown by Swarm, so it must
		// be ignored for the running/starting counts. The incoming task is
		// still starting when the outgoing one disappears — without the
		// DesiredState filter this used to flip `everRunning=true` from the
		// outgoing task and then fire "Container restarted after running".
		listTasksMock
			.mockResolvedValueOnce([
				{
					Status: { State: "running" },
					DesiredState: "shutdown",
					UpdatedAt: new Date().toISOString(),
				},
				startingTask({ Status: { State: "preparing" } }),
			])
			.mockResolvedValueOnce([
				{
					Status: { State: "shutdown" },
					DesiredState: "shutdown",
					UpdatedAt: new Date().toISOString(),
				},
				startingTask(),
			])
			.mockResolvedValue([runningTask()]);

		const result = await waitForSwarmServiceStable("app", {
			windowMs: WINDOW_MS,
			pollMs: POLL_MS,
		});

		expect(result).toEqual({ stable: true });
	});

	it("catches a crash-looping new task even after Swarm starts a rollback", async () => {
		// Scenario the fork maintainer flagged: the new task fails, Swarm
		// moves its DesiredState to "shutdown" and starts a rollback task.
		// The `desired-state=running` filter alone would hide the failure and
		// mark the deploy stable while the new image never ran successfully.
		const failedAt = new Date().toISOString();
		listTasksMock
			.mockResolvedValueOnce([
				runningTask({
					DesiredState: "running",
					UpdatedAt: new Date(Date.now() - 10).toISOString(),
				}),
				startingTask({ Status: { State: "preparing" } }),
			])
			.mockResolvedValue([
				runningTask(),
				{
					Status: { State: "rejected", Err: "No such image: broken:latest" },
					DesiredState: "shutdown",
					UpdatedAt: failedAt,
				},
			]);

		const result = await waitForSwarmServiceStable("app", {
			windowMs: WINDOW_MS,
			pollMs: POLL_MS,
		});

		expect(result).toEqual({
			stable: false,
			reason: "Task rejected: No such image: broken:latest",
		});
	});

	it("ignores stale failed tasks from previous deploys still in Swarm history", async () => {
		// Swarm keeps a few historical tasks per service. A failure from a
		// previous deploy has UpdatedAt older than pollStartMs and must not
		// trigger a false negative for the current deploy.
		const staleFailed = new Date(Date.now() - 60_000).toISOString();
		listTasksMock.mockResolvedValue([
			runningTask(),
			{
				Status: { State: "failed", Err: "stale failure" },
				DesiredState: "shutdown",
				UpdatedAt: staleFailed,
			},
		]);

		const result = await waitForSwarmServiceStable("app", {
			windowMs: WINDOW_MS,
			pollMs: POLL_MS,
		});

		expect(result).toEqual({ stable: true });
	});

	it("returns unstable with lastReason when the task never reaches running", async () => {
		listTasksMock.mockResolvedValue([
			startingTask({ Status: { State: "preparing", Message: "pulling image" } }),
		]);

		const result = await waitForSwarmServiceStable("app", {
			windowMs: WINDOW_MS,
			pollMs: POLL_MS,
		});

		expect(result.stable).toBe(false);
		if (result.stable === false) {
			expect(result.reason).toContain("preparing");
			expect(result.reason).toContain("pulling image");
		}
	});
});
