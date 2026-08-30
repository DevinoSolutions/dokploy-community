import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wave 4 of the cross-organization id sweep.
 *
 * `checkProjectAccess`, `checkServiceAccess`, `checkEnvironmentAccess`,
 * `checkEnvironmentCreationPermission` and `checkEnvironmentDeletionPermission`
 * all shared the same shape: `checkPermission` proves the caller holds a role
 * inside their *active* organization, and the `accessedProjects` /
 * `accessedServices` / `accessedEnvironments` allow-list was only consulted for
 * plain members. Owners and admins therefore passed with an id belonging to a
 * different organization, and an allow-list entry was never proof of
 * organization membership either (nothing validates the ids an admin assigns
 * through `user.assignPermissions`).
 */
const mocks = vi.hoisted(() => ({
	memberFindFirst: vi.fn(),
	organizationRoleFindMany: vi.fn(),
	projectFindFirst: vi.fn(),
	environmentFindFirst: vi.fn(),
	execute: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		// Raw SQL escape hatch used by the wave 3 service -> organization resolver.
		execute: mocks.execute,
		query: {
			member: {
				findFirst: mocks.memberFindFirst,
				findMany: vi.fn(() => Promise.resolve([])),
			},
			organizationRole: {
				findFirst: vi.fn(),
				findMany: mocks.organizationRoleFindMany,
			},
			projects: {
				findFirst: mocks.projectFindFirst,
			},
			environments: {
				findFirst: mocks.environmentFindFirst,
			},
		},
	},
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(() => Promise.resolve(false)),
}));

const {
	checkProjectAccess,
	checkServiceAccess,
	checkEnvironmentAccess,
	checkEnvironmentCreationPermission,
	checkEnvironmentDeletionPermission,
} = await import("@dokploy/server/services/permission");

const mockMemberData = (
	role: string,
	overrides: Partial<{
		accessedProjects: string[];
		accessedServices: string[];
		accessedEnvironments: string[];
		canCreateProjects: boolean;
		canDeleteProjects: boolean;
		canCreateServices: boolean;
		canDeleteServices: boolean;
		canCreateEnvironments: boolean;
		canDeleteEnvironments: boolean;
	}> = {},
) => ({
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
	...overrides,
});

let memberToReturn = mockMemberData("owner");

/** Organization each resolver reports; `null` models "no such row exists". */
let projectOrganizationId: string | null = "org-1";
let environmentOrganizationId: string | null = "org-1";
let serviceOrganizationId: string | null = "org-1";

const ctx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

const projectMessage =
	"You are not authorized to access this project or it does not exist";
const environmentMessage =
	"You are not authorized to access this environment or it does not exist";
const serviceMessage =
	"You are not authorized to access this service or it does not exist";

beforeEach(() => {
	vi.clearAllMocks();
	memberToReturn = mockMemberData("owner");
	projectOrganizationId = "org-1";
	environmentOrganizationId = "org-1";
	serviceOrganizationId = "org-1";

	mocks.memberFindFirst.mockImplementation(() =>
		Promise.resolve(memberToReturn),
	);
	mocks.organizationRoleFindMany.mockImplementation(() => Promise.resolve([]));
	mocks.projectFindFirst.mockImplementation(() =>
		Promise.resolve(
			projectOrganizationId === null
				? undefined
				: { organizationId: projectOrganizationId },
		),
	);
	mocks.environmentFindFirst.mockImplementation(() =>
		Promise.resolve(
			environmentOrganizationId === null
				? undefined
				: {
						environmentId: "env-1",
						project: { organizationId: environmentOrganizationId },
					},
		),
	);
	mocks.execute.mockImplementation(() =>
		Promise.resolve(
			serviceOrganizationId === null
				? []
				: [{ organizationId: serviceOrganizationId }],
		),
	);
});

describe("checkProjectAccess is organization-scoped", () => {
	it("allows an owner passing a project from their own organization", async () => {
		await expect(
			checkProjectAccess(ctx, "delete", "project-1"),
		).resolves.toBeUndefined();
		expect(mocks.projectFindFirst).toHaveBeenCalledTimes(1);
	});

	it("rejects an owner passing a project from another organization", async () => {
		projectOrganizationId = "org-2";
		await expect(checkProjectAccess(ctx, "delete", "project-1")).rejects.toThrow(
			projectMessage,
		);
	});

	it("rejects an admin passing a project from another organization", async () => {
		memberToReturn = mockMemberData("admin");
		projectOrganizationId = "org-2";
		await expect(checkProjectAccess(ctx, "delete", "project-1")).rejects.toThrow(
			projectMessage,
		);
	});

	it("gives a non-existent project the same error as a foreign one (no existence oracle)", async () => {
		projectOrganizationId = null;
		await expect(
			checkProjectAccess(ctx, "delete", "project-does-not-exist"),
		).rejects.toThrow(projectMessage);
	});

	it("does not query when no project id is supplied", async () => {
		await expect(checkProjectAccess(ctx, "create")).resolves.toBeUndefined();
		expect(mocks.projectFindFirst).not.toHaveBeenCalled();
	});

	it("keeps the member allow-list error when the member simply lacks access", async () => {
		memberToReturn = mockMemberData("member", {
			canDeleteProjects: true,
			accessedProjects: [],
		});
		await expect(checkProjectAccess(ctx, "delete", "project-1")).rejects.toThrow(
			"You don't have access to this project",
		);
		// Ordering control: the allow-list rejects before the organization
		// resolver runs, so the member-facing message is unchanged.
		expect(mocks.projectFindFirst).not.toHaveBeenCalled();
	});

	it("allows a member whose allow-list lists a same-organization project", async () => {
		memberToReturn = mockMemberData("member", {
			canDeleteProjects: true,
			accessedProjects: ["project-1"],
		});
		await expect(
			checkProjectAccess(ctx, "delete", "project-1"),
		).resolves.toBeUndefined();
	});

	it("rejects a member whose allow-list lists a foreign project", async () => {
		memberToReturn = mockMemberData("member", {
			canDeleteProjects: true,
			accessedProjects: ["project-1"],
		});
		projectOrganizationId = "org-2";
		await expect(checkProjectAccess(ctx, "delete", "project-1")).rejects.toThrow(
			projectMessage,
		);
	});
});

