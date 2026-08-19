import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `adminProcedure` only proves the caller is an owner/admin of their *active*
 * organization -- it says nothing about the `serverId` they pass in. The
 * destructive docker cleanup mutations in the settings router take that
 * `serverId` straight to an SSH/docker exec, so they must additionally verify
 * the target server belongs to the caller's organization.
 */
vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(() => Promise.resolve()),
}));

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return {
		...actual,
		findServerById: vi.fn(async () => ({
			serverId: "srv-1",
			organizationId: "org-1",
			serverStatus: "active",
		})),
		cleanupImages: vi.fn(async () => {}),
		cleanupVolumes: vi.fn(async () => {}),
		cleanupContainers: vi.fn(async () => {}),
		cleanupBuilders: vi.fn(async () => {}),
		cleanupSystem: vi.fn(async () => {}),
		cleanupAll: vi.fn(async () => {}),
	};
});

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");
const {
	cleanupAll,
	cleanupBuilders,
	cleanupContainers,
	cleanupImages,
	cleanupSystem,
	cleanupVolumes,
	findServerById,
} = await import("@dokploy/server");

const createCaller = createCallerFactory(appRouter);

const ownerCtx = {
	user: { id: "user-1", email: "owner@test.com", role: "owner" },
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never;

const inAnotherOrganization = () => {
	vi.mocked(findServerById).mockResolvedValue({
		serverId: "srv-1",
		organizationId: "org-2",
		serverStatus: "active",
	} as Awaited<ReturnType<typeof findServerById>>);
};

const inSameOrganization = () => {
	vi.mocked(findServerById).mockResolvedValue({
		serverId: "srv-1",
		organizationId: "org-1",
		serverStatus: "active",
	} as Awaited<ReturnType<typeof findServerById>>);
};

beforeEach(() => {
	vi.clearAllMocks();
	inSameOrganization();
});

describe("settings destructive mutations are organization-scoped", () => {
	const cases = [
		["cleanUnusedImages", cleanupImages],
		["cleanUnusedVolumes", cleanupVolumes],
		["cleanStoppedContainers", cleanupContainers],
		["cleanDockerBuilder", cleanupBuilders],
		["cleanDockerPrune", cleanupSystem],
		["cleanAll", cleanupAll],
	] as const;

	for (const [procedure, cleanup] of cases) {
		it(`${procedure} rejects a serverId from another organization`, async () => {
			inAnotherOrganization();
			const caller = createCaller(ownerCtx);

			await expect(
				caller.settings[procedure]({ serverId: "srv-1" }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(cleanup).not.toHaveBeenCalled();
		});

		it(`${procedure} allows a serverId from the caller's organization`, async () => {
			const caller = createCaller(ownerCtx);

			await expect(
				caller.settings[procedure]({ serverId: "srv-1" }),
			).resolves.not.toThrow();
			expect(cleanup).toHaveBeenCalledWith("srv-1");
		});
	}

	it("still allows local (serverId-less) cleanups without a server lookup", async () => {
		const caller = createCaller(ownerCtx);

		await expect(caller.settings.cleanUnusedImages({})).resolves.not.toThrow();
		expect(cleanupImages).toHaveBeenCalledWith(undefined);
		expect(findServerById).not.toHaveBeenCalled();
	});

	it("rejects when the caller has no active organization", async () => {
		const caller = createCaller({
			user: { id: "user-1", email: "owner@test.com", role: "owner" },
			session: { activeOrganizationId: undefined },
			req: {} as unknown,
			res: {} as unknown,
		} as never);

		await expect(
			caller.settings.cleanUnusedImages({ serverId: "srv-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(cleanupImages).not.toHaveBeenCalled();
	});
});
