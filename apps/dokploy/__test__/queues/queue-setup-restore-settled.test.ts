import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The boot restore flag the cancel of a registered GitHub Actions row reads (T-19913): the jobs the previous process
 * left waiting are not in the queue until the restore ran, so a cancel before that must not read "no job" as "no
 * deploy". The queue is the real one; the database, the journal and the worker are mocked as in
 * queue-setup-restore-lanes.test.ts.
 */

const boot = vi.hoisted(() => ({
	/** What the journal restore does, replaced per test. */
	restore: async (_queue: unknown): Promise<unknown> => ({
		restored: 0,
		interrupted: 0,
		dropped: 0,
	}),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	updateApplicationStatus: vi.fn(),
	updateCompose: vi.fn(),
	updatePreviewDeployment: vi.fn(),
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));
vi.mock("../../server/queues/concurrency", () => ({
	resolveBuildsConcurrency: () => 1,
}));
vi.mock("../../server/queues/deploy-lane", () => ({
	resolvePullConcurrency: () => 0,
	classifyDeployJob: () => "build",
}));
vi.mock("../../server/queues/deployments-queue", () => ({
	processDeploymentJob: () => new Promise(() => {}),
}));
vi.mock("../../server/queues/lifecycle", () => ({
	gateWorkerUntilRestored: (queue: { pause(): void; resume(): void }) => {
		queue.pause();
		return { open: () => queue.resume() };
	},
	registerShutdownHandler: () => {},
}));
vi.mock("../../server/queues/queue-journal", () => ({
	createQueueJournal: () => ({
		journal: undefined,
		restore: (queue: unknown) => boot.restore(queue),
	}),
	dbJournalStore: {},
}));
vi.mock("@dokploy/server/services/build-policy/webhook", () => ({
	isCoalescingEnforcedForUnit: async () => false,
}));

const SLOT = Symbol.for("dokploy.queuedDeployControl");

/** A fresh queue singleton for each test. */
const freshQueueSetup = async () => {
	vi.resetModules();
	delete (globalThis as { __dokployDeploymentQueue?: unknown })
		.__dokployDeploymentQueue;
	delete (globalThis as Record<symbol, unknown>)[SLOT];
	return import("../../server/queues/queueSetup");
};

beforeAll(async () => {
	await freshQueueSetup();
}, 120_000);

beforeEach(() => {
	boot.restore = async () => ({ restored: 0, interrupted: 0, dropped: 0 });
});

describe("the boot restore flag of the queue", () => {
	it("is false until the restore ran and true after it", async () => {
		const setup = await freshQueueSetup();
		expect(setup.myQueue.restoreSettled()).toBe(false);
		await setup.restoreQueuedDeployments();
		expect(setup.myQueue.restoreSettled()).toBe(true);
	});

	it("is true after a restore that failed, so a broken journal cannot hold cancels back", async () => {
		boot.restore = async () => {
			throw new Error("journal unreadable");
		};
		const setup = await freshQueueSetup();
		await expect(setup.restoreQueuedDeployments()).rejects.toThrow();
		expect(setup.myQueue.restoreSettled()).toBe(true);
	});

	it("is what the installed cancel control answers `starting` from", async () => {
		const setup = await freshQueueSetup();
		const control = (
			globalThis as unknown as Record<
				symbol,
				{ removeDeployOf: (id: string) => Promise<string> }
			>
		)[SLOT];
		expect(await control?.removeDeployOf("any")).toBe("starting");
		await setup.restoreQueuedDeployments();
		expect(await control?.removeDeployOf("any")).toBe("none");
	});
});
