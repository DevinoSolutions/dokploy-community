import { beforeEach, describe, expect, it, vi } from "vitest";

// Update procedures that spread their input into a row must not be able to
// re-parent it into another organization: project.organizationId,
// environment.projectId, registry.organizationId, server.sshKeyId and the
// git provider rows (T-6822).
const mocks = vi.hoisted(() => ({
	set: vi.fn(),
	dbUpdate: vi.fn(),
	updateRegistry: vi.fn(),
	findRegistryById: vi.fn(),
	updateProjectById: vi.fn(),
	findProjectById: vi.fn(),
	updateEnvironmentById: vi.fn(),
	findEnvironmentById: vi.fn(),
	findServerById: vi.fn(),
	updateServerById: vi.fn(),
	findSSHKeyById: vi.fn(),
	findGithubById: vi.fn(),
	findGitlabById: vi.fn(),
	findGiteaById: vi.fn(),
	findBitbucketById: vi.fn(),
	updateGithub: vi.fn(),
	updateGitlab: vi.fn(),
	updateGitea: vi.fn(),
	updateBitbucket: vi.fn(),
	updateGitProvider: vi.fn(),
	assertServerInOrganization: vi.fn(),
}));

vi.mock("@dokploy/server", () => {
	const stubs: Record<string | symbol, unknown> = {};
	const named: Record<string, unknown> = {
		IS_CLOUD: false,
		updateRegistry: mocks.updateRegistry,
		findRegistryById: mocks.findRegistryById,
		updateProjectById: mocks.updateProjectById,
		findProjectById: mocks.findProjectById,
		updateEnvironmentById: mocks.updateEnvironmentById,
		findEnvironmentById: mocks.findEnvironmentById,
		findServerById: mocks.findServerById,
		updateServerById: mocks.updateServerById,
		findSSHKeyById: mocks.findSSHKeyById,
		findGithubById: mocks.findGithubById,
		findGitlabById: mocks.findGitlabById,
		findGiteaById: mocks.findGiteaById,
		findBitbucketById: mocks.findBitbucketById,
		updateGithub: mocks.updateGithub,
		updateGitlab: mocks.updateGitlab,
		updateGitea: mocks.updateGitea,
		updateBitbucket: mocks.updateBitbucket,
		updateGitProvider: mocks.updateGitProvider,
		applyDockerCleanupSchedule: vi.fn(),
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
	checkPermission: vi.fn(async () => undefined),
	checkProjectAccess: vi.fn(async () => undefined),
	checkEnvironmentAccess: vi.fn(async () => undefined),
	findMemberByUserId: vi.fn(async () => ({ accessedProjects: [] })),
	assertProjectInOrganization: vi.fn(),
	addNewProject: vi.fn(),
	addNewEnvironment: vi.fn(),
}));

vi.mock("@/server/api/utils/server-org-scope", () => ({
	assertServerInOrganization: mocks.assertServerInOrganization,
}));

vi.mock("@dokploy/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/db")>()),
	db: { update: mocks.dbUpdate },
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

vi.mock("@/server/utils/docker-cleanup", () => ({
	applyDockerCleanupSchedule: vi.fn(),
}));

const schema = await import("@dokploy/server/db/schema");
const { updateProjectById } = await vi.importActual<
	typeof import("@dokploy/server/services/project")
>("@dokploy/server/services/project");
const { updateEnvironmentById } = await vi.importActual<
	typeof import("@dokploy/server/services/environment")
>("@dokploy/server/services/environment");

const ctx = (role = "owner") => ({
	session: { activeOrganizationId: "org-b", userId: "user-1" },
	user: { id: "user-1", email: "user@example.com", role },
});

const routerOf = async (name: string) => {
	const module = await import(`@/server/api/routers/${name}`);
	return module[`${name.replace(/-(.)/g, (_, c) => c.toUpperCase())}Router`];
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.set.mockReturnValue({
		where: () => ({ returning: () => Promise.resolve([{ name: "x" }]) }),
	});
	mocks.dbUpdate.mockReturnValue({ set: mocks.set });
	mocks.updateRegistry.mockResolvedValue({ registryId: "reg-1" });
	mocks.updateProjectById.mockResolvedValue({ name: "p" });
	mocks.updateEnvironmentById.mockResolvedValue({
		environmentId: "env-1",
		name: "e",
	});
	mocks.findProjectById.mockResolvedValue({
		projectId: "p-1",
		organizationId: "org-b",
	});
	mocks.findEnvironmentById.mockResolvedValue({
		environmentId: "env-1",
		isDefault: false,
		project: { organizationId: "org-b" },
	});
});

describe("project and environment update", () => {
	it("the update schemas drop organizationId and projectId", () => {
		expect(
			schema.apiUpdateProject.parse({
				projectId: "p-1",
				name: "renamed",
				organizationId: "org-a",
			}),
		).toEqual({ projectId: "p-1", name: "renamed" });
		expect(
			schema.apiUpdateEnvironment.parse({
				environmentId: "env-1",
				name: "renamed",
				projectId: "project-of-org-a",
			}),
		).toEqual({ environmentId: "env-1", name: "renamed" });
	});

	it("updateProjectById never writes the organization or the id", async () => {
		await updateProjectById("p-1", {
			name: "renamed",
			organizationId: "org-a",
			projectId: "p-other",
		});

		expect(mocks.set).toHaveBeenCalledWith({ name: "renamed" });
	});

	it("updateEnvironmentById never writes the project or the id", async () => {
		await updateEnvironmentById("env-1", {
			name: "renamed",
			projectId: "project-of-org-a",
			environmentId: "env-other",
		});

		expect(mocks.set).toHaveBeenCalledWith({ name: "renamed" });
	});

	it("project.update passes no organizationId on", async () => {
		const caller = (await routerOf("project")).createCaller(ctx());

		await caller.update({
			projectId: "p-1",
			name: "renamed",
			organizationId: "org-a",
		});

		expect(mocks.updateProjectById.mock.calls[0]?.[1]).not.toHaveProperty(
			"organizationId",
		);
	});

	it("environment.update passes no projectId on", async () => {
		const caller = (await routerOf("environment")).createCaller(ctx());

		await caller.update({
			environmentId: "env-1",
			name: "renamed",
			projectId: "project-of-org-a",
		});

		expect(mocks.updateEnvironmentById.mock.calls[0]?.[1]).not.toHaveProperty(
			"projectId",
		);
	});
});

