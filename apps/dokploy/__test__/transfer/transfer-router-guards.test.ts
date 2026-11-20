import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may run a transfer or its pre-flight (T-16187), and what the router tells
 * the service about the caller. The pre-flight asks the same permissions as the
 * transfer.
 */
const state = vi.hoisted(() => ({ isCloud: false }));

const mocks = vi.hoisted(() => ({
	getAccessibleServerIds: vi.fn(),
	isRootOrganization: vi.fn(),
	previewTransfer: vi.fn(),
	transferService: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(() => Promise.resolve()),
}));

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return {
		...actual,
		get IS_CLOUD() {
			return state.isCloud;
		},
		getAccessibleServerIds: mocks.getAccessibleServerIds,
		isRootOrganization: mocks.isRootOrganization,
		previewTransfer: mocks.previewTransfer,
		transferService: mocks.transferService,
	};
});

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	return {
		...actual,
		checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	};
});

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");

const createCaller = createCallerFactory(appRouter);

const callerAs = (role: string, organizationId = "org-1") =>
	createCaller({
		user: {
			id: "user-1",
			email: "user@example.com",
			role,
			ownerId: "user-1",
		},
		session: { activeOrganizationId: organizationId },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

const PREFLIGHT = {
	serviceType: "postgres",
	serviceId: "pg-1",
	targetServerId: "server-target",
} as const;

const drain = async (stream: AsyncIterable<string>) => {
	const lines: string[] = [];
	for await (const line of stream) {
		lines.push(line);
	}
	return lines;
};

beforeEach(() => {
	vi.clearAllMocks();
	state.isCloud = false;
	mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-target"]));
	mocks.isRootOrganization.mockResolvedValue(true);
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.previewTransfer.mockResolvedValue({ volumes: [], refused: null });
	mocks.transferService.mockResolvedValue({ appName: "pg-x" });
});

describe("transfer.preflight", () => {
	it("asks the permissions a transfer asks, on the service", async () => {
		await callerAs("owner").transfer.preflight(PREFLIGHT);
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.objectContaining({
				session: { activeOrganizationId: "org-1" },
			}),
			"pg-1",
			{ service: ["create"], deployment: ["create"] },
		);
	});

	it("reads nothing when the permission is refused", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("no permission"),
		);
		await expect(
			callerAs("member").transfer.preflight(PREFLIGHT),
		).rejects.toThrow("no permission");
		expect(mocks.previewTransfer).not.toHaveBeenCalled();
	});

	it("reads nothing about a server the caller cannot reach", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["other"]));
		await expect(
			callerAs("owner").transfer.preflight(PREFLIGHT),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.previewTransfer).not.toHaveBeenCalled();
	});

	it("does not offer the Dokploy server on Dokploy Cloud", async () => {
		state.isCloud = true;
		await expect(
			callerAs("owner").transfer.preflight({
				...PREFLIGHT,
				targetServerId: null,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.previewTransfer).not.toHaveBeenCalled();
	});

	it("is a query, not something that runs a transfer", async () => {
		await callerAs("owner").transfer.preflight(PREFLIGHT);
		expect(mocks.transferService).not.toHaveBeenCalled();
	});

	it.each([
		["owner", true, { privilegedRole: true, localHostReach: true }],
		["admin", true, { privilegedRole: true, localHostReach: true }],
		["admin", false, { privilegedRole: true, localHostReach: false }],
		["member", true, { privilegedRole: false, localHostReach: true }],
	])(
		"tells the service who %s is (root organization: %s)",
		async (role, root, caller) => {
			mocks.isRootOrganization.mockResolvedValue(root);
			await callerAs(role).transfer.preflight({
				...PREFLIGHT,
				overwriteTargets: ["pgdata"],
			});
			expect(mocks.previewTransfer).toHaveBeenCalledWith({
				...PREFLIGHT,
				overwriteTargets: ["pgdata"],
				organizationId: "org-1",
				caller,
			});
		},
	);
});

describe("transfer.start", () => {
	const START = { ...PREFLIGHT, removeSourceData: false };

	it("hands the service the caller and the volumes to write over", async () => {
		const lines = await drain(
			await callerAs("admin").transfer.start({
				...START,
				overwriteTargets: ["pgdata"],
			}),
		);
		expect(lines).toContain("Transfer completed successfully!");
		expect(mocks.transferService).toHaveBeenCalledWith(
			expect.objectContaining({
				...START,
				overwriteTargets: ["pgdata"],
				organizationId: "org-1",
				caller: { privilegedRole: true, localHostReach: true },
			}),
			expect.any(Function),
		);
	});

	it("writes over nothing unless it is told to", async () => {
		await drain(await callerAs("owner").transfer.start(START));
		expect(mocks.transferService).toHaveBeenCalledWith(
			expect.objectContaining({ overwriteTargets: [] }),
			expect.any(Function),
		);
	});

	it("shows a refusal of the service in the transfer log", async () => {
		mocks.transferService.mockRejectedValue(
			new Error("Transfer refused before anything was moved."),
		);
		const lines = await drain(await callerAs("owner").transfer.start(START));
		expect(lines.at(-1)).toContain("Transfer failed");
		expect(lines.at(-1)).toContain(
			"Transfer refused before anything was moved",
		);
	});

	it("keeps refusing a caller without the permission or the server", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("no permission"),
		);
		await expect(
			drain(await callerAs("member").transfer.start(START)),
		).rejects.toThrow("no permission");
		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		mocks.getAccessibleServerIds.mockResolvedValue(new Set());
		await expect(
			drain(await callerAs("owner").transfer.start(START)),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.transferService).not.toHaveBeenCalled();
	});
});
