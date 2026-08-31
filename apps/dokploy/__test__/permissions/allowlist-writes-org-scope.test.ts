import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wave 5 of the cross-organization id sweep: the *write* side of the member
 * allow-lists.
 *
 * `addNewProject` / `addNewEnvironment` / `addNewService` appended a
 * caller-supplied id to `accessedProjects` / `accessedEnvironments` /
 * `accessedServices` with no validation that the id belonged to the active
 * organization. The read-side helpers hardened in waves 3 and 4 assume the
 * opposite ("an allow-list entry implies organization membership"), so these
 * writers now resolve the id through the same organization resolvers and fail
 * closed. They are idempotent too: an id already present is not appended again.
 */
const mocks = vi.hoisted(() => ({
	memberFindFirst: vi.fn(),
	projectFindFirst: vi.fn(),
	environmentFindFirst: vi.fn(),
	execute: vi.fn(),
	update: vi.fn(),
	set: vi.fn(),
	where: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		// Raw SQL escape hatch used by the service -> organization resolver.
		execute: mocks.execute,
		update: mocks.update,
		query: {
			member: {
				findFirst: mocks.memberFindFirst,
				findMany: vi.fn(() => Promise.resolve([])),
			},
			organizationRole: {
				findFirst: vi.fn(),
				findMany: vi.fn(() => Promise.resolve([])),
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

const { addNewProject, addNewEnvironment, addNewService } = await import(
	"@dokploy/server/services/permission"
);

const mockMemberData = (
	overrides: Partial<{
		accessedProjects: string[];
		accessedEnvironments: string[];
		accessedServices: string[];
	}> = {},
) => ({
	id: "member-1",
	role: "member",
	userId: "user-1",
	organizationId: "org-1",
	accessedProjects: [] as string[],
	accessedEnvironments: [] as string[],
	accessedServices: [] as string[],
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

let memberToReturn = mockMemberData();

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

/** The `accessedX` array the single `db.update(...).set(...)` call persisted. */
const writtenValues = () => mocks.set.mock.calls[0]?.[0];

beforeEach(() => {
	vi.clearAllMocks();
	memberToReturn = mockMemberData();
	projectOrganizationId = "org-1";
	environmentOrganizationId = "org-1";
	serviceOrganizationId = "org-1";

	mocks.memberFindFirst.mockImplementation(() =>
		Promise.resolve(memberToReturn),
	);
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

	mocks.where.mockImplementation(() => Promise.resolve(undefined));
	mocks.set.mockImplementation(() => ({ where: mocks.where }));
	mocks.update.mockImplementation(() => ({ set: mocks.set }));
});

describe("addNewProject is organization-scoped", () => {
	it("appends a project from the caller's own organization", async () => {
		await expect(addNewProject(ctx, "project-1")).resolves.toBeUndefined();
		expect(mocks.update).toHaveBeenCalledTimes(1);
		expect(writtenValues()).toEqual({ accessedProjects: ["project-1"] });
	});

	it("rejects a project from another organization without writing", async () => {
		projectOrganizationId = "org-2";
		await expect(addNewProject(ctx, "project-1")).rejects.toThrow(
			projectMessage,
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("rejects a project that does not exist without writing", async () => {
		projectOrganizationId = null;
		await expect(addNewProject(ctx, "project-does-not-exist")).rejects.toThrow(
			projectMessage,
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("rejects an empty project id without writing", async () => {
		await expect(addNewProject(ctx, "")).rejects.toThrow(projectMessage);
		expect(mocks.projectFindFirst).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("does not append a project that is already allowed", async () => {
		memberToReturn = mockMemberData({ accessedProjects: ["project-1"] });
		await expect(addNewProject(ctx, "project-1")).resolves.toBeUndefined();
		expect(mocks.update).not.toHaveBeenCalled();
	});
});

describe("addNewEnvironment is organization-scoped", () => {
	it("appends an environment from the caller's own organization", async () => {
		await expect(addNewEnvironment(ctx, "env-1")).resolves.toBeUndefined();
		expect(mocks.update).toHaveBeenCalledTimes(1);
		expect(writtenValues()).toEqual({ accessedEnvironments: ["env-1"] });
	});

	it("rejects an environment from another organization without writing", async () => {
		environmentOrganizationId = "org-2";
		await expect(addNewEnvironment(ctx, "env-1")).rejects.toThrow(
			environmentMessage,
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("rejects an environment that does not exist without writing", async () => {
		environmentOrganizationId = null;
		await expect(addNewEnvironment(ctx, "env-does-not-exist")).rejects.toThrow(
			environmentMessage,
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("rejects an empty environment id without writing", async () => {
		await expect(addNewEnvironment(ctx, "")).rejects.toThrow(
			environmentMessage,
		);
		expect(mocks.environmentFindFirst).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("does not append an environment that is already allowed", async () => {
		memberToReturn = mockMemberData({ accessedEnvironments: ["env-1"] });
		await expect(addNewEnvironment(ctx, "env-1")).resolves.toBeUndefined();
		expect(mocks.update).not.toHaveBeenCalled();
	});
});

describe("addNewService is organization-scoped", () => {
	it("appends a service from the caller's own organization", async () => {
		await expect(addNewService(ctx, "service-1")).resolves.toBeUndefined();
		expect(mocks.update).toHaveBeenCalledTimes(1);
		expect(writtenValues()).toEqual({ accessedServices: ["service-1"] });
	});

	it("rejects a service from another organization without writing", async () => {
		serviceOrganizationId = "org-2";
		await expect(addNewService(ctx, "service-1")).rejects.toThrow(
			serviceMessage,
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("rejects a service that does not exist without writing", async () => {
		serviceOrganizationId = null;
		await expect(addNewService(ctx, "service-does-not-exist")).rejects.toThrow(
			serviceMessage,
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("rejects an empty service id without writing", async () => {
		await expect(addNewService(ctx, "")).rejects.toThrow(serviceMessage);
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("does not append a service that is already allowed", async () => {
		memberToReturn = mockMemberData({ accessedServices: ["service-1"] });
		await expect(addNewService(ctx, "service-1")).resolves.toBeUndefined();
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("keeps existing entries when appending", async () => {
		memberToReturn = mockMemberData({ accessedServices: ["service-0"] });
		await addNewService(ctx, "service-1");
		expect(writtenValues()).toEqual({
			accessedServices: ["service-0", "service-1"],
		});
	});
});
