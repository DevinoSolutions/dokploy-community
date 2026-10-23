import { beforeEach, describe, expect, it, vi } from "vitest";

// `project.duplicate` clones the services named in `selectedServices`, row and
// mounts included. Every one of them has to belong to the caller's active
// organization, whichever project the copy goes into (T-6822). The
// organization check is the real one; only the rows it reads are scripted.
const mocks = vi.hoisted(() => ({
	execute: vi.fn(),
	createProject: vi.fn(),
	findEnvironmentById: vi.fn(),
	findApplicationById: vi.fn(),
	createApplication: vi.fn(),
}));

vi.mock("@dokploy/server", () => {
	const stubs: Record<string | symbol, unknown> = {};
	const named: Record<string, unknown> = {
		IS_CLOUD: false,
		createProject: mocks.createProject,
		findEnvironmentById: mocks.findEnvironmentById,
		findApplicationById: mocks.findApplicationById,
		createApplication: mocks.createApplication,
	};
	return new Proxy(stubs, {
		get: (target, key) => {
			if (key === "then") {
				return undefined;
			}
			if (typeof key === "string" && key in named) {
				return named[key];
			}
			target[key] ??= vi.fn();
			return target[key];
		},
		has: () => true,
	});
});

vi.mock("@dokploy/server/services/permission", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/permission")
	>()),
	checkProjectAccess: vi.fn(async () => undefined),
	findMemberByUserId: vi.fn(async () => ({ accessedProjects: [] })),
}));

vi.mock("@dokploy/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/db")>()),
	db: { execute: mocks.execute },
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

const { projectRouter } = await import("@/server/api/routers/project");

const caller = projectRouter.createCaller({
	session: { activeOrganizationId: "org-b" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
} as never);

const application = {
	applicationId: "app-of-org-a",
	appName: "web-AbC123",
	name: "web",
	domains: [],
	security: [],
	ports: [],
	redirects: [],
	previewDeployments: [],
	mounts: [{ mountId: "m-1", type: "volume", volumeName: "web-AbC123-data" }],
	registry: null,
	refreshToken: "t",
};

// the procedure wraps every failure of the copy in BAD_REQUEST
const refusedAsUnauthorized = {
	code: "BAD_REQUEST",
	cause: { code: "UNAUTHORIZED" },
};

const input = (overrides: Record<string, unknown> = {}) => ({
	sourceEnvironmentId: "env-b",
	name: "copy",
	includeServices: true,
	selectedServices: [{ id: "app-of-org-a", type: "application" as const }],
	duplicateInSameProject: false,
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createProject.mockResolvedValue({
		environment: { environmentId: "env-new" },
	});
	mocks.findEnvironmentById.mockResolvedValue({
		environmentId: "env-b",
		project: { organizationId: "org-b", projectId: "p-b", env: "" },
	});
	mocks.findApplicationById.mockResolvedValue(application);
	mocks.createApplication.mockResolvedValue({ applicationId: "app-new" });
});

describe("project.duplicate", () => {
	it("refuses a selected service of another organization before creating anything", async () => {
		mocks.execute.mockResolvedValue([{ organizationId: "org-a" }]);

		await expect(caller.duplicate(input())).rejects.toMatchObject(
			refusedAsUnauthorized,
		);

		expect(mocks.createProject).not.toHaveBeenCalled();
		expect(mocks.findApplicationById).not.toHaveBeenCalled();
		expect(mocks.createApplication).not.toHaveBeenCalled();
	});

	it("refuses it when copying inside the caller's own project too", async () => {
		mocks.execute.mockResolvedValue([{ organizationId: "org-a" }]);

		await expect(
			caller.duplicate(input({ duplicateInSameProject: true })),
		).rejects.toMatchObject(refusedAsUnauthorized);
		expect(mocks.createApplication).not.toHaveBeenCalled();
	});

	it("refuses a service id that matches nothing, the same way", async () => {
		mocks.execute.mockResolvedValue([]);

		await expect(caller.duplicate(input())).rejects.toMatchObject(
			refusedAsUnauthorized,
		);
		expect(mocks.createProject).not.toHaveBeenCalled();
	});

	it("refuses the whole request when one of several services is foreign", async () => {
		mocks.execute
			.mockResolvedValueOnce([{ organizationId: "org-b" }])
			.mockResolvedValueOnce([{ organizationId: "org-a" }]);

		await expect(
			caller.duplicate(
				input({
					selectedServices: [
						{ id: "mine", type: "application" },
						{ id: "theirs", type: "application" },
					],
				}),
			),
		).rejects.toMatchObject(refusedAsUnauthorized);
		expect(mocks.createProject).not.toHaveBeenCalled();
		expect(mocks.createApplication).not.toHaveBeenCalled();
	});

	it("still clones the caller's own service", async () => {
		mocks.execute.mockResolvedValue([{ organizationId: "org-b" }]);

		await caller.duplicate(input());

		expect(mocks.createApplication).toHaveBeenCalledTimes(1);
		expect(mocks.createApplication.mock.calls[0]?.[0]).toMatchObject({
			environmentId: "env-new",
		});
	});

	it("does not look at services when none are included", async () => {
		await caller.duplicate(input({ includeServices: false }));

		expect(mocks.execute).not.toHaveBeenCalled();
	});
});
