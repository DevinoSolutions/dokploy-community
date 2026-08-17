import { waitForSwarmServiceStable } from "@dokploy/server/utils/docker/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listTasksMock, infoMock, getRemoteDockerMock } = vi.hoisted(() => {
	const listTasks = vi.fn();
	const info = vi.fn();
	const getRemoteDocker = vi.fn(async () => ({ listTasks, info }));
	return {
		listTasksMock: listTasks,
		infoMock: info,
		getRemoteDockerMock: getRemoteDocker,
	};
});

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: getRemoteDockerMock,
}));

// Short window / poll to keep tests fast; mocked listTasks resolves instantly.
const WINDOW_MS = 400;
const POLL_MS = 20;

// Represents a task that pre-exists this deploy (outgoing task in a rolling
// update, or a leftover in Swarm's history). Its `CreatedAt` must be well
// before `pollStartMs = Date.now()` so the CreatedAt filter excludes it.
const PRE_EXISTING_TASK_AGE_MS = 7 * 60 * 60 * 1000;

type Task = {
	Status?: { State?: string; Err?: string; Message?: string };
	DesiredState?: string;
	CreatedAt?: string;
	UpdatedAt?: string;
};

const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const runningTask = (opts: Partial<Task> = {}): Task => ({
	Status: { State: "running" },
	DesiredState: "running",
	CreatedAt: now(),
	UpdatedAt: now(),
	...opts,
});

const startingTask = (opts: Partial<Task> = {}): Task => ({
	Status: { State: "starting" },
	DesiredState: "running",
	CreatedAt: now(),
	UpdatedAt: now(),
	...opts,
});

describe("waitForSwarmServiceStable", () => {
	beforeEach(() => {
		listTasksMock.mockReset();
		infoMock.mockReset();
		// Default: daemon clock in sync with ours. Individual tests override
		// with `infoMock.mockResolvedValue({ SystemTime: <skewed> })`.
		infoMock.mockResolvedValue({ SystemTime: new Date().toISOString() });
	});

	it("returns stable when a task reaches running and stays there", async () => {
		listTasksMock.mockResolvedValue([runningTask()]);

		const result = await waitForSwarmServiceStable("app", {
			windowMs: WINDOW_MS,
			pollMs: POLL_MS,
		});

		expect(result).toEqual({ stable: true });
	});

	it("does not false-positive when Swarm still lists the outgoing task as desired=running during the handover", async () => {
		// Real Swarm behavior during a rolling update (stop-first or start-first
		// alike): the outgoing task keeps `DesiredState=running` briefly while
		// the new task is being created — Swarm only flips it to `shutdown`
		// when it's about to stop it. If the DesiredState filter alone were
		// enough, the outgoing task would still be counted here and flip
		// `everRunning=true`; the subsequent poll (outgoing gone, incoming
		// still starting) would then trip the "restarted after running"
		// branch. The CreatedAt filter excludes tasks born long before the
		// poll started so only tasks from the current deploy contribute to
		// the running/starting counts.
		listTasksMock
			.mockResolvedValueOnce([
				runningTask({ CreatedAt: ago(PRE_EXISTING_TASK_AGE_MS) }),
				startingTask({
					Status: { State: "preparing" },
					CreatedAt: now(),
				}),
			])
			.mockResolvedValueOnce([
				{
					Status: { State: "shutdown" },
					DesiredState: "shutdown",
					CreatedAt: ago(PRE_EXISTING_TASK_AGE_MS),
					UpdatedAt: now(),
				},
				startingTask({ CreatedAt: now() }),
			])
			.mockResolvedValue([runningTask({ CreatedAt: now() })]);

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
		const failedAt = now();
		listTasksMock
			.mockResolvedValueOnce([
				runningTask({
					CreatedAt: ago(PRE_EXISTING_TASK_AGE_MS),
					UpdatedAt: ago(10),
				}),
				startingTask({
					Status: { State: "preparing" },
					CreatedAt: now(),
				}),
			])
			.mockResolvedValue([
				runningTask({ CreatedAt: ago(PRE_EXISTING_TASK_AGE_MS) }),
				{
					Status: { State: "rejected", Err: "No such image: broken:latest" },
					DesiredState: "shutdown",
					CreatedAt: now(),
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
		listTasksMock.mockResolvedValue([
			runningTask(),
			{
				Status: { State: "failed", Err: "stale failure" },
				DesiredState: "shutdown",
				CreatedAt: ago(60_000),
				UpdatedAt: ago(60_000),
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
			startingTask({
				Status: { State: "preparing", Message: "pulling image" },
			}),
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

	it("survives a remote daemon clock behind ours by anchoring to its clock", async () => {
		// The Swarm manager on a remote server can drift from the Dokploy host.
		// Comparing our `Date.now()` to `Task.CreatedAt` (stamped by the remote
		// daemon) would filter out genuinely-new tasks whose remote-stamped
		// CreatedAt trails ours by more than the leeway — so `active` stays
		// empty for the whole window and a healthy deploy times out as failed.
		// Anchoring the gates to `docker info -> SystemTime` fixes it.
		const SKEW_MS = 30_000;
		infoMock.mockResolvedValue({
			SystemTime: new Date(Date.now() - SKEW_MS).toISOString(),
		});
		// Task's CreatedAt uses the remote (skewed) clock.
		listTasksMock.mockResolvedValue([
			runningTask({ CreatedAt: new Date(Date.now() - SKEW_MS).toISOString() }),
		]);

		const result = await waitForSwarmServiceStable("app", {
			windowMs: WINDOW_MS,
			pollMs: POLL_MS,
		});

		expect(result).toEqual({ stable: true });
	});

	it("reports 'no tasks from this deployment' when only pre-existing tasks are visible", async () => {
		// Distinct from "task never reached running" (something exists but is
		// stuck starting): here nothing that belongs to this deploy is present
		// at all, e.g. the poll landed against a daemon that never received
		// the service update, or every task is filtered out as pre-existing.
		listTasksMock.mockResolvedValue([
			runningTask({ CreatedAt: ago(PRE_EXISTING_TASK_AGE_MS) }),
		]);

		const result = await waitForSwarmServiceStable("app", {
			windowMs: WINDOW_MS,
			pollMs: POLL_MS,
		});

		expect(result).toEqual({
			stable: false,
			reason: "No tasks from this deployment found",
		});
	});
});
