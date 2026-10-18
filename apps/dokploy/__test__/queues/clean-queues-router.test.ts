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
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	audit: vi.fn(),
	auditCancel: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

vi.mock("@/server/api/utils/cancel-audit", () => ({
	auditCancel: mocks.auditCancel,
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

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
	mocks.cleanQueuesByApplication.mockResolvedValue(3);
	mocks.cleanQueuesByCompose.mockResolvedValue(3);
	mocks.findApplicationById.mockResolvedValue({
		applicationId: "a1",
		appName: "app-abc123",
	});
	mocks.findComposeById.mockResolvedValue({
		composeId: "c1",
		name: "stack",
	});
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

describe("keepOldest audit", () => {
	it("records the removed job ids for an application", async () => {
		await applicationCaller.cleanQueues({
			applicationId: "a1",
			mode: "keepOldest",
		});

		expect(mocks.audit).toHaveBeenCalledTimes(1);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "cancel",
				resourceType: "application",
				resourceId: "a1",
				resourceName: "app-abc123",
				metadata: { queue: "keepOldest", removedJobIds: ["j2"] },
			}),
		);
	});

	it("records the removed job ids for a compose stack", async () => {
		await composeCaller.cleanQueues({ composeId: "c1", mode: "keepOldest" });

		expect(mocks.audit).toHaveBeenCalledTimes(1);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "cancel",
				resourceType: "compose",
				resourceId: "c1",
				resourceName: "stack",
				metadata: { queue: "keepOldest", removedJobIds: ["j2"] },
			}),
		);
	});

	it("writes nothing when keepOldest removed nothing", async () => {
		mocks.keepOldestQueuesByApplication.mockResolvedValue({
			kept: result.kept,
			removed: [],
		});
		mocks.keepOldestQueuesByCompose.mockResolvedValue({
			kept: result.kept,
			removed: [],
		});

		await applicationCaller.cleanQueues({
			applicationId: "a1",
			mode: "keepOldest",
		});
		await composeCaller.cleanQueues({ composeId: "c1", mode: "keepOldest" });

		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("still answers with what was removed when the audit write fails", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.audit
			.mockRejectedValueOnce(new Error("audit db down"))
			.mockRejectedValueOnce(new Error("audit db down"));

		const fromApplication = await applicationCaller.cleanQueues({
			applicationId: "a1",
			mode: "keepOldest",
		});
		const fromCompose = await composeCaller.cleanQueues({
			composeId: "c1",
			mode: "keepOldest",
		});

		expect(fromApplication).toEqual(result);
		expect(fromCompose).toEqual(result);
		expect(mocks.audit).toHaveBeenCalledTimes(2);
		expect(logged).toHaveBeenCalledTimes(2);
		logged.mockRestore();
	});

	it("records the caller on the entry", async () => {
		await applicationCaller.cleanQueues({
			applicationId: "a1",
			mode: "keepOldest",
		});

		expect(mocks.audit.mock.calls[0]?.[0]).toMatchObject({
			user: { id: "user-1", email: "user@example.com" },
			session: { activeOrganizationId: "org-1" },
		});
	});
});

