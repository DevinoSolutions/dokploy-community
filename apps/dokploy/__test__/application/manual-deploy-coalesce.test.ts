import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-6233: a manual application deploy or redeploy (the tRPC application
 * router) coalesces the application's waiting deploys before it queues, like
 * the application webhooks and, since T-6139, the manual compose path.
 *
 * The router, the helper and the in-memory queue are the real ones. Only the
 * build-policy gate is a stand-in: it keeps the real contract (nothing happens
 * with the policy off, `removeWaiting` runs through the real
 * `coalesceQueuedDeploy`) without the database. The first job of every test
 * never finishes, so it holds the one build slot and every later job waits.
 */

const mocks = vi.hoisted(() => ({
	cloud: { value: false },
	enforced: { value: true },
	cloudDeploy: vi.fn(),
	findApplicationById: vi.fn(),
	updateApplication: vi.fn(),
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	audit: vi.fn(),
	gateCalls: [] as Array<Record<string, any>>,
	auditDelayMs: { value: 0 },
}));

vi.mock("@dokploy/server", async () => {
	const { coalesceQueuedDeploy } = await vi.importActual<
		typeof import("@dokploy/server/services/build-policy/coalesce")
	>("@dokploy/server/services/build-policy/coalesce");
	return {
		get IS_CLOUD() {
			return mocks.cloud.value;
		},
		findApplicationById: mocks.findApplicationById,
		updateApplication: mocks.updateApplication,
		updateApplicationStatus: vi.fn(),
		updateCompose: vi.fn(),
		updatePreviewDeployment: vi.fn(),
		buildPolicyDeployGate: async (input: Record<string, any>) => {
			mocks.gateCalls.push(input);
			if (!mocks.enforced.value) return { deploy: true, coalesced: 0 };
			const { removed, merged } = await coalesceQueuedDeploy({
				unitType: input.unitType,
				unitId: input.unit.unitId,
				unitName: input.unit.unitName,
				organizationId: "org-1",
				removeWaiting: input.removeWaiting,
				recordAudit: async () => {
					if (mocks.auditDelayMs.value) {
						await new Promise((r) => setTimeout(r, mocks.auditDelayMs.value));
					}
				},
			});
			return merged
				? { deploy: true, coalesced: removed, merged: true }
				: { deploy: true, coalesced: removed };
		},
	};
});

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@dokploy/server/services/build-policy/webhook", () => ({
	isCoalescingEnforcedForUnit: async () => false,
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));
vi.mock("@/server/utils/deploy", () => ({ deploy: mocks.cloudDeploy }));
vi.mock("@/server/api/utils/cancel-audit", () => ({ auditCancel: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));
vi.mock("@/server/queues/concurrency", () => ({
	resolveBuildsConcurrency: () => 1,
}));
vi.mock("@/server/queues/deployments-queue", () => ({
	processDeploymentJob: () => new Promise(() => {}),
}));
vi.mock("@/server/queues/lifecycle", () => ({
	gateWorkerUntilRestored: () => ({ open: () => {} }),
	registerShutdownHandler: () => {},
}));
vi.mock("@/server/queues/queue-journal", () => ({
	createQueueJournal: () => ({
		journal: undefined,
		restore: async () => ({ restored: 0, interrupted: 0, dropped: 0 }),
	}),
	dbJournalStore: {},
}));

const ctx = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "ops@example.com", role: "admin" },
};

const { applicationRouter } = await import("@/server/api/routers/application");
const { myQueue } = await import("@/server/queues/queueSetup");
const caller = applicationRouter.createCaller(
	ctx as Parameters<typeof applicationRouter.createCaller>[0],
);

const flush = () => new Promise((r) => setTimeout(r, 0));

// A partition (server) per test, so tests do not share a build slot.
let partition = 0;
const serverId = () => `srv-${partition}`;

const useApplication = (overrides: Record<string, unknown> = {}) =>
	mocks.findApplicationById.mockImplementation(async (id: string) => ({
		applicationId: id,
		appName: `app-${id}`,
		name: `web-${id}`,
		environmentId: "env-1",
		watchPaths: null,
		sourceType: "github",
		serverId: serverId(),
		...overrides,
	}));

const job = (
	applicationId: string,
	titleLog: string,
	extra: Record<string, unknown> = {},
) => ({
	applicationId,
	titleLog,
	descriptionLog: "",
	type: "deploy" as const,
	applicationType: "application" as const,
	serverId: serverId(),
	...extra,
});

