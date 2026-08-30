import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMemberData = (
	role: string,
	accessedServices: string[] = [],
	accessedProjects: string[] = [],
) => ({
	id: "member-1",
	role,
	userId: "user-1",
	organizationId: "org-1",
	accessedProjects,
	accessedServices,
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

let memberToReturn: ReturnType<typeof mockMemberData> =
	mockMemberData("member");

/**
 * Organization the service id resolves to, as returned by the single
 * `environment -> project` lookup inside `findServiceOrganizationId`.
 * `null` models "no service with that id exists".
 */
let serviceOrganizationId: string | null = "org-1";

/**
 * Wave 4: `checkServiceAccess(..., "create")` receives a *project* id, so it is
 * scoped through the project resolver instead.
 */
let projectOrganizationId: string | null = "org-1";

vi.mock("@dokploy/server/db", () => ({
	db: {
		execute: vi.fn(() =>
			Promise.resolve(
				serviceOrganizationId === null
					? []
					: [{ organizationId: serviceOrganizationId }],
			),
		),
		query: {
			member: {
				findFirst: vi.fn(() => Promise.resolve(memberToReturn)),
				findMany: vi.fn(() => Promise.resolve([])),
			},
			organizationRole: {
				findFirst: vi.fn(),
				findMany: vi.fn(() => Promise.resolve([])),
			},
			projects: {
				findFirst: vi.fn(() =>
					Promise.resolve(
						projectOrganizationId === null
							? undefined
							: { organizationId: projectOrganizationId },
					),
				),
			},
		},
	},
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(() => Promise.resolve(false)),
}));

const { checkServicePermissionAndAccess, checkServiceAccess } = await import(
	"@dokploy/server/services/permission"
);

const ctx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	serviceOrganizationId = "org-1";
	projectOrganizationId = "org-1";
});

describe("checkServicePermissionAndAccess", () => {
	it("owner bypasses accessedServices check", async () => {
		memberToReturn = mockMemberData("owner", []);
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				deployment: ["read"],
			}),
		).resolves.toBeUndefined();
	});

	it("admin bypasses accessedServices check", async () => {
		memberToReturn = mockMemberData("admin", []);
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				backup: ["create"],
			}),
		).resolves.toBeUndefined();
	});

	it("member with access to service passes", async () => {
		memberToReturn = mockMemberData("member", ["service-123"]);
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				deployment: ["read"],
			}),
		).resolves.toBeUndefined();
	});

	it("member WITHOUT access to service fails", async () => {
		memberToReturn = mockMemberData("member", ["other-service"]);
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				deployment: ["read"],
			}),
		).rejects.toThrow("You don't have access to this service");
	});

	it("member with empty accessedServices fails", async () => {
		memberToReturn = mockMemberData("member", []);
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				domain: ["delete"],
			}),
		).rejects.toThrow("You don't have access to this service");
	});
});

/**
 * Wave 3: owner/admin short-circuit the `accessedServices` allow-list, and
 * nothing else proved the id they passed belongs to their organization -- so an
 * owner of org-1 could deploy/stop/read logs of org-2's services purely by id.
 */
describe("checkServicePermissionAndAccess is organization-scoped", () => {
	const crossOrganizationMessage =
		"You are not authorized to access this service or it does not exist";

	it("rejects an owner passing a service from another organization", async () => {
		memberToReturn = mockMemberData("owner", []);
		serviceOrganizationId = "org-2";
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				deployment: ["create"],
			}),
		).rejects.toThrow(crossOrganizationMessage);
	});

	it("rejects an admin passing a service from another organization", async () => {
		memberToReturn = mockMemberData("admin", []);
		serviceOrganizationId = "org-2";
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				deployment: ["create"],
			}),
		).rejects.toThrow(crossOrganizationMessage);
	});

	it("gives a non-existent service the same error as a foreign one (no existence oracle)", async () => {
		memberToReturn = mockMemberData("owner", []);
		serviceOrganizationId = null;
		await expect(
			checkServicePermissionAndAccess(ctx, "service-does-not-exist", {
				deployment: ["create"],
			}),
		).rejects.toThrow(crossOrganizationMessage);
	});

	it("allows an owner passing a service from their own organization", async () => {
		memberToReturn = mockMemberData("owner", []);
		serviceOrganizationId = "org-1";
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				deployment: ["create"],
			}),
		).resolves.toBeUndefined();
	});

	it("rejects a member whose accessedServices lists a foreign service", async () => {
		// `accessedServices` is not proof of organization membership: nothing
		// validates the ids an admin assigns through `user.assignPermissions`.
		memberToReturn = mockMemberData("member", ["service-123"]);
		serviceOrganizationId = "org-2";
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				deployment: ["read"],
			}),
		).rejects.toThrow(crossOrganizationMessage);
	});

	it("keeps the member allow-list error when the member simply lacks access", async () => {
		// Ordering control: the allow-list check still runs first, so the
		// member-facing message is unchanged by the new organization check.
		memberToReturn = mockMemberData("member", []);
		serviceOrganizationId = "org-1";
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				deployment: ["read"],
			}),
		).rejects.toThrow("You don't have access to this service");
	});
});

describe("checkServiceAccess", () => {
	it("member with service access passes read check", async () => {
		memberToReturn = mockMemberData("member", ["app-1"]);
		await expect(
			checkServiceAccess(ctx, "app-1", "read"),
		).resolves.toBeUndefined();
	});

	it("member without service access fails read check", async () => {
		memberToReturn = mockMemberData("member", []);
		await expect(checkServiceAccess(ctx, "app-1", "read")).rejects.toThrow(
			"You don't have access to this service",
		);
	});

	it("owner bypasses all access checks", async () => {
		memberToReturn = mockMemberData("owner", [], []);
		await expect(
			checkServiceAccess(ctx, "project-1", "create"),
		).resolves.toBeUndefined();
	});
});
