import { beforeEach, describe, expect, it, vi } from "vitest";

// security.one feeds the edit form of a basic-auth user. Whoever can read the
// application can call it, so the password goes only to a caller who may edit
// the service (T-19588), exactly as application.one does for the list.
const state = vi.hoisted(() => ({
	row: null as unknown,
	checkServicePermissionAndAccess: vi.fn(async () => undefined),
	hasPermission: vi.fn(async (_ctx?: unknown, _request?: unknown) => false),
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	return {
		...actual,
		checkServicePermissionAndAccess: state.checkServicePermissionAndAccess,
		hasPermission: state.hasPermission,
	};
});

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return { ...actual, findSecurityById: vi.fn(async () => state.row) };
});

const { securityRouter } = await import("@/server/api/routers/security");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = createCallerFactory(securityRouter)({
	user: { id: "user-1", email: "u@example.com", role: "member", ownerId: "o" },
	session: { activeOrganizationId: "org-1" },
	req: { headers: {} },
	res: {},
} as never);

beforeEach(() => {
	state.row = {
		securityId: "sec-1",
		username: "admin",
		password: "SECRET-basic",
		applicationId: "app-1",
	};
	state.hasPermission.mockReset();
	state.hasPermission.mockResolvedValue(false);
});

describe("security.one", () => {
	it("blanks the password for a caller who cannot edit the service", async () => {
		const result = await caller.one({ securityId: "sec-1" });
		expect(result).toEqual({
			securityId: "sec-1",
			username: "admin",
			password: "",
			applicationId: "app-1",
		});
		expect(JSON.stringify(result)).not.toContain("SECRET-basic");
	});

	it("returns the password to a caller who can edit the service", async () => {
		state.hasPermission.mockImplementation(
			async (_ctx: unknown, req: unknown) =>
				(req as { service?: string[] }).service?.includes("create") ?? false,
		);
		const result = await caller.one({ securityId: "sec-1" });
		expect(result.password).toBe("SECRET-basic");
	});

	it("still needs read access to the application", async () => {
		state.checkServicePermissionAndAccess.mockRejectedValueOnce(
			Object.assign(new Error("no"), { code: "UNAUTHORIZED" }),
		);
		await expect(caller.one({ securityId: "sec-1" })).rejects.toThrow();
	});
});
