import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MESSAGE =
	"This organization owns the Dokploy instance and can't be deleted";

const mocks = vi.hoisted(() => ({
	assertOrganizationDeletable: vi.fn(),
	findOrganization: vi.fn(),
	findMember: vi.fn(),
	findOrganizations: vi.fn(),
	deleted: [] as string[],
}));

vi.mock("@dokploy/server/db", () => {
	const executor = {
		delete: () => ({
			where: async () => {
				mocks.deleted.push("organization");
			},
		}),
	};
	return {
		db: {
			query: {
				organization: {
					findFirst: mocks.findOrganization,
					findMany: mocks.findOrganizations,
				},
				member: { findFirst: mocks.findMember },
			},
			transaction: vi.fn(async (run: (tx: unknown) => unknown) =>
				run(executor),
			),
		},
	};
});

vi.mock("@dokploy/server/index", () => ({
	IS_CLOUD: false,
	assertOrganizationDeletable: mocks.assertOrganizationDeletable,
	hasValidLicense: vi.fn(),
	removeOrganizationNotifications: vi.fn(),
	sendInvitationEmail: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/api/utils/plan-limits", () => ({
	assertMemberLimit: vi.fn(),
	assertOrganizationLimit: vi.fn(),
}));

const { organizationRouter } = await import(
	"@/server/api/routers/organization"
);

const caller = organizationRouter.createCaller({
	session: { activeOrganizationId: "org-root" },
	user: { id: "user-1", email: "owner@example.com", role: "owner" },
} as Parameters<typeof organizationRouter.createCaller>[0]);

describe("organization.delete and the root organization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.deleted = [];
		mocks.findOrganization.mockImplementation(async () => ({
			id: "org-x",
			name: "Org",
			ownerId: "user-1",
		}));
		mocks.findMember.mockResolvedValue({ role: "owner" });
		mocks.findOrganizations.mockResolvedValue([{ id: "a" }, { id: "b" }]);
		mocks.assertOrganizationDeletable.mockImplementation(async (id: string) => {
			if (id === "org-root") {
				throw new TRPCError({ code: "FORBIDDEN", message: MESSAGE });
			}
		});
	});

	it("refuses the root organization, even for its owner with other organizations", async () => {
		await expect(
			caller.delete({ organizationId: "org-root" }),
		).rejects.toMatchObject({ code: "FORBIDDEN", message: MESSAGE });

		expect(mocks.deleted).toEqual([]);
	});

	it("still deletes any other organization", async () => {
		await caller.delete({ organizationId: "org-2" });

		expect(mocks.assertOrganizationDeletable).toHaveBeenCalledWith("org-2");
		expect(mocks.deleted).toEqual(["organization"]);
	});
});