/** Puts a job in the partition's only slot; it never finishes. */
const occupySlot = async (extra: Record<string, unknown> = {}) => {
	await myQueue.add("deployments", job("slot", "running", extra));
	await flush();
};

const waiting = async () =>
	(await myQueue.getJobs(["waiting"])).map((queued) => queued.data as any);
const waitingTitles = async () =>
	(await waiting()).map((queued) => queued.titleLog);

beforeEach(() => {
	partition++;
	vi.clearAllMocks();
	mocks.gateCalls.length = 0;
	mocks.cloud.value = false;
	mocks.enforced.value = true;
	mocks.auditDelayMs.value = 0;
	mocks.checkPermission.mockResolvedValue(undefined);
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	myQueue.clearWaiting();
	useApplication();
});

describe("application.deploy", () => {
	it("folds a burst of manual deploys into one waiting job carrying the newest title", async () => {
		await occupySlot();

		await caller.deploy({ applicationId: "a1", title: "first" });
		await caller.deploy({ applicationId: "a1", title: "second" });
		await caller.deploy({
			applicationId: "a1",
			title: "third",
			description: "latest",
		});

		const queue = await waiting();
		expect(queue).toHaveLength(1);
		expect(queue[0]).toMatchObject({
			applicationId: "a1",
			titleLog: "third",
			descriptionLog: "latest",
			type: "deploy",
		});
	});

	it("queues the first deploy normally and hands the gate the unit and the exact job", async () => {
		await occupySlot();

		await caller.deploy({
			applicationId: "a1",
			title: "only",
			description: "d",
		});

		expect(mocks.gateCalls).toHaveLength(1);
		const call = mocks.gateCalls[0] as Record<string, any>;
		expect(call.unitType).toBe("application");
		expect(call.unit).toMatchObject({
			unitId: "a1",
			unitName: "web-a1",
			environmentId: "env-1",
		});
		expect(call).not.toHaveProperty("commitMessage");
		expect(call).not.toHaveProperty("changedFiles");
		expect(await waiting()).toEqual([
			{
				applicationId: "a1",
				titleLog: "only",
				descriptionLog: "d",
				type: "deploy",
				applicationType: "application",
				server: true,
				serverId: serverId(),
			},
		]);
	});

	it("leaves other applications, PR previews and the running job alone", async () => {
		await myQueue.add("deployments", job("a1", "running"));
		await flush();
		await myQueue.add("deployments", job("a2", "other-app"));
		await myQueue.add(
			"deployments",
			job("a1", "preview", {
				applicationType: "application-preview",
				previewDeploymentId: "pv-1",
			}),
		);
		await caller.deploy({ applicationId: "a1", title: "a" });

		await caller.deploy({ applicationId: "a1", title: "b" });

		expect(await waitingTitles()).toEqual(["other-app", "preview", "b"]);
		const active = await myQueue.getJobs(["active"]);
		expect(
			active
				.map((queued) => queued.data as any)
				.filter((data) => data.serverId === serverId())
				.map((data) => data.titleLog),
		).toEqual(["running"]);
	});

	it("does nothing while the build policy is off", async () => {
		mocks.enforced.value = false;
		await occupySlot();

		await caller.deploy({ applicationId: "a1", title: "a" });
		await caller.deploy({ applicationId: "a1", title: "b" });

		expect(await waitingTitles()).toEqual(["a", "b"]);
	});

	it("still queues the deploy when coalescing throws", async () => {
		await occupySlot();
		await caller.deploy({ applicationId: "a1", title: "a" });
		vi.spyOn(console, "error").mockImplementation(() => {});
		const spy = vi
			.spyOn(myQueue, "coalesceWaiting")
			.mockImplementationOnce(() => {
				throw new Error("queue exploded");
			});

		await caller.deploy({ applicationId: "a1", title: "b" });

		spy.mockRestore();
		expect(await waitingTitles()).toEqual(["a", "b"]);
	});

	it("a priority request is never folded into a waiting job", async () => {
		await occupySlot();
		await caller.deploy({ applicationId: "a1", title: "waiting" });
		mocks.gateCalls.length = 0;

		await caller.deploy({
			applicationId: "a1",
			title: "urgent",
			priority: true,
		});

		expect(mocks.gateCalls).toHaveLength(0);
		const titles = await waitingTitles();
		expect(titles).toContain("waiting");
		expect(titles).toContain("urgent");
	});

	it("skips the gate on Cloud with a server, where the deploy never queues", async () => {
		mocks.cloud.value = true;
		mocks.cloudDeploy.mockResolvedValue({});

		await caller.deploy({ applicationId: "a1", title: "cloud" });

		expect(mocks.gateCalls).toHaveLength(0);
		expect(mocks.cloudDeploy).toHaveBeenCalledTimes(1);
	});

	it("audits a coalesced deploy for the caller", async () => {
		await occupySlot();
		await caller.deploy({ applicationId: "a1", title: "a" });

		await caller.deploy({ applicationId: "a1", title: "b" });

		expect(mocks.audit).toHaveBeenCalledTimes(2);
		expect(mocks.audit).toHaveBeenLastCalledWith(
			ctx,
			expect.objectContaining({
				action: "deploy",
				resourceType: "application",
				resourceId: "a1",
			}),
		);
	});
});

