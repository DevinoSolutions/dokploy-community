import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `deployment:priority` gates the deploy queue priority lane
 * (docs/deploy-queue-priority.md): owners and admins have it, the member role
 * does not, and an enterprise custom role can be given it.
 */

const mockMember = (role: string) => ({
	id: "member-1",
	role,
	userId: "user-1",
	organizationId: "org-1",
	accessedProjects: [] as string[],
	accessedServices: [] as string[],
	accessedEnvironments: [] as string[],
	canCreateProjects: false,
	canDeleteProjects: false,
	canCreateServices: false,
	canDeleteServices: false,
	canCreateEnvironments: false,
	canDeleteEnvironments: false,
	canAccessToTraefikFiles: false,
	canAccessToDocker: false,
	canAccessToAPI: false,
	canAccessToSSHKeys: false,
	canAccessToGitProviders: false,
	user: { id: "user-1", email: "test@test.com" },
});

let memberToReturn = mockMember("member");
let customRolePermission = "{}";
let licensed = false;

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			member: {
				findFirst: vi.fn(() => Promise.resolve(memberToReturn)),
				findMany: vi.fn(() => Promise.resolve([])),
			},
			organizationRole: {
				findFirst: vi.fn(),
				findMany: vi.fn(() =>
					Promise.resolve([{ permission: customRolePermission }]),
				),
			},
		},
	},
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(() => Promise.resolve(licensed)),
}));

const { checkPermission, resolvePermissions } = await import(
	"@dokploy/server/services/permission"
);
const { statements, ownerRole, adminRole, memberRole } = await import(
	"@dokploy/server/lib/access-control"
);

const ctx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

beforeEach(() => {
	licensed = false;
	customRolePermission = "{}";
});

describe("deployment:priority", () => {
	it("is a deployment action", () => {
		expect(statements.deployment).toContain("priority");
	});

	it("is held by the owner and admin roles and not by the member role", () => {
		expect(ownerRole.authorize({ deployment: ["priority"] }).success).toBe(
			true,
		);
		expect(adminRole.authorize({ deployment: ["priority"] }).success).toBe(
			true,
		);
		expect(memberRole.authorize({ deployment: ["priority"] }).success).toBe(
			false,
		);
		// The member role still deploys and cancels as before.
		expect(
			memberRole.authorize({ deployment: ["read", "create", "cancel"] })
				.success,
		).toBe(true);
	});

	it("checkPermission lets an owner and an admin through and refuses a member", async () => {
		memberToReturn = mockMember("owner");
		await expect(
			checkPermission(ctx, { deployment: ["priority"] }),
		).resolves.toBeUndefined();

		memberToReturn = mockMember("admin");
		await expect(
			checkPermission(ctx, { deployment: ["priority"] }),
		).resolves.toBeUndefined();

		memberToReturn = mockMember("member");
		await expect(
			checkPermission(ctx, { deployment: ["priority"] }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("resolvePermissions reports it per role", async () => {
		memberToReturn = mockMember("admin");
		expect((await resolvePermissions(ctx)).deployment.priority).toBe(true);

		memberToReturn = mockMember("member");
		expect((await resolvePermissions(ctx)).deployment.priority).toBe(false);
	});

	it("a licensed custom role gets it only when it is granted", async () => {
		licensed = true;
		memberToReturn = mockMember("release-manager");

		customRolePermission = JSON.stringify({
			deployment: ["read", "create", "cancel"],
		});
		await expect(
			checkPermission(ctx, { deployment: ["priority"] }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		customRolePermission = JSON.stringify({
			deployment: ["read", "create", "priority"],
		});
		await expect(
			checkPermission(ctx, { deployment: ["priority"] }),
		).resolves.toBeUndefined();
	});

	it("an unlicensed custom role never has it", async () => {
		licensed = false;
		memberToReturn = mockMember("release-manager");
		customRolePermission = JSON.stringify({ deployment: ["priority"] });

		await expect(
			checkPermission(ctx, { deployment: ["priority"] }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