describe("cleanQueues audit in the default mode", () => {
	it("records who dropped every waiting job of an application", async () => {
		await applicationCaller.cleanQueues({ applicationId: "a1" });

		expect(mocks.audit).toHaveBeenCalledTimes(1);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				user: expect.objectContaining({ id: "user-1" }),
			}),
			{
				action: "cancel",
				resourceType: "application",
				resourceId: "a1",
				resourceName: "app-abc123",
				metadata: { queue: "all", removed: 3 },
			},
		);
	});

	it("records who dropped every waiting job of a compose stack", async () => {
		await composeCaller.cleanQueues({ composeId: "c1", mode: "all" });

		expect(mocks.audit).toHaveBeenCalledTimes(1);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				user: expect.objectContaining({ id: "user-1" }),
			}),
			{
				action: "cancel",
				resourceType: "compose",
				resourceId: "c1",
				resourceName: "stack",
				metadata: { queue: "all", removed: 3 },
			},
		);
	});

	it("writes nothing when the queue had no waiting job", async () => {
		mocks.cleanQueuesByApplication.mockResolvedValue(0);
		mocks.cleanQueuesByCompose.mockResolvedValue(0);

		await applicationCaller.cleanQueues({ applicationId: "a1" });
		await composeCaller.cleanQueues({ composeId: "c1" });

		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("still answers when the audit write fails", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.audit.mockRejectedValue(new Error("audit db down"));

		await expect(
			applicationCaller.cleanQueues({ applicationId: "a1" }),
		).resolves.toBeUndefined();
		await expect(
			composeCaller.cleanQueues({ composeId: "c1" }),
		).resolves.toEqual({
			success: true,
			message: "Queues cleaned successfully",
		});
		expect(logged).toHaveBeenCalledTimes(2);
		logged.mockRestore();
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
			expect(call.slice(1)).toEqual(["c1", { deployment: ["cancel"] }]);
		}
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledTimes(2);
	});
});

describe("cleanQueues in the fork cancel trail", () => {
	const caller = expect.objectContaining({
		user: expect.objectContaining({ id: "user-1" }),
		session: expect.objectContaining({ activeOrganizationId: "org-1" }),
	});

	it("records the caller for a whole-queue drop on an application", async () => {
		await applicationCaller.cleanQueues({ applicationId: "a1" });

		expect(mocks.auditCancel).toHaveBeenCalledTimes(1);
		expect(mocks.auditCancel).toHaveBeenCalledWith(caller, {
			action: "clean_queue",
			targetType: "application",
			targetId: "a1",
			targetName: "app-abc123",
			applicationId: "a1",
			metadata: { queue: "all", removed: 3 },
		});
	});

	it("records the caller for keepOldest on an application", async () => {
		await applicationCaller.cleanQueues({
			applicationId: "a1",
			mode: "keepOldest",
		});

		expect(mocks.auditCancel).toHaveBeenCalledWith(
			caller,
			expect.objectContaining({
				action: "keep_oldest_queue",
				targetType: "application",
				targetId: "a1",
				metadata: { queue: "keepOldest", removedJobIds: ["j2"] },
			}),
		);
	});

	it("records the caller for both modes on a compose stack", async () => {
		await composeCaller.cleanQueues({ composeId: "c1" });
		await composeCaller.cleanQueues({ composeId: "c1", mode: "keepOldest" });

		expect(mocks.auditCancel).toHaveBeenCalledTimes(2);
		expect(mocks.auditCancel.mock.calls[0]).toEqual([
			caller,
			expect.objectContaining({
				action: "clean_queue",
				targetType: "compose",
				targetId: "c1",
				composeId: "c1",
			}),
		]);
		expect(mocks.auditCancel.mock.calls[1]).toEqual([
			caller,
			expect.objectContaining({
				action: "keep_oldest_queue",
				targetType: "compose",
				composeId: "c1",
			}),
		]);
	});

	it("writes nothing when no job was removed", async () => {
		mocks.cleanQueuesByApplication.mockResolvedValue(0);
		mocks.keepOldestQueuesByCompose.mockResolvedValue({
			kept: result.kept,
			removed: [],
		});

		await applicationCaller.cleanQueues({ applicationId: "a1" });
		await composeCaller.cleanQueues({ composeId: "c1", mode: "keepOldest" });

		expect(mocks.auditCancel).not.toHaveBeenCalled();
	});

	it("still keeps the enterprise audit entry next to it", async () => {
		await applicationCaller.cleanQueues({ applicationId: "a1" });

		expect(mocks.audit).toHaveBeenCalledTimes(1);
		expect(mocks.auditCancel).toHaveBeenCalledTimes(1);
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
			// The description tells an MCP client what keepOldest leaves alone.
			const description = (schema.properties.mode as { description?: string })
				.description;
			expect(description).toContain("never PR previews");
			expect(description).toContain("PR previews included");
		}
	});
});