describe("application.redeploy", () => {
	it("folds a burst of redeploys into one waiting job", async () => {
		await occupySlot();

		await caller.redeploy({ applicationId: "a1", title: "r1" });
		await caller.redeploy({ applicationId: "a1", title: "r2" });
		await caller.redeploy({ applicationId: "a1", title: "r3" });

		const queue = await waiting();
		expect(queue).toHaveLength(1);
		expect(queue[0]).toMatchObject({ titleLog: "r3", type: "redeploy" });
	});

	it("never merges a redeploy with a waiting deploy, in either direction", async () => {
		await occupySlot();
		await caller.deploy({ applicationId: "a1", title: "d1" });
		await caller.redeploy({ applicationId: "a1", title: "r1" });
		await caller.deploy({ applicationId: "a1", title: "d2" });
		await caller.redeploy({ applicationId: "a1", title: "r2" });

		expect(
			(await waiting()).map((queued) => `${queued.type}:${queued.titleLog}`),
		).toEqual(["deploy:d2", "redeploy:r2"]);
	});

	it("a priority redeploy is not coalesced", async () => {
		await occupySlot();
		await caller.redeploy({ applicationId: "a1", title: "r1" });
		mocks.gateCalls.length = 0;

		await caller.redeploy({
			applicationId: "a1",
			title: "r2",
			priority: true,
		});

		expect(mocks.gateCalls).toHaveLength(0);
		expect(await waitingTitles()).toContain("r1");
	});

	it("does nothing while the build policy is off", async () => {
		mocks.enforced.value = false;
		await occupySlot();

		await caller.redeploy({ applicationId: "a1", title: "r1" });
		await caller.redeploy({ applicationId: "a1", title: "r2" });

		expect(await waitingTitles()).toEqual(["r1", "r2"]);
	});

	it("skips the gate on Cloud with a server", async () => {
		mocks.cloud.value = true;
		mocks.cloudDeploy.mockResolvedValue({});

		await caller.redeploy({ applicationId: "a1", title: "cloud" });

		expect(mocks.gateCalls).toHaveLength(0);
		expect(mocks.cloudDeploy).toHaveBeenCalledTimes(1);
	});
});

describe("audit actor and double clicks", () => {
	it("hands the gate the user behind the click", async () => {
		await occupySlot();

		await caller.deploy({ applicationId: "a1", title: "a" });
		await caller.redeploy({ applicationId: "a1", title: "r" });

		expect(mocks.gateCalls).toHaveLength(2);
		for (const call of mocks.gateCalls) {
			expect(call.caller).toMatchObject({
				actor: { type: "user", userId: "user-1", email: "ops@example.com" },
			});
		}
	});

	it("leaves one waiting job when a second click lands while the first is auditing its drop", async () => {
		await occupySlot();
		await myQueue.add("deployments", {
			...job("slot", "old-server-slot"),
			serverId: `old-${serverId()}`,
		});
		await myQueue.add("deployments", {
			...job("a1", "stale"),
			serverId: `old-${serverId()}`,
		});
		await flush();
		mocks.auditDelayMs.value = 20;

		await Promise.all([
			caller.deploy({ applicationId: "a1", title: "click-1" }),
			caller.deploy({ applicationId: "a1", title: "click-2" }),
		]);

		const mine = (await waiting()).filter(
			(queued) => queued.applicationId === "a1",
		);
		expect(mine.map((queued) => queued.titleLog)).toEqual(["click-2"]);
	});
});