describe("checkServiceAccess is organization-scoped", () => {
	it("allows an owner reading a service from their own organization", async () => {
		await expect(
			checkServiceAccess(ctx, "service-1", "read"),
		).resolves.toBeUndefined();
		expect(mocks.execute).toHaveBeenCalledTimes(1);
	});

	it("rejects an owner reading a service from another organization", async () => {
		serviceOrganizationId = "org-2";
		await expect(checkServiceAccess(ctx, "service-1", "read")).rejects.toThrow(
			serviceMessage,
		);
	});

	it("rejects an owner deleting a service from another organization", async () => {
		serviceOrganizationId = "org-2";
		await expect(checkServiceAccess(ctx, "service-1", "delete")).rejects.toThrow(
			serviceMessage,
		);
	});

	it("gives a non-existent service the same error as a foreign one (no existence oracle)", async () => {
		serviceOrganizationId = null;
		await expect(
			checkServiceAccess(ctx, "service-does-not-exist", "read"),
		).rejects.toThrow(serviceMessage);
	});

	it("scopes the create action through the PROJECT resolver", async () => {
		// On "create" the second parameter is a project id, not a service id.
		await expect(
			checkServiceAccess(ctx, "project-1", "create"),
		).resolves.toBeUndefined();
		expect(mocks.projectFindFirst).toHaveBeenCalledTimes(1);
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it("rejects an owner creating a service under a foreign project", async () => {
		projectOrganizationId = "org-2";
		await expect(checkServiceAccess(ctx, "project-1", "create")).rejects.toThrow(
			projectMessage,
		);
	});

	it("keeps the member allow-list error when the member simply lacks the service", async () => {
		memberToReturn = mockMemberData("member", { accessedServices: [] });
		await expect(checkServiceAccess(ctx, "service-1", "read")).rejects.toThrow(
			"You don't have access to this service",
		);
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it("keeps the member allow-list error when the member simply lacks the project", async () => {
		memberToReturn = mockMemberData("member", {
			canCreateServices: true,
			accessedProjects: [],
		});
		await expect(checkServiceAccess(ctx, "project-1", "create")).rejects.toThrow(
			"You don't have access to this project",
		);
		expect(mocks.projectFindFirst).not.toHaveBeenCalled();
	});

	it("allows a member whose allow-list lists a same-organization service", async () => {
		memberToReturn = mockMemberData("member", {
			accessedServices: ["service-1"],
		});
		await expect(
			checkServiceAccess(ctx, "service-1", "read"),
		).resolves.toBeUndefined();
	});

	it("rejects a member whose allow-list lists a foreign service", async () => {
		memberToReturn = mockMemberData("member", {
			accessedServices: ["service-1"],
		});
		serviceOrganizationId = "org-2";
		await expect(checkServiceAccess(ctx, "service-1", "read")).rejects.toThrow(
			serviceMessage,
		);
	});
});

describe("checkEnvironmentAccess is organization-scoped", () => {
	it("allows an owner passing an environment from their own organization", async () => {
		await expect(
			checkEnvironmentAccess(ctx, "env-1", "read"),
		).resolves.toBeUndefined();
		expect(mocks.environmentFindFirst).toHaveBeenCalledTimes(1);
	});

	it("rejects an owner passing an environment from another organization", async () => {
		environmentOrganizationId = "org-2";
		await expect(checkEnvironmentAccess(ctx, "env-1", "read")).rejects.toThrow(
			environmentMessage,
		);
	});

	it("rejects an admin passing an environment from another organization", async () => {
		memberToReturn = mockMemberData("admin");
		environmentOrganizationId = "org-2";
		await expect(checkEnvironmentAccess(ctx, "env-1", "read")).rejects.toThrow(
			environmentMessage,
		);
	});

	it("gives a non-existent environment the same error as a foreign one (no existence oracle)", async () => {
		environmentOrganizationId = null;
		await expect(
			checkEnvironmentAccess(ctx, "env-does-not-exist", "read"),
		).rejects.toThrow(environmentMessage);
	});

	it("keeps the member allow-list error when the member simply lacks access", async () => {
		memberToReturn = mockMemberData("member", { accessedEnvironments: [] });
		await expect(checkEnvironmentAccess(ctx, "env-1", "read")).rejects.toThrow(
			"You don't have access to this environment",
		);
		expect(mocks.environmentFindFirst).not.toHaveBeenCalled();
	});

	it("allows a member whose allow-list lists a same-organization environment", async () => {
		memberToReturn = mockMemberData("member", {
			accessedEnvironments: ["env-1"],
		});
		await expect(
			checkEnvironmentAccess(ctx, "env-1", "read"),
		).resolves.toBeUndefined();
	});

	it("rejects a member whose allow-list lists a foreign environment", async () => {
		memberToReturn = mockMemberData("member", {
			accessedEnvironments: ["env-1"],
		});
		environmentOrganizationId = "org-2";
		await expect(checkEnvironmentAccess(ctx, "env-1", "read")).rejects.toThrow(
			environmentMessage,
		);
	});
});

describe("checkEnvironmentCreationPermission is organization-scoped", () => {
	it("allows an owner passing a project from their own organization", async () => {
		await expect(
			checkEnvironmentCreationPermission(ctx, "project-1"),
		).resolves.toBeUndefined();
		expect(mocks.projectFindFirst).toHaveBeenCalledTimes(1);
	});

	it("rejects an owner passing a project from another organization", async () => {
		projectOrganizationId = "org-2";
		await expect(
			checkEnvironmentCreationPermission(ctx, "project-1"),
		).rejects.toThrow(projectMessage);
	});

	it("gives a non-existent project the same error as a foreign one (no existence oracle)", async () => {
		projectOrganizationId = null;
		await expect(
			checkEnvironmentCreationPermission(ctx, "project-does-not-exist"),
		).rejects.toThrow(projectMessage);
	});

	it("keeps the member allow-list error when the member simply lacks access", async () => {
		memberToReturn = mockMemberData("member", {
			canCreateEnvironments: true,
			accessedProjects: [],
		});
		await expect(
			checkEnvironmentCreationPermission(ctx, "project-1"),
		).rejects.toThrow("You don't have access to this project");
		expect(mocks.projectFindFirst).not.toHaveBeenCalled();
	});

	it("allows a member whose allow-list lists a same-organization project", async () => {
		memberToReturn = mockMemberData("member", {
			canCreateEnvironments: true,
			accessedProjects: ["project-1"],
		});
		await expect(
			checkEnvironmentCreationPermission(ctx, "project-1"),
		).resolves.toBeUndefined();
	});

	it("rejects a member whose allow-list lists a foreign project", async () => {
		memberToReturn = mockMemberData("member", {
			canCreateEnvironments: true,
			accessedProjects: ["project-1"],
		});
		projectOrganizationId = "org-2";
		await expect(
			checkEnvironmentCreationPermission(ctx, "project-1"),
		).rejects.toThrow(projectMessage);
	});
});

describe("checkEnvironmentDeletionPermission is organization-scoped", () => {
	it("allows an owner passing a project from their own organization", async () => {
		await expect(
			checkEnvironmentDeletionPermission(ctx, "project-1"),
		).resolves.toBeUndefined();
		expect(mocks.projectFindFirst).toHaveBeenCalledTimes(1);
	});

	it("rejects an owner passing a project from another organization", async () => {
		projectOrganizationId = "org-2";
		await expect(
			checkEnvironmentDeletionPermission(ctx, "project-1"),
		).rejects.toThrow(projectMessage);
	});

	it("gives a non-existent project the same error as a foreign one (no existence oracle)", async () => {
		projectOrganizationId = null;
		await expect(
			checkEnvironmentDeletionPermission(ctx, "project-does-not-exist"),
		).rejects.toThrow(projectMessage);
	});

	it("keeps the member allow-list error when the member simply lacks access", async () => {
		memberToReturn = mockMemberData("member", {
			canDeleteEnvironments: true,
			accessedProjects: [],
		});
		await expect(
			checkEnvironmentDeletionPermission(ctx, "project-1"),
		).rejects.toThrow("You don't have access to this project");
		expect(mocks.projectFindFirst).not.toHaveBeenCalled();
	});

	it("allows a member whose allow-list lists a same-organization project", async () => {
		memberToReturn = mockMemberData("member", {
			canDeleteEnvironments: true,
			accessedProjects: ["project-1"],
		});
		await expect(
			checkEnvironmentDeletionPermission(ctx, "project-1"),
		).resolves.toBeUndefined();
	});

	it("rejects a member whose allow-list lists a foreign project", async () => {
		memberToReturn = mockMemberData("member", {
			canDeleteEnvironments: true,
			accessedProjects: ["project-1"],
		});
		projectOrganizationId = "org-2";
		await expect(
			checkEnvironmentDeletionPermission(ctx, "project-1"),
		).rejects.toThrow(projectMessage);
	});
});
