import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `settings.getDockerDiskUsage` only needs `docker.read`, and the org check
 * proves the server belongs to the caller's organization. Members must also be
 * limited to the servers they were granted (`getAccessibleServerIds`), like the
 * rest of the server-scoped routers. The local host (no serverId) belongs to
 * the organization that owns the instance, since its disk usage covers every
 * organization.
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
		// org-1 owns the instance
		isRootOrganization: vi.fn(async (id: string) => id === "org-1"),
	};
});

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");
const { getAccessibleServerIds } = await import(
	"@dokploy/server/services/server"
);
const { findServerById, getDockerDiskUsage, isRootOrganization } = await import(
	"@dokploy/server"
);

const createCaller = createCallerFactory(appRouter);

const ctx = (role: string, activeOrganizationId = "org-1") =>
	({
		user: { id: "user-1", email: "u@test.com", role },
		session: { userId: "user-1", activeOrganizationId },
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

	it("allows the local host without a serverId to the organization that owns the instance and skips the grant lookup", async () => {
		await expect(
			createCaller(ctx("member")).settings.getDockerDiskUsage(),
		).resolves.toEqual([]);
		expect(getAccessibleServerIds).not.toHaveBeenCalled();
		expect(getDockerDiskUsage).toHaveBeenCalledWith(undefined);
	});

	it.each([undefined, ""])(
		"refuses the local host (serverId %j) to another organization",
		async (serverId) => {
			for (const role of ["member", "admin"]) {
				await expect(
					createCaller(ctx(role, "org-2")).settings.getDockerDiskUsage({
						serverId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
			}
			expect(getDockerDiskUsage).not.toHaveBeenCalled();
		},
	);

	it("leaves a remote server of the caller's own organization alone", async () => {
		vi.mocked(findServerById).mockResolvedValueOnce({
			serverId: "srv-9",
			organizationId: "org-2",
			serverStatus: "active",
		} as Awaited<ReturnType<typeof findServerById>>);
		grant("srv-9");

		await expect(
			createCaller(ctx("admin", "org-2")).settings.getDockerDiskUsage({
				serverId: "srv-9",
			}),
		).resolves.toEqual([]);
		expect(isRootOrganization).not.toHaveBeenCalled();
		expect(getDockerDiskUsage).toHaveBeenCalledWith("srv-9");
	});

	it("refuses a remote server of another organization", async () => {
		grant("srv-1");

		await expect(
			createCaller(ctx("admin", "org-2")).settings.getDockerDiskUsage({
				serverId: "srv-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(getDockerDiskUsage).not.toHaveBeenCalled();
	});
});
