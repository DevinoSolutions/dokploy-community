import { beforeEach, describe, expect, it, vi } from "vitest";

// A service row points at the registries, git providers and SSH key its build
// uses. Every one of those ids has to belong to the caller's organization,
// otherwise a service of organization A builds with organization B's
// credentials (T-6895). Only the database rows the real check reads are
// scripted: id -> owning organization.
const mocks = vi.hoisted(() => ({
	owners: new Map<string, string>(),
	updateApplication: vi.fn(),
	updateCompose: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
	...(await importOriginal<typeof import("drizzle-orm")>()),
	// the scripted lookups read the id out of the where clause
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
		assertServiceReferencesInOrganization:
			real.assertServiceReferencesInOrganization,
		updateApplication: mocks.updateApplication,
		updateCompose: mocks.updateCompose,
		findApplicationById: vi.fn(async () => ({
			applicationId: "app-1",
			appName: "app",
		})),
		findComposeById: vi.fn(async () => ({
			composeId: "cmp-1",
			buildServerId: null,
			buildRegistryId: null,
			command: "",
		})),
		assertComposeBuildSettings: vi.fn(),
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
	assertEnvironmentInOrganization: vi.fn(),
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	checkServiceAccess: vi.fn(),
	addNewService: vi.fn(),
	findMemberByUserId: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: vi.fn() },
	cleanQueuesByApplication: vi.fn(),
	cleanQueuesByCompose: vi.fn(),
	killDockerBuild: vi.fn(),
}));

const ctx = {
	session: { activeOrganizationId: "org-b", userId: "user-1" },
	user: { id: "user-1", email: "user@example.com", role: "member" },
};

const callerOf = async (router: "application" | "compose") => {
	const module = await import(`@/server/api/routers/${router}`);
	return module[`${router}Router`].createCaller(ctx);
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.owners.clear();
	mocks.owners.set("own", "org-b");
	mocks.owners.set("foreign", "org-a");
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.updateApplication.mockResolvedValue({
		applicationId: "app-1",
		appName: "app",
	});
	mocks.updateCompose.mockResolvedValue({ composeId: "cmp-1", name: "c" });
});

const APPLICATION_FIELDS = [
	"registryId",
	"buildRegistryId",
	"rollbackRegistryId",
	"githubId",
	"gitlabId",
	"bitbucketId",
	"giteaId",
	"customGitSSHKeyId",
] as const;

const COMPOSE_FIELDS = [
	"buildRegistryId",
	"githubId",
	"gitlabId",
	"bitbucketId",
	"giteaId",
	"customGitSSHKeyId",
] as const;

const UPDATES = [
	{
		router: "application",
		idKey: "applicationId",
		fields: APPLICATION_FIELDS,
		written: () => mocks.updateApplication,
	},
	{
		router: "compose",
		idKey: "composeId",
		fields: COMPOSE_FIELDS,
		written: () => mocks.updateCompose,
	},
] as const;

