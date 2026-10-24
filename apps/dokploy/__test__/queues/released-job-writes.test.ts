import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryQueue } from "../../server/queues/in-memory-queue";
import type { DeploymentJob } from "../../server/queues/queue-types";

/**
 * A job whose slot the watchdog released keeps running in the background. Its
 * late status writes (done on the deployment, done on the service) must be
 * ignored, or they would overwrite the failure the watchdog recorded and the
 * status of a newer deploy of the same service.
 */

const mocks = vi.hoisted(() => ({
	update: vi.fn(),
	returning: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		update: (...args: unknown[]) => {
			mocks.update(...args);
			return {
				set: () => ({
					where: () => ({ returning: () => mocks.returning() }),
				}),
			};
		},
	},
}));

const { isReleasedJobContext, runInJobContext, skipWriteOfReleasedJob } =
	await import("@dokploy/server/utils/process/job-context");
const { markDeploymentDoneUnlessCancelled } = await import(
	"@dokploy/server/services/deployment-cancel"
);

const appJob = (applicationId: string): DeploymentJob => ({
	applicationId,
	titleLog: "deploy",
	descriptionLog: "",
	type: "deploy",
	applicationType: "application",
});

const deferred = () => {
	let resolve!: (value?: unknown) => void;
	const promise = new Promise<unknown>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	mocks.returning.mockResolvedValue([{ deploymentId: "dep-1" }]);
});

describe("job context", () => {
	it("is not released outside a job", () => {
		expect(isReleasedJobContext()).toBe(false);
		expect(skipWriteOfReleasedJob("x")).toBe(false);
	});

	it("reads the release flag live, across awaits", async () => {
		let released = false;
		const seen: boolean[] = [];

		await runInJobContext({ isReleased: () => released }, async () => {
			seen.push(isReleasedJobContext());
			released = true;
			await flush();
			seen.push(isReleasedJobContext());
		});

		expect(seen).toEqual([false, true]);
		// Back outside, nothing leaks.
		expect(isReleasedJobContext()).toBe(false);
	});

	it("logs what it skipped", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		runInJobContext({ isReleased: () => true }, () => {
			expect(skipWriteOfReleasedJob("the status of deployment d1")).toBe(true);
		});

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("the status of deployment d1"),
		);
	});
});

describe("the queue runs every job in its context", () => {
	it("a job sees released only after its slot was released", async () => {
		const hung = deferred();
		const seen: boolean[] = [];
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
		queue.process(async () => {
			seen.push(isReleasedJobContext());
			await hung.promise;
			seen.push(isReleasedJobContext());
		});
		await queue.add(appJob("a"));
		await flush();
		const [active] = await queue.getJobs(["active"]);

		queue.releaseActive(active?.id as string);
		hung.resolve();
		await flush();

		expect(seen).toEqual([false, true]);
	});

	it("a job that finishes on its own is never seen as released", async () => {
		const seen: boolean[] = [];
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
		queue.process(async () => {
			await flush();
			seen.push(isReleasedJobContext());
		});
		await queue.add(appJob("a"));
		await flush();
		await flush();

		expect(seen).toEqual([false]);
	});

	it("the next job of the service is not affected by the released one", async () => {
		const hung = deferred();
		const next = deferred();
		const seen: Array<[string, boolean]> = [];
		let calls = 0;
		const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
		queue.process(async (job) => {
			calls++;
			const name = `run-${calls}`;
			await (calls === 1 ? hung.promise : next.promise);
			seen.push([name, isReleasedJobContext()]);
			return job;
		});
		await queue.add(appJob("a"));
		await queue.add(appJob("a"));
		await flush();
		const [first] = await queue.getJobs(["active"]);
		queue.releaseActive(first?.id as string);
		await flush();

		hung.resolve();
		next.resolve();
		await flush();

		expect(seen).toEqual([
			["run-1", true],
			["run-2", false],
		]);
	});
});

describe("late success of a released job", () => {
	it("does not mark the deployment done", async () => {
		const result = await runInJobContext({ isReleased: () => true }, () =>
			markDeploymentDoneUnlessCancelled("dep-1"),
		);

		expect(result).toBe(false);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("still marks it done for a job that holds its slot, and outside any job", async () => {
		const inJob = await runInJobContext({ isReleased: () => false }, () =>
			markDeploymentDoneUnlessCancelled("dep-1"),
		);
		const outside = await markDeploymentDoneUnlessCancelled("dep-1");

		expect(inJob).toBe(true);
		expect(outside).toBe(true);
		expect(mocks.update).toHaveBeenCalledTimes(2);
	});
});

describe("a deployment whose job was released", () => {
	it("refuses its writes by id, even outside the job's context", async () => {
		const { markDeploymentReleased, isDeploymentReleased } = await import(
			"@dokploy/server/utils/process/job-context"
		);
		markDeploymentReleased("dep-late");

		expect(isDeploymentReleased("dep-late")).toBe(true);
		expect(isDeploymentReleased("dep-other")).toBe(false);
		expect(await markDeploymentDoneUnlessCancelled("dep-late")).toBe(false);
		expect(mocks.update).not.toHaveBeenCalled();
		// Another deployment of the same service is not affected.
		expect(await markDeploymentDoneUnlessCancelled("dep-other")).toBe(true);
	});

	it("skipWriteOfReleasedJob checks the id only when one is given", async () => {
		const { markDeploymentReleased } = await import(
			"@dokploy/server/utils/process/job-context"
		);
		markDeploymentReleased("dep-x");

		expect(skipWriteOfReleasedJob("the status of the service")).toBe(false);
		expect(
			skipWriteOfReleasedJob("the status of deployment dep-x", "dep-x"),
		).toBe(true);
	});

	it("remembers a bounded number of deployments, oldest first out", async () => {
		const { markDeploymentReleased, isDeploymentReleased } = await import(
			"@dokploy/server/utils/process/job-context"
		);
		for (let i = 0; i < 600; i++) markDeploymentReleased(`bulk-${i}`);

		expect(isDeploymentReleased("bulk-0")).toBe(false);
		expect(isDeploymentReleased("bulk-599")).toBe(true);
	});
});
