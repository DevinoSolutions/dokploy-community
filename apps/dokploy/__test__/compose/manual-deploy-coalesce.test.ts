import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-6139 / T-5168: a manual compose deploy or redeploy (the tRPC compose router)
 * coalesces the compose's waiting deploys before it queues, like the webhooks.
 *
 * The router, the helper and the in-memory queue are the real ones. Only the
 * build-policy gate is a stand-in: it keeps the real contract (nothing happens
 * with the policy off, `removeWaiting` runs through the real
 * `coalesceQueuedDeploy`, which swallows its failure) without the database.
 * The first job of every test never finishes, so it holds the one build slot
 * and every later job waits.
 */

const mocks = vi.hoisted(() => ({
	cloud: { value: false },
	enforced: { value: true },
	cloudDeploy: vi.fn(),
	findComposeById: vi.fn(),
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	audit: vi.fn(),
	gateCalls: [] as Array<Record<string, any>>,
	// How long the gate's audit write takes, to widen the gap between the
	// coalesce and the enqueue.
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
		findComposeById: mocks.findComposeById,
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

const { composeRouter } = await import("@/server/api/routers/compose");
const { myQueue } = await import("@/server/queues/queueSetup");
const caller = composeRouter.createCaller(
	ctx as Parameters<typeof composeRouter.createCaller>[0],
);

const flush = () => new Promise((r) => setTimeout(r, 0));

// A partition (server) per test, so tests do not share a build slot.
let partition = 0;
const serverId = () => `srv-${partition}`;

const useCompose = (overrides: Record<string, unknown> = {}) =>
	mocks.findComposeById.mockImplementation(async (id: string) => ({
		composeId: id,
		name: `stack-${id}`,
		environmentId: "env-1",
		watchPaths: null,
		composePath: "./docker-compose.yml",
		serverId: serverId(),
		...overrides,
	}));

const job = (
	composeId: string,
	titleLog: string,
	extra: Record<string, unknown> = {},
) => ({
	composeId,
	titleLog,
	descriptionLog: "",
	type: "deploy" as const,
	applicationType: "compose" as const,
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
	useCompose();
});

describe("compose.deploy", () => {
	it("folds a burst of manual deploys into one waiting job carrying the newest title", async () => {
		await occupySlot();

		await caller.deploy({ composeId: "c1", title: "first" });
		await caller.deploy({ composeId: "c1", title: "second" });
		const result = await caller.deploy({
			composeId: "c1",
			title: "third",
			description: "latest",
		});

		const queue = await waiting();
		expect(queue).toHaveLength(1);
		expect(queue[0]).toMatchObject({
			composeId: "c1",
			titleLog: "third",
			descriptionLog: "latest",
			type: "deploy",
		});
		expect(result).toMatchObject({ success: true, composeId: "c1" });
	});

	it("queues the first deploy normally: the job being added is never coalesced away", async () => {
		await occupySlot();

		await caller.deploy({ composeId: "c1", title: "only" });

		expect(await waitingTitles()).toEqual(["only"]);
		expect(mocks.gateCalls).toHaveLength(1);
	});

	it("keeps the waiting job's place in the queue", async () => {
		await occupySlot();
		await caller.deploy({ composeId: "c1", title: "old" });
		await myQueue.add("deployments", job("other", "other-stack"));

		await caller.deploy({ composeId: "c1", title: "new" });

		expect(await waitingTitles()).toEqual(["new", "other-stack"]);
	});

	it("hands the gate the unit and the exact job it would queue", async () => {
		await occupySlot();

		await caller.deploy({
			composeId: "c1",
			title: "t",
			description: "d",
			freshVolumes: true,
		});

		expect(mocks.gateCalls).toHaveLength(1);
		const call = mocks.gateCalls[0] as Record<string, any>;
		expect(call.unitType).toBe("compose");
		expect(call.unit).toMatchObject({
			unitId: "c1",
			unitName: "stack-c1",
			environmentId: "env-1",
		});
		expect(call).not.toHaveProperty("commitMessage");
		expect(call).not.toHaveProperty("changedFiles");
		expect((await waiting())[0]).toEqual({
			composeId: "c1",
			titleLog: "t",
			descriptionLog: "d",
			type: "deploy",
			applicationType: "compose",
			server: true,
			serverId: serverId(),
			freshVolumes: true,
		});
	});

	it("does not merge deploys with different freshVolumes", async () => {
		await occupySlot();
		await caller.deploy({ composeId: "c1", title: "plain" });

		await caller.deploy({
			composeId: "c1",
			title: "fresh",
			freshVolumes: true,
		});

		expect(await waitingTitles()).toEqual(["plain", "fresh"]);
	});

	it("leaves other composes, previews and the running job alone", async () => {
		await myQueue.add("deployments", job("c1", "running"));
		await flush();
		await myQueue.add("deployments", job("c2", "other-compose"));
		await myQueue.add(
			"deployments",
			job("c1", "preview", {
				applicationType: "compose-preview",
				previewDeploymentId: "pv-1",
			}),
		);
		await caller.deploy({ composeId: "c1", title: "a" });

		await caller.deploy({ composeId: "c1", title: "b" });

		expect(await waitingTitles()).toEqual(["other-compose", "preview", "b"]);
		const active = await myQueue.getJobs(["active"]);
		expect(
			active
				.map((queued) => queued.data as any)
				.filter((data) => data.serverId === serverId())
				.map((data) => data.titleLog),
		).toEqual(["running"]);
	});

	it("coalesces on the local queue too (a compose without a server)", async () => {
		useCompose({ serverId: null });
		await occupySlot({ serverId: undefined });

		await caller.deploy({ composeId: "c1", title: "l1" });
		await caller.deploy({ composeId: "c1", title: "l2" });

		const local = (await waiting()).filter(
			(queued) => queued.composeId === "c1",
		);
		expect(local.map((queued) => queued.titleLog)).toEqual(["l2"]);
		expect(local[0].server).toBe(false);
	});

	it("does nothing while the build policy is off, as on the webhook paths", async () => {
		mocks.enforced.value = false;
		await occupySlot();

		await caller.deploy({ composeId: "c1", title: "a" });
		await caller.deploy({ composeId: "c1", title: "b" });

		expect(await waitingTitles()).toEqual(["a", "b"]);
	});

	it("still queues the deploy when coalescing throws", async () => {
		await occupySlot();
		await caller.deploy({ composeId: "c1", title: "a" });
		vi.spyOn(console, "error").mockImplementation(() => {});
		const spy = vi
			.spyOn(myQueue, "coalesceWaiting")
			.mockImplementationOnce(() => {
				throw new Error("queue exploded");
			});

		const result = await caller.deploy({ composeId: "c1", title: "b" });

		spy.mockRestore();
		expect(result).toMatchObject({ success: true });
		expect(await waitingTitles()).toEqual(["a", "b"]);
	});

	it("a priority request is never folded into a waiting job", async () => {
		await occupySlot();
		await caller.deploy({ composeId: "c1", title: "waiting" });
		mocks.gateCalls.length = 0;

		await caller.deploy({ composeId: "c1", title: "urgent", priority: true });

		expect(mocks.gateCalls).toHaveLength(0);
		const titles = await waitingTitles();
		expect(titles).toContain("waiting");
		expect(titles).toContain("urgent");
	});

	it("skips the gate on Cloud with a server, where the deploy never queues", async () => {
		mocks.cloud.value = true;
		mocks.cloudDeploy.mockResolvedValue({});

		await caller.deploy({ composeId: "c1", title: "cloud" });

		expect(mocks.gateCalls).toHaveLength(0);
		expect(mocks.cloudDeploy).toHaveBeenCalledTimes(1);
	});
});

describe("compose.redeploy", () => {
	it("folds a burst of redeploys into one waiting job", async () => {
		await occupySlot();

		await caller.redeploy({ composeId: "c1", title: "r1" });
		await caller.redeploy({ composeId: "c1", title: "r2" });
		await caller.redeploy({ composeId: "c1", title: "r3" });

		const queue = await waiting();
		expect(queue).toHaveLength(1);
		expect(queue[0]).toMatchObject({ titleLog: "r3", type: "redeploy" });
	});

	it("never merges a redeploy with a waiting deploy, in either direction", async () => {
		await occupySlot();
		await caller.deploy({ composeId: "c1", title: "d1" });
		await caller.redeploy({ composeId: "c1", title: "r1" });
		await caller.deploy({ composeId: "c1", title: "d2" });
		await caller.redeploy({ composeId: "c1", title: "r2" });

		expect(
			(await waiting()).map((queued) => `${queued.type}:${queued.titleLog}`),
		).toEqual(["deploy:d2", "redeploy:r2"]);
	});

	it("a priority redeploy is not coalesced", async () => {
		await occupySlot();
		await caller.redeploy({ composeId: "c1", title: "r1" });
		mocks.gateCalls.length = 0;

		await caller.redeploy({ composeId: "c1", title: "r2", priority: true });

		expect(mocks.gateCalls).toHaveLength(0);
		expect(await waitingTitles()).toContain("r1");
	});

	it("skips the gate on Cloud with a server", async () => {
		mocks.cloud.value = true;
		mocks.cloudDeploy.mockResolvedValue({});

		await caller.redeploy({ composeId: "c1", title: "cloud" });

		expect(mocks.gateCalls).toHaveLength(0);
		expect(mocks.cloudDeploy).toHaveBeenCalledTimes(1);
	});
});

describe("audit", () => {
	it("a coalesced manual deploy is still audited for the caller", async () => {
		await occupySlot();
		await caller.deploy({ composeId: "c1", title: "a" });

		await caller.deploy({ composeId: "c1", title: "b" });

		expect(mocks.audit).toHaveBeenCalledTimes(2);
		expect(mocks.audit).toHaveBeenLastCalledWith(
			ctx,
			expect.objectContaining({
				action: "deploy",
				resourceType: "compose",
				resourceId: "c1",
			}),
		);
	});
});

describe("audit actor", () => {
	it("hands the gate the user behind the click, so a drop is not recorded as the system", async () => {
		await occupySlot();

		await caller.deploy({ composeId: "c1", title: "a" });
		await caller.redeploy({ composeId: "c1", title: "r" });

		expect(mocks.gateCalls).toHaveLength(2);
		for (const call of mocks.gateCalls) {
			expect(call.caller).toMatchObject({
				actor: {
					type: "user",
					userId: "user-1",
					email: "ops@example.com",
				},
			});
		}
	});

	it("names the API key or the admin impersonating, like the other cancel trail rows", async () => {
		await occupySlot();
		const keyed = composeRouter.createCaller({
			...ctx,
			session: {
				...ctx.session,
				apiKeyId: "key-1",
				impersonatedBy: "admin-9",
			},
		} as Parameters<typeof composeRouter.createCaller>[0]);

		await keyed.deploy({ composeId: "c1", title: "a" });

		expect(mocks.gateCalls[0]?.caller).toEqual({
			actor: {
				type: "api_key",
				userId: "user-1",
				email: "ops@example.com",
				apiKeyId: "key-1",
				oauthClientId: undefined,
			},
			impersonatedBy: "admin-9",
		});
	});
});

describe("two clicks at once", () => {
	// A waiting job on another server is dropped (removed > 0, merged false) and
	// the audit write is awaited before the request queues itself. A second click
	// in that gap used to find nothing waiting and queue too, leaving two.
	it("leaves one waiting job when a second click lands while the first is auditing its drop", async () => {
		useCompose({ serverId: serverId() });
		await occupySlot();
		await myQueue.add("deployments", {
			...job("slot", "old-server-slot"),
			serverId: `old-${serverId()}`,
		});
		await myQueue.add("deployments", {
			...job("c1", "stale", { server: true }),
			serverId: `old-${serverId()}`,
		});
		await flush();
		mocks.auditDelayMs.value = 20;

		await Promise.all([
			caller.deploy({ composeId: "c1", title: "click-1" }),
			caller.deploy({ composeId: "c1", title: "click-2" }),
		]);

		const mine = (await waiting()).filter(
			(queued) => queued.composeId === "c1",
		);
		expect(mine.map((queued) => queued.titleLog)).toEqual(["click-2"]);
	});

	it("does not let a failing request hold up the next click on the same compose", async () => {
		await occupySlot();
		const spy = vi
			.spyOn(myQueue, "add")
			.mockRejectedValueOnce(new Error("queue down"));

		const [first, second] = await Promise.allSettled([
			caller.deploy({ composeId: "c1", title: "bad" }),
			caller.deploy({ composeId: "c1", title: "good" }),
		]);

		spy.mockRestore();
		expect(first.status).toBe("rejected");
		expect(second.status).toBe("fulfilled");
		expect(await waitingTitles()).toEqual(["good"]);
	});
});