describe("registry.update", () => {
	beforeEach(() => {
		mocks.findRegistryById.mockResolvedValue({
			registryId: "reg-1",
			registryName: "r",
			organizationId: "org-b",
		});
	});

	it("drops organizationId from the schema and the write", async () => {
		expect(
			schema.apiUpdateRegistry.parse({
				registryId: "reg-1",
				registryName: "r",
				organizationId: "org-a",
			}),
		).toEqual({ registryId: "reg-1", registryName: "r" });

		const caller = (await routerOf("registry")).createCaller(ctx());
		await caller.update({
			registryId: "reg-1",
			registryName: "r",
			organizationId: "org-a",
		});

		expect(mocks.updateRegistry.mock.calls[0]?.[1]).not.toHaveProperty(
			"organizationId",
		);
	});

	it("refuses a login server of another organization before writing", async () => {
		mocks.assertServerInOrganization.mockRejectedValue(
			Object.assign(new Error("no"), { code: "UNAUTHORIZED" }),
		);
		const caller = (await routerOf("registry")).createCaller(ctx());

		await expect(
			caller.update({ registryId: "reg-1", serverId: "server-of-org-a" }),
		).rejects.toThrow("no");
		expect(mocks.updateRegistry).not.toHaveBeenCalled();
	});
});

describe("server.update sshKeyId", () => {
	const input = { serverId: "s-1", sshKeyId: "key-of-org-a" };
	const full = {
		name: "s",
		description: "d",
		ipAddress: "10.0.0.1",
		port: 22,
		username: "root",
		serverType: "deploy" as const,
		enableDockerCleanup: true,
		...input,
	};

	beforeEach(() => {
		mocks.findServerById.mockResolvedValue({
			serverId: "s-1",
			name: "s",
			organizationId: "org-b",
			serverStatus: "active",
		});
		mocks.updateServerById.mockResolvedValue({});
	});

	it("refuses an SSH key of another organization", async () => {
		mocks.findSSHKeyById.mockResolvedValue({ organizationId: "org-a" });
		const caller = (await routerOf("server")).createCaller(ctx());

		await expect(caller.update(full)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.updateServerById).not.toHaveBeenCalled();
	});

	it("accepts the organization's own SSH key", async () => {
		mocks.findSSHKeyById.mockResolvedValue({ organizationId: "org-b" });
		const caller = (await routerOf("server")).createCaller(ctx());

		await caller.update(full);

		expect(mocks.updateServerById).toHaveBeenCalledTimes(1);
	});
});

describe.each([
	{
		router: "github",
		find: mocks.findGithubById,
		update: mocks.updateGithub,
		idKey: "githubId",
		extra: { githubAppName: "app" },
	},
	{
		router: "gitlab",
		find: mocks.findGitlabById,
		update: mocks.updateGitlab,
		idKey: "gitlabId",
		extra: { gitlabUrl: "https://gitlab.example.com" },
	},
	{
		router: "gitea",
		find: mocks.findGiteaById,
		update: mocks.updateGitea,
		idKey: "giteaId",
		extra: { giteaUrl: "https://gitea.example.com" },
	},
	{
		router: "bitbucket",
		find: mocks.findBitbucketById,
		update: mocks.updateBitbucket,
		idKey: "bitbucketId",
		extra: {},
	},
])("$router.update", { timeout: 60_000 }, (provider) => {
	const call = async () => {
		const caller = (await routerOf(provider.router)).createCaller(ctx());
		return caller.update({
			[provider.idKey]: "prov-1",
			gitProviderId: "git-provider-of-org-a",
			name: "renamed",
			...provider.extra,
		});
	};

	it("refuses a provider that belongs to another organization, writing nothing", async () => {
		provider.find.mockResolvedValue({
			gitProviderId: "git-provider-of-org-a",
			gitProvider: {
				gitProviderId: "git-provider-of-org-a",
				organizationId: "org-a",
			},
		});

		await expect(call()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.updateGitProvider).not.toHaveBeenCalled();
		expect(provider.update).not.toHaveBeenCalled();
	});

	it("updates the organization's own provider through its own gitProviderId", async () => {
		provider.find.mockResolvedValue({
			gitProviderId: "git-provider-own",
			gitProvider: {
				gitProviderId: "git-provider-own",
				organizationId: "org-b",
			},
		});

		await call();

		if (provider.router !== "bitbucket") {
			expect(mocks.updateGitProvider.mock.calls[0]?.[0]).toBe(
				"git-provider-own",
			);
			expect(provider.update.mock.calls[0]?.[1]).toMatchObject({
				gitProviderId: "git-provider-own",
			});
		}
		expect(provider.update).toHaveBeenCalledTimes(1);
	});
});
