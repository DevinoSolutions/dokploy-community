import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `settings.getDockerDiskUsage` only needs `docker.read`, and the org check
 * proves the server belongs to the caller's organization. Members must also be
 * limited to the servers they were granted (`getAccessibleServerIds`), like the
 * rest of the server-scoped routers. The local host (no serverId) stays open.
 */
vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(() => Promise.resolve()),
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	return {
		...actual,
		checkPermission: vi.fn(async () => {}),
	};
});

vi.mock("@dokploy/server/services/server", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/services/server")>();
	return {
		...actual,
		getAccessibleServerIds: vi.fn(async () => new Set<string>()),
	};
});

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return {
		...actual,
		findServerById: vi.fn(async () => ({
			serverId: "srv-1",
			organizationId: "org-1",
			serverStatus: "active",
		})),
		getDockerDiskUsage: vi.fn(async () => []),
	};
});

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");
const { getAccessibleServerIds } = await import(
	"@dokploy/server/services/server"
);
const { getDockerDiskUsage } = await import("@dokploy/server");

const createCaller = createCallerFactory(appRouter);

const ctx = (role: string) =>
	({
		user: { id: "user-1", email: "u@test.com", role },
		session: { userId: "user-1", activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	}) as never;

const grant = (...serverIds: string[]) => {
	vi.mocked(getAccessibleServerIds).mockResolvedValue(new Set(serverIds));
};

beforeEach(() => {
	vi.clearAllMocks();
	grant();
});

describe("settings.getDockerDiskUsage server scope", () => {
	it("allows a member on a server they were granted", async () => {
		grant("srv-1");
		await expect(
			createCaller(ctx("member")).settings.getDockerDiskUsage({
				serverId: "srv-1",
			}),
		).resolves.toEqual([]);
		expect(getDockerDiskUsage).toHaveBeenCalledWith("srv-1");
	});

	it("rejects a member on a same-org server they were not granted", async () => {
		grant("srv-2");
		await expect(
			createCaller(ctx("member")).settings.getDockerDiskUsage({
				serverId: "srv-1",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(getDockerDiskUsage).not.toHaveBeenCalled();
	});

	it("allows an owner/admin on any server in the organization", async () => {
		// getAccessibleServerIds returns every org server for owners and admins.
		grant("srv-1", "srv-2", "srv-3");
		for (const role of ["owner", "admin"]) {
			await expect(
				createCaller(ctx(role)).settings.getDockerDiskUsage({
					serverId: "srv-3",
				}),
			).resolves.toEqual([]);
		}
		expect(getDockerDiskUsage).toHaveBeenCalledWith("srv-3");
	});

	it("allows the local host without a serverId and skips the grant lookup", async () => {
		await expect(
			createCaller(ctx("member")).settings.getDockerDiskUsage(),
		).resolves.toEqual([]);
		expect(getAccessibleServerIds).not.toHaveBeenCalled();
		expect(getDockerDiskUsage).toHaveBeenCalledWith(undefined);
	});
});