describe.each(UPDATES)("$router.update", { timeout: 60_000 }, (service) => {
	it.each(service.fields)("refuses a foreign %s", async (field) => {
		const caller = await callerOf(service.router);

		await expect(
			caller.update({ [service.idKey]: "svc-1", [field]: "foreign" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(service.written()).not.toHaveBeenCalled();
	});

	it.each(service.fields)("refuses a %s that does not exist", async (field) => {
		const caller = await callerOf(service.router);

		await expect(
			caller.update({ [service.idKey]: "svc-1", [field]: "missing" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(service.written()).not.toHaveBeenCalled();
	});

	it.each(service.fields)("accepts an own %s", async (field) => {
		const caller = await callerOf(service.router);

		await caller.update({ [service.idKey]: "svc-1", [field]: "own" });

		expect(service.written()).toHaveBeenCalledWith(
			"svc-1",
			expect.objectContaining({ [field]: "own" }),
		);
	});

	it.each(service.fields)("accepts %s: null (unset)", async (field) => {
		const caller = await callerOf(service.router);

		await caller.update({ [service.idKey]: "svc-1", [field]: null });

		expect(service.written()).toHaveBeenCalledWith(
			"svc-1",
			expect.objectContaining({ [field]: null }),
		);
	});

	it("refuses when only one of several ids is foreign", async () => {
		const caller = await callerOf(service.router);

		await expect(
			caller.update({
				[service.idKey]: "svc-1",
				buildRegistryId: "own",
				githubId: "foreign",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(service.written()).not.toHaveBeenCalled();
	});

	it("updates a service that sets none of them", async () => {
		const caller = await callerOf(service.router);

		await caller.update({ [service.idKey]: "svc-1", name: "renamed" });

		expect(service.written()).toHaveBeenCalledTimes(1);
	});
});

const SAVE_ROUTES = [
	{
		route: "saveGithubProvider",
		field: "githubId",
		input: {
			repository: "repo",
			branch: "main",
			owner: "me",
			buildPath: "/",
			triggerType: "push",
			enableSubmodules: false,
		},
	},
	{
		route: "saveGitlabProvider",
		field: "gitlabId",
		input: {
			gitlabRepository: "repo",
			gitlabOwner: "me",
			gitlabBranch: "main",
			gitlabBuildPath: "/",
			gitlabProjectId: 1,
			gitlabPathNamespace: "me/repo",
			enableSubmodules: false,
		},
	},
	{
		route: "saveBitbucketProvider",
		field: "bitbucketId",
		input: {
			bitbucketRepository: "repo",
			bitbucketRepositorySlug: "repo",
			bitbucketOwner: "me",
			bitbucketBranch: "main",
			bitbucketBuildPath: "/",
			enableSubmodules: false,
		},
	},
	{
		route: "saveGiteaProvider",
		field: "giteaId",
		input: {
			giteaRepository: "repo",
			giteaOwner: "me",
			giteaBranch: "main",
			giteaBuildPath: "/",
			enableSubmodules: false,
		},
	},
	{
		route: "saveGitProvider",
		field: "customGitSSHKeyId",
		input: {
			customGitBranch: "main",
			customGitBuildPath: "/",
			customGitUrl: "git@github.com:me/repo.git",
			watchPaths: [],
			enableSubmodules: false,
		},
	},
	{
		route: "saveDockerProvider",
		field: "registryId",
		input: {
			dockerImage: "me/image:1",
			username: "u",
			password: "p",
			registryUrl: "docker.io",
		},
	},
] as const;

describe.each(SAVE_ROUTES)(
	"application.$route",
	{ timeout: 60_000 },
	({ route, field, input }) => {
		const call = async (id: string | null | undefined) => {
			const caller = await callerOf("application");
			return (
				caller as unknown as Record<string, (i: unknown) => Promise<unknown>>
			)[route]?.({ applicationId: "app-1", ...input, [field]: id });
		};

		it(`refuses a foreign ${field}`, async () => {
			await expect(call("foreign")).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(mocks.updateApplication).not.toHaveBeenCalled();
		});

		it(`refuses a ${field} that does not exist`, async () => {
			await expect(call("missing")).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(mocks.updateApplication).not.toHaveBeenCalled();
		});

		it(`accepts an own ${field}`, async () => {
			await call("own");

			expect(mocks.updateApplication).toHaveBeenCalledWith(
				"app-1",
				expect.objectContaining({ [field]: "own" }),
			);
		});

		if (field === "registryId") {
			it(`accepts ${field}: null (unset)`, async () => {
				await call(null);

				expect(mocks.updateApplication).toHaveBeenCalledTimes(1);
			});
		}
	},
);

describe("application.saveDockerProvider registry sentinel", () => {
	it('treats "none" as unset and never looks it up', async () => {
		const caller = await callerOf("application");

		await caller.saveDockerProvider({
			applicationId: "app-1",
			dockerImage: "me/image:1",
			username: "u",
			password: "p",
			registryUrl: "docker.io",
			registryId: "none",
		});

		expect(mocks.updateApplication).toHaveBeenCalledWith(
			"app-1",
			expect.objectContaining({ registryId: null }),
		);
	});
});
