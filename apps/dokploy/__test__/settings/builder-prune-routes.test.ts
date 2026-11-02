import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-12606: the routes that prune the builder cache or run `system prune` refuse
 * to start while builds run on the server (PRECONDITION_FAILED), unless forced,
 * and write an audit row before the prune starts.
 */
const mocks = vi.hoisted(() => ({
	audit: vi.fn(async () => undefined),
	order: [] as string[],
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return {
		...actual,
		isRootOrganization: vi.fn(async () => true),
		findServerById: vi.fn(async () => ({
			serverId: "srv-1",
			name: "devino-third",
			organizationId: "org-1",
			serverStatus: "active",
		})),
		countActiveDeploymentsOnHost: vi.fn(async () => 0),
		cleanupBuilders: vi.fn(async () => {
			mocks.order.push("cleanupBuilders");
		}),
		cleanupSystem: vi.fn(async () => {
			mocks.order.push("cleanupSystem");
		}),
		cleanupAll: vi.fn(async () => ({ aborted: false })),
	};
});

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");
const {
	cleanupAll,
	cleanupBuilders,
	cleanupSystem,
	countActiveDeploymentsOnHost,
} = await import("@dokploy/server");

const createCaller = createCallerFactory(appRouter);

const ownerCtx = {
	user: { id: "user-1", email: "owner@test.com", role: "owner" },
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never;

const BLOCKED =
	"Builder cache cleanup is blocked while 2 build(s) run on devino-third. It would pause every build for the whole prune. Retry when the server is idle.";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.order.length = 0;
	vi.mocked(countActiveDeploymentsOnHost).mockResolvedValue(0);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

const busy = () => vi.mocked(countActiveDeploymentsOnHost).mockResolvedValue(2);

describe("settings.cleanDockerBuilder", () => {
	it("prunes by age and audits first on an idle server", async () => {
		const caller = createCaller(ownerCtx);
		await caller.settings.cleanDockerBuilder({ serverId: "srv-1" });
		expect(cleanupBuilders).toHaveBeenCalledWith("srv-1", { all: false });
		expect(mocks.audit).toHaveBeenCalledWith(
			ownerCtx,
			expect.objectContaining({
				action: "delete",
				resourceType: "server",
				resourceId: "srv-1",
				resourceName: "devino-third",
				metadata: expect.objectContaining({
					operation: "settings.cleanDockerBuilder",
					force: false,
					all: false,
				}),
			}),
		);
		// The audit row exists before a prune that may never return.
		expect(mocks.audit.mock.invocationCallOrder[0] as number).toBeLessThan(
			vi.mocked(cleanupBuilders).mock.invocationCallOrder[0] as number,
		);
	});

	it("refuses while builds run, with no prune and no audit row", async () => {
		busy();
		const caller = createCaller(ownerCtx);
		await expect(
			caller.settings.cleanDockerBuilder({ serverId: "srv-1" }),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: BLOCKED,
		});
		expect(cleanupBuilders).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("runs when forced, warns, and audits the force and --all", async () => {
		busy();
		const caller = createCaller(ownerCtx);
		await caller.settings.cleanDockerBuilder({
			serverId: "srv-1",
			force: true,
			all: true,
		});
		expect(cleanupBuilders).toHaveBeenCalledWith("srv-1", { all: true });
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("forced on devino-third"),
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			ownerCtx,
			expect.objectContaining({
				metadata: expect.objectContaining({ force: true, all: true }),
			}),
		);
	});
});

describe("settings.cleanDockerPrune", () => {
	it("refuses while builds run, without touching docker", async () => {
		busy();
		const caller = createCaller(ownerCtx);
		await expect(
			caller.settings.cleanDockerPrune({ serverId: "srv-1" }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(cleanupSystem).not.toHaveBeenCalled();
		expect(cleanupBuilders).not.toHaveBeenCalled();
	});

	it("runs the system prune and the builder prune when idle", async () => {
		const caller = createCaller(ownerCtx);
		await caller.settings.cleanDockerPrune({ serverId: "srv-1" });
		expect(mocks.order).toEqual(["cleanupSystem", "cleanupBuilders"]);
		expect(cleanupSystem).toHaveBeenCalledWith("srv-1", { all: false });
		expect(cleanupBuilders).toHaveBeenCalledWith("srv-1", { all: false });
	});

	it("passes all to both prunes and records it in the audit row", async () => {
		const caller = createCaller(ownerCtx);
		await caller.settings.cleanDockerPrune({ serverId: "srv-1", all: true });
		expect(cleanupSystem).toHaveBeenCalledWith("srv-1", { all: true });
		expect(cleanupBuilders).toHaveBeenCalledWith("srv-1", { all: true });
		expect(mocks.audit).toHaveBeenCalledWith(
			ownerCtx,
			expect.objectContaining({
				metadata: expect.objectContaining({
					operation: "settings.cleanDockerPrune",
					all: true,
				}),
			}),
		);
	});
});

describe("settings.cleanAll", () => {
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("runs the whole cleanup on an idle server", async () => {
		const caller = createCaller(ownerCtx);
		const result = await caller.settings.cleanAll({ serverId: "srv-1" });
		await flush();
		expect(result.skipped).toEqual([]);
		expect(cleanupAll).toHaveBeenCalledWith("srv-1", { skip: [], all: false });
	});

	it("passes all through to the cleanup and the audit row", async () => {
		const caller = createCaller(ownerCtx);
		await caller.settings.cleanAll({ serverId: "srv-1", all: true });
		await flush();
		expect(cleanupAll).toHaveBeenCalledWith("srv-1", { skip: [], all: true });
		expect(mocks.audit).toHaveBeenCalledWith(
			ownerCtx,
			expect.objectContaining({
				metadata: expect.objectContaining({ all: true }),
			}),
		);
	});

	it("skips the image, builder and system steps with a note instead of failing", async () => {
		busy();
		const caller = createCaller(ownerCtx);
		const result = await caller.settings.cleanAll({ serverId: "srv-1" });
		await flush();
		expect(result.status).toBe("scheduled");
		expect(result.skipped).toEqual(["images", "builders", "system"]);
		expect(result.message).toContain("2 build(s) run on devino-third");
		expect(cleanupAll).toHaveBeenCalledWith("srv-1", {
			skip: ["images", "builders", "system"],
			all: false,
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			ownerCtx,
			expect.objectContaining({
				metadata: expect.objectContaining({
					operation: "settings.cleanAll",
					skipped: ["images", "builders", "system"],
				}),
			}),
		);
	});

	it("treats a failed build check as busy: skips those steps, runs the rest", async () => {
		vi.mocked(countActiveDeploymentsOnHost).mockRejectedValue(
			new Error("db down"),
		);
		const caller = createCaller(ownerCtx);
		const result = await caller.settings.cleanAll({ serverId: "srv-1" });
		await flush();
		expect(result.skipped).toEqual(["images", "builders", "system"]);
		expect(result.message).toContain("could not check the builds running");
		expect(cleanupAll).toHaveBeenCalledWith("srv-1", {
			skip: ["images", "builders", "system"],
			all: false,
		});
	});

	it("runs everything when forced", async () => {
		busy();
		const caller = createCaller(ownerCtx);
		await caller.settings.cleanAll({ serverId: "srv-1", force: true });
		await flush();
		expect(cleanupAll).toHaveBeenCalledWith("srv-1", { skip: [], all: false });
	});
});

describe("dockerDiskUsage.pruneBuildCache", () => {
	it("refuses while builds run", async () => {
		busy();
		const caller = createCaller(ownerCtx);
		await expect(
			caller.dockerDiskUsage.pruneBuildCache({}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(cleanupBuilders).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("prunes by age on an idle host and audits it", async () => {
		const caller = createCaller(ownerCtx);
		await caller.dockerDiskUsage.pruneBuildCache({});
		expect(cleanupBuilders).toHaveBeenCalledWith(undefined, { all: false });
		expect(mocks.audit).toHaveBeenCalledWith(
			ownerCtx,
			expect.objectContaining({
				resourceType: "server",
				resourceId: "local",
				metadata: expect.objectContaining({
					operation: "dockerDiskUsage.pruneBuildCache",
				}),
			}),
		);
	});

	it("passes force and all through", async () => {
		busy();
		const caller = createCaller(ownerCtx);
		await caller.dockerDiskUsage.pruneBuildCache({ force: true, all: true });
		expect(cleanupBuilders).toHaveBeenCalledWith(undefined, { all: true });
	});
});
