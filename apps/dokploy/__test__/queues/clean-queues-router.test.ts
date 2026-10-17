import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `application.cleanQueues` / `compose.cleanQueues` take an optional `mode`.
 * Omitting it is the old "drop every waiting job" behaviour (and the old
 * return value); "keepOldest" keeps the earliest waiting job of each type.
 */

const mocks = vi.hoisted(() => ({
	checkServicePermissionAndAccess: vi.fn(async () => undefined),
	cleanQueuesByApplication: vi.fn(async () => 3),
	cleanQueuesByCompose: vi.fn(async () => 3),
	keepOldestQueuesByApplication: vi.fn(),
	keepOldestQueuesByCompose: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("@dokploy/server", () => ({ IS_CLOUD: false }));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanQueuesByApplication: mocks.cleanQueuesByApplication,
	cleanQueuesByCompose: mocks.cleanQueuesByCompose,
	keepOldestQueuesByApplication: mocks.keepOldestQueuesByApplication,
	keepOldestQueuesByCompose: mocks.keepOldestQueuesByCompose,
	killDockerBuild: vi.fn(),
	myQueue: { add: vi.fn() },
}));

const ctx = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
};

const { composeRouter } = await import("@/server/api/routers/compose");
const { applicationRouter } = await import("@/server/api/routers/application");
const { createTRPCRouter } = await import("@/server/api/trpc");
const { buildMcpToolRegistry } = await import("@/server/mcp/registry");

const composeCaller = composeRouter.createCaller(
	ctx as Parameters<typeof composeRouter.createCaller>[0],
);
const applicationCaller = applicationRouter.createCaller(
	ctx as Parameters<typeof applicationRouter.createCaller>[0],
);

const result = {
	kept: [
		{ jobId: "j1", enqueuedAt: "2026-10-17T00:00:00.000Z", type: "deploy" },
	],
	removed: [
		{ jobId: "j2", enqueuedAt: "2026-10-17T00:00:01.000Z", type: "deploy" },
	],
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.keepOldestQueuesByApplication.mockResolvedValue(result);
	mocks.keepOldestQueuesByCompose.mockResolvedValue(result);
});

describe("application.cleanQueues", () => {
	it("without a mode drops everything, as before", async () => {
		const out = await applicationCaller.cleanQueues({ applicationId: "a1" });

		expect(mocks.cleanQueuesByApplication).toHaveBeenCalledWith("a1");
		expect(mocks.keepOldestQueuesByApplication).not.toHaveBeenCalled();
		expect(out).toBeUndefined();
	});

	it('mode "all" is the same as no mode', async () => {
		await applicationCaller.cleanQueues({ applicationId: "a1", mode: "all" });
		expect(mocks.cleanQueuesByApplication).toHaveBeenCalledWith("a1");
		expect(mocks.keepOldestQueuesByApplication).not.toHaveBeenCalled();
	});

	it("keepOldest returns what was kept and removed", async () => {
		const out = await applicationCaller.cleanQueues({
			applicationId: "a1",
			mode: "keepOldest",
		});

		expect(mocks.keepOldestQueuesByApplication).toHaveBeenCalledWith("a1");
		expect(mocks.cleanQueuesByApplication).not.toHaveBeenCalled();
		expect(out).toEqual(result);
	});

	it("checks the same permission in both modes", async () => {
		await applicationCaller.cleanQueues({ applicationId: "a1" });
		await applicationCaller.cleanQueues({
			applicationId: "a1",
			mode: "keepOldest",
		});
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledTimes(2);
		for (const call of mocks.checkServicePermissionAndAccess.mock.calls) {
			expect(call.slice(1)).toEqual(["a1", { deployment: ["cancel"] }]);
		}
	});

	it("rejects an unknown mode before touching the queue", async () => {
		await expect(
			applicationCaller.cleanQueues({
				applicationId: "a1",
				mode: "newest" as never,
			}),
		).rejects.toThrow();
		expect(mocks.cleanQueuesByApplication).not.toHaveBeenCalled();
		expect(mocks.keepOldestQueuesByApplication).not.toHaveBeenCalled();
	});
});

describe("compose.cleanQueues", () => {
	it("without a mode drops everything and answers as before", async () => {
		const out = await composeCaller.cleanQueues({ composeId: "c1" });

		expect(mocks.cleanQueuesByCompose).toHaveBeenCalledWith("c1");
		expect(mocks.keepOldestQueuesByCompose).not.toHaveBeenCalled();
		expect(out).toEqual({
			success: true,
			message: "Queues cleaned successfully",
		});
	});

	it("keepOldest returns what was kept and removed", async () => {
		const out = await composeCaller.cleanQueues({
			composeId: "c1",
			mode: "keepOldest",
		});

		expect(mocks.keepOldestQueuesByCompose).toHaveBeenCalledWith("c1");
		expect(mocks.cleanQueuesByCompose).not.toHaveBeenCalled();
		expect(out).toEqual(result);
	});

	it("checks the same permission in both modes", async () => {
		await composeCaller.cleanQueues({ composeId: "c1" });
		await composeCaller.cleanQueues({ composeId: "c1", mode: "keepOldest" });
		for (const call of mocks.checkServicePermissionAndAccess.mock.calls) {
			expect(call.slice(1)).toEqual(["c1", { deployment: ["create"] }]);
		}
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledTimes(2);
	});
});

describe("MCP tools", () => {
	it("surface the optional mode field with its default", () => {
		const tools = buildMcpToolRegistry(
			createTRPCRouter({
				application: applicationRouter,
				compose: composeRouter,
			}),
		);
		for (const name of ["application-cleanQueues", "compose-cleanQueues"]) {
			const tool = tools.find((candidate) => candidate.name === name);
			expect(tool, name).toBeDefined();
			const schema = tool?.inputSchema as {
				properties: Record<string, { enum?: string[]; default?: string }>;
				required?: string[];
			};
			expect(schema.properties.mode?.enum).toEqual(["all", "keepOldest"]);
			expect(schema.properties.mode?.default).toBe("all");
			expect(schema.required ?? []).not.toContain("mode");
		}
	});
});
