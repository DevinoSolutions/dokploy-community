import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = await import("@dokploy/server/db");
const { buildMemberSession } = await import("@dokploy/server/lib/auth");

const findFirst = vi.mocked(db.query.member.findFirst);

const userRow = {
	id: "user-1",
	firstName: "Ada",
	lastName: "L",
	email: "ada@example.com",
	emailVerified: true,
	image: null,
	createdAt: new Date("2026-01-01"),
	updatedAt: new Date("2026-01-02"),
	twoFactorEnabled: false,
	enableEnterpriseFeatures: false,
	isValidEnterpriseLicense: false,
};

describe("buildMemberSession", () => {
	beforeEach(() => findFirst.mockReset());

	it("maps the user row and member role into the tRPC session shape", async () => {
		findFirst.mockResolvedValueOnce({
			role: "admin",
			organization: { ownerId: "owner-9" },
		} as never);
		const result = await buildMemberSession(userRow as never, "org-1");
		expect(result.session).toEqual({
			userId: "user-1",
			activeOrganizationId: "org-1",
		});
		expect(result.user).toMatchObject({
			id: "user-1",
			name: "Ada",
			email: "ada@example.com",
			role: "admin",
			ownerId: "owner-9",
		});
	});

	it("falls back to member/self-owner when no member row exists", async () => {
		findFirst.mockResolvedValueOnce(undefined as never);
		const result = await buildMemberSession(userRow as never, "org-1");
		expect(result.user.role).toBe("member");
		expect(result.user.ownerId).toBe("user-1");
	});
});
