import { beforeEach, describe, expect, it, vi } from "vitest";

// `project.duplicate` copies the registry, git provider and SSH key ids of a
// service verbatim. A row that already holds one of another organization is
// refused before the new project exists, instead of carrying the foreign id
// into the copy (T-6902). A service with the organization's own ids is copied
// as before. `environment.duplicate` copies no services (only the environment
// row), so it has nothing to refuse.
const mocks = vi.hoisted(() => ({
	owners: new Map<string, string>(),
	application: {} as Record<string, unknown>,
	compose: {} as Record<string, unknown>,
	createProject: vi.fn(),
	createApplication: vi.fn(),
	createCompose: vi.fn(),
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
	...(await importOriginal<typeof import("drizzle-orm")>()),
	eq: (_column: unknown, value: unknown) => ({ value }),
}));

const lookup = (kind: "plain" | "provider") =>
	vi.fn(async (args: { where: { value: string } }) => {
		const organizationId = mocks.owners.get(args.where.value);
		if (!organizationId) {
			return undefined;
		}
		return kind === "plain"
			? { organizationId }
			: { gitProvider: { organizationId } };
	});

vi.mock("@dokploy/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/db")>()),
	db: {
		query: {
			registry: { findFirst: lookup("plain") },
			sshKeys: { findFirst: lookup("plain") },
			github: { findFirst: lookup("provider") },
			gitlab: { findFirst: lookup("provider") },
			gitea: { findFirst: lookup("provider") },
			bitbucket: { findFirst: lookup("provider") },
		},
	},
}));

vi.mock("@dokploy/server", async () => {
	const real = await vi.importActual<
		typeof import("@dokploy/server/services/service-reference-scope")
	>("@dokploy/server/services/service-reference-scope");
	const stubs: Record<string | symbol, unknown> = {};
	const named: Record<string, unknown> = {
		IS_CLOUD: false,
		assertServiceCopyReferencesInOrganization:
			real.assertServiceCopyReferencesInOrganization,
		findApplicationById: vi.fn(async () => mocks.application),
		findComposeById: vi.fn(async () => mocks.compose),
		createProject: mocks.createProject,
		createApplication: mocks.createApplication,
		createCompose: mocks.createCompose,
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

vi.mock("@dokploy/server/services/permission", () => ({
	addNewEnvironment: vi.fn(),
	addNewProject: vi.fn(),
	assertProjectInOrganization: vi.fn(),
	assertServiceInOrganization: vi.fn(),
	checkPermission: vi.fn(),
	checkProjectAccess: vi.fn(),
	findMemberByUserId: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

const ctx = {
	session: { activeOrganizationId: "org-b", userId: "user-1" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
};

const duplicate = async (type: "application" | "compose") => {
	const { projectRouter } = await import("@/server/api/routers/project");
	return projectRouter.createCaller(ctx as never).duplicate({
		sourceEnvironmentId: "env-1",
		name: "copy",
		includeServices: true,
		selectedServices: [{ id: "svc-1", type }],
		duplicateInSameProject: false,
	});
};

const FIELDS = [
	"registryId",
	"buildRegistryId",
	"rollbackRegistryId",
	"githubId",
	"gitlabId",
	"bitbucketId",
	"giteaId",
	"customGitSSHKeyId",
] as const;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.owners.clear();
	mocks.owners.set("own", "org-b");
	mocks.owners.set("foreign", "org-a");
	mocks.application = {
		applicationId: "svc-1",
		name: "web",
		appName: "web-abc123",
		domains: [],
		security: [],
		ports: [],
		redirects: [],
		previewDeployments: [],
		mounts: [],
	};
	mocks.compose = {
		composeId: "svc-1",
		name: "stack",
		appName: "stack-abc123",
		domains: [],
		mounts: [],
	};
	mocks.createProject.mockResolvedValue({
		environment: { environmentId: "env-2", projectId: "project-2" },
	});
	mocks.createApplication.mockResolvedValue({ applicationId: "app-2" });
	mocks.createCompose.mockResolvedValue({ composeId: "cmp-2" });
});

describe.each(["application", "compose"] as const)(
	"project.duplicate of a %s",
	{ timeout: 60_000 },
	(type) => {
		const row = () =>
			type === "application" ? mocks.application : mocks.compose;
		const created = () =>
			type === "application" ? mocks.createApplication : mocks.createCompose;

		it.each(FIELDS)(
			"refuses a service that holds a foreign %s, before any project is created",
			async (field) => {
				row()[field] = "foreign";

				await expect(duplicate(type)).rejects.toMatchObject({
					message: expect.stringContaining("Cannot duplicate"),
				});
				expect(mocks.createProject).not.toHaveBeenCalled();
				expect(created()).not.toHaveBeenCalled();
			},
		);

		it("copies a service whose ids all belong to the organization", async () => {
			Object.assign(row(), {
				registryId: "own",
				githubId: "own",
				customGitSSHKeyId: "own",
				buildRegistryId: null,
			});

			await duplicate(type);

			expect(mocks.createProject).toHaveBeenCalledTimes(1);
			expect(created()).toHaveBeenCalledWith(
				expect.objectContaining({
					registryId: "own",
					githubId: "own",
					customGitSSHKeyId: "own",
				}),
			);
		});
	},
);
