import { beforeEach, describe, expect, it, vi } from "vitest";

// The organization check of T-6895 proves a git provider is in the caller's
// organization, not that the caller may USE it. A member only sees the
// providers they connected, the ones shared with the organization and, with a
// license, the ones assigned to them (the provider pickers list exactly that
// set), so setting a provider id outside it is refused (T-6902). An id that is
// already stored on the row stays allowed. Only the database rows the real
// checks read are scripted.
const mocks = vi.hoisted(() => ({
	// provider row id (githubId, gitlabId, ...) -> its git provider and organization
	providers: new Map<
		string,
		{ gitProviderId: string; organizationId: string }
	>(),
	gitProviders: [] as {
		gitProviderId: string;
		userId: string;
		sharedWithOrganization: boolean;
	}[],
	member: { role: "member", accessedGitProviders: [] as string[] },
	licensed: false,
	current: {} as Record<string, unknown>,
	providerLookup: vi.fn(),
	updateApplication: vi.fn(),
	updateCompose: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
	...(await importOriginal<typeof import("drizzle-orm")>()),
	// the scripted lookups read the id out of the where clause
	eq: (_column: unknown, value: unknown) => ({ value }),
	and: (...conditions: unknown[]) => conditions,
}));

vi.mock("@dokploy/server/db", async (importOriginal) => {
	const providerLookup = mocks.providerLookup;
	const plainLookup = vi.fn(async (args: { where: { value: string } }) =>
		args.where.value === "own" ? { organizationId: "org-b" } : undefined,
	);
	return {
		...(await importOriginal<typeof import("@dokploy/server/db")>()),
		db: {
			query: {
				registry: { findFirst: plainLookup },
				sshKeys: { findFirst: plainLookup },
				github: { findFirst: providerLookup },
				gitlab: { findFirst: providerLookup },
				gitea: { findFirst: providerLookup },
				bitbucket: { findFirst: providerLookup },
				gitProvider: { findMany: vi.fn(async () => mocks.gitProviders) },
				member: { findFirst: vi.fn(async () => mocks.member) },
			},
		},
	};
});

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(async () => mocks.licensed),
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
		assertCanUseServiceGitProviders: real.assertCanUseServiceGitProviders,
		updateApplication: mocks.updateApplication,
		updateCompose: mocks.updateCompose,
		findApplicationById: vi.fn(async () => ({
			applicationId: "app-1",
			appName: "app",
			...mocks.current,
		})),
		findComposeById: vi.fn(async () => ({
			composeId: "cmp-1",
			buildServerId: null,
			buildRegistryId: null,
			command: "",
			...mocks.current,
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

const FIELDS = ["githubId", "gitlabId", "bitbucketId", "giteaId"] as const;

const REPO_FIELD = {
	githubId: "repository",
	gitlabId: "gitlabRepository",
	bitbucketId: "bitbucketRepository",
	giteaId: "giteaRepository",
} as const;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.providerLookup.mockImplementation(
		async (args: { where: { value: string } }) => {
			const provider = mocks.providers.get(args.where.value);
			if (!provider) {
				return undefined;
			}
			return {
				gitProviderId: provider.gitProviderId,
				gitProvider: { organizationId: provider.organizationId },
			};
		},
	);
	mocks.providers.clear();
	mocks.gitProviders = [
		// connected by the caller
		{
			gitProviderId: "gp-mine",
			userId: "user-1",
			sharedWithOrganization: false,
		},
		// connected by somebody else and shared with the organization
		{
			gitProviderId: "gp-shared",
			userId: "user-2",
			sharedWithOrganization: true,
		},
		// connected by somebody else, not shared
		{
			gitProviderId: "gp-private",
			userId: "user-2",
			sharedWithOrganization: false,
		},
	];
	for (const field of FIELDS) {
		for (const [suffix, gitProviderId, organizationId] of [
			["mine", "gp-mine", "org-b"],
			["shared", "gp-shared", "org-b"],
			["private", "gp-private", "org-b"],
			["other-private", "gp-private", "org-b"],
			["foreign", "gp-foreign", "org-a"],
		] as const) {
			mocks.providers.set(`${field}-${suffix}`, {
				gitProviderId,
				organizationId,
			});
		}
	}
	mocks.member = { role: "member", accessedGitProviders: [] };
	mocks.licensed = false;
	mocks.current = {};
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.updateApplication.mockResolvedValue({
		applicationId: "app-1",
		appName: "app",
	});
	mocks.updateCompose.mockResolvedValue({ composeId: "cmp-1", name: "c" });
});

const UPDATES = [
	{
		router: "application",
		idKey: "applicationId",
		written: () => mocks.updateApplication,
	},
	{
		router: "compose",
		idKey: "composeId",
		written: () => mocks.updateCompose,
	},
] as const;

describe.each(UPDATES)("$router.update", { timeout: 60_000 }, (service) => {
	describe.each(FIELDS)("%s as a member", (field) => {
		const update = async (id: string | null) =>
			(await callerOf(service.router)).update({
				[service.idKey]: "svc-1",
				[field]: id,
			});

		it("refuses a provider somebody else connected and did not share", async () => {
			await expect(update(`${field}-private`)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(service.written()).not.toHaveBeenCalled();
		});

		it("accepts a provider the caller connected", async () => {
			await update(`${field}-mine`);

			expect(service.written()).toHaveBeenCalledWith(
				"svc-1",
				expect.objectContaining({ [field]: `${field}-mine` }),
			);
		});

		it("accepts a provider shared with the organization", async () => {
			await update(`${field}-shared`);

			expect(service.written()).toHaveBeenCalledTimes(1);
		});

		it("accepts an unshared provider that is assigned to the caller (licensed)", async () => {
			mocks.licensed = true;
			mocks.member = { role: "member", accessedGitProviders: ["gp-private"] };

			await update(`${field}-private`);

			expect(service.written()).toHaveBeenCalledTimes(1);
		});

		it("ignores the assignment without a license", async () => {
			mocks.member = { role: "member", accessedGitProviders: ["gp-private"] };

			await expect(update(`${field}-private`)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		});

		it("keeps the id already stored on the row, even when it is not accessible", async () => {
			mocks.current = { [field]: `${field}-private` };

			await update(`${field}-private`);

			expect(service.written()).toHaveBeenCalledWith(
				"svc-1",
				expect.objectContaining({ [field]: `${field}-private` }),
			);
		});

		it("refuses changing to another inaccessible provider", async () => {
			mocks.current = { [field]: `${field}-private` };

			await expect(update(`${field}-other-private`)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(service.written()).not.toHaveBeenCalled();
		});

		it("lets the member switch away from it to one they can use", async () => {
			mocks.current = { [field]: `${field}-private` };

			await update(`${field}-mine`);

			expect(service.written()).toHaveBeenCalledTimes(1);
		});

		it("accepts unsetting it", async () => {
			mocks.current = { [field]: `${field}-private` };

			await update(null);

			expect(service.written()).toHaveBeenCalledWith(
				"svc-1",
				expect.objectContaining({ [field]: null }),
			);
		});

		it("still answers a provider of another organization with NOT_FOUND", async () => {
			await expect(update(`${field}-foreign`)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});
	});

	it.each(["owner", "admin"])(
		"lets an %s use an unshared provider of the organization",
		async (role) => {
			mocks.member = { role, accessedGitProviders: [] };
			const caller = await callerOf(service.router);

			await caller.update({
				[service.idKey]: "svc-1",
				githubId: "githubId-private",
			});

			expect(service.written()).toHaveBeenCalledTimes(1);
		},
	);

	it("does not look at the providers when no provider id is set", async () => {
		const caller = await callerOf(service.router);

		await caller.update({ [service.idKey]: "svc-1", name: "renamed" });

		expect(service.written()).toHaveBeenCalledTimes(1);
		expect(mocks.providerLookup).not.toHaveBeenCalled();
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
] as const;

describe.each(SAVE_ROUTES)(
	"application.$route",
	{ timeout: 60_000 },
	({ route, field, input }) => {
		const call = async (id: string) =>
			(
				(await callerOf("application")) as unknown as Record<
					string,
					(i: unknown) => Promise<unknown>
				>
			)[route]?.({ applicationId: "app-1", ...input, [field]: id });

		it("refuses a provider somebody else connected and did not share", async () => {
			await expect(call(`${field}-private`)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(mocks.updateApplication).not.toHaveBeenCalled();
		});

		it("accepts the providers a member can pick", async () => {
			await call(`${field}-mine`);
			await call(`${field}-shared`);

			expect(mocks.updateApplication).toHaveBeenCalledTimes(2);
		});

		it("saves other fields of a service whose provider somebody else connected", async () => {
			// the form resends the stored repository; only the branch changed
			mocks.current = {
				[field]: `${field}-private`,
				...input,
				sourceType: field.replace("Id", ""),
			};

			await call(`${field}-private`);

			expect(mocks.updateApplication).toHaveBeenCalledWith(
				"app-1",
				expect.objectContaining({ [field]: `${field}-private` }),
			);
		});

		it("refuses re-pointing the repository through a provider the caller cannot use", async () => {
			mocks.current = {
				[field]: `${field}-private`,
				...input,
				sourceType: field.replace("Id", ""),
				[REPO_FIELD[field]]: "other-repo",
			};

			await expect(call(`${field}-private`)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(mocks.updateApplication).not.toHaveBeenCalled();
		});

		it("lets an owner re-point the repository through any provider of the organization", async () => {
			mocks.member = { role: "owner", accessedGitProviders: [] };
			mocks.current = {
				[field]: `${field}-private`,
				...input,
				sourceType: field.replace("Id", ""),
				[REPO_FIELD[field]]: "other-repo",
			};

			await call(`${field}-private`);

			expect(mocks.updateApplication).toHaveBeenCalledTimes(1);
		});

		it("lets an owner pick any provider of the organization", async () => {
			mocks.member = { role: "owner", accessedGitProviders: [] };

			await call(`${field}-private`);

			expect(mocks.updateApplication).toHaveBeenCalledTimes(1);
		});
	},
);

// The id alone is not the whole reference: the repository columns say what the
// provider's token is used to clone, so changing them needs access to the
// provider stored on the service too (or the one the update sets).
describe.each(UPDATES)(
	"$router.update repository columns",
	{ timeout: 60_000 },
	(service) => {
		describe.each(FIELDS)("%s as a member", (field) => {
			const repo = REPO_FIELD[field];
			const update = async (input: Record<string, unknown>) =>
				(await callerOf(service.router)).update({
					[service.idKey]: "svc-1",
					...input,
				});

			it("refuses changing the repository of a service whose provider the caller cannot use", async () => {
				mocks.current = { [field]: `${field}-private`, [repo]: "old" };

				await expect(update({ [repo]: "new" })).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
				expect(service.written()).not.toHaveBeenCalled();
			});

			it("lets the unchanged repository through (the forms resend it)", async () => {
				mocks.current = { [field]: `${field}-private`, [repo]: "same" };

				await update({ [repo]: "same", branch: "next" });

				expect(service.written()).toHaveBeenCalledTimes(1);
			});

			it("treats an empty string and null as the same stored value", async () => {
				mocks.current = { [field]: `${field}-private`, [repo]: null };

				await update({ [repo]: "" });

				expect(service.written()).toHaveBeenCalledTimes(1);
			});

			it("lets a branch-only change through", async () => {
				mocks.current = { [field]: `${field}-private`, [repo]: "old" };

				await update({ branch: "next", buildPath: "/app" });

				expect(service.written()).toHaveBeenCalledTimes(1);
			});

			it("allows the repository change when the stored provider is usable", async () => {
				mocks.current = { [field]: `${field}-shared`, [repo]: "old" };

				await update({ [repo]: "new" });

				expect(service.written()).toHaveBeenCalledTimes(1);
			});

			it("checks the provider the same update sets, not the stored one", async () => {
				mocks.current = { [field]: `${field}-shared`, [repo]: "old" };

				await expect(
					update({ [field]: `${field}-private`, [repo]: "new" }),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await update({ [field]: `${field}-mine`, [repo]: "new" });

				expect(service.written()).toHaveBeenCalledTimes(1);
			});

			it("allows a repository change when no provider is stored or set", async () => {
				mocks.current = { [field]: null, [repo]: "old" };

				await update({ [repo]: "new" });

				expect(service.written()).toHaveBeenCalledTimes(1);
			});

			it.each(["owner", "admin"])("does not hold an %s back", async (role) => {
				mocks.member = { role, accessedGitProviders: [] };
				mocks.current = { [field]: `${field}-private`, [repo]: "old" };

				await update({ [repo]: "new" });

				expect(service.written()).toHaveBeenCalledTimes(1);
			});

			it("refuses a source-type switch that makes an unusable stored provider active", async () => {
				mocks.current = {
					[field]: `${field}-private`,
					sourceType: "raw",
					[repo]: "old",
				};
				const sourceType = field.replace("Id", "");

				await expect(update({ sourceType })).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
				expect(service.written()).not.toHaveBeenCalled();
			});

			it("lets a source type that is already active be sent again", async () => {
				const sourceType = field.replace("Id", "");
				mocks.current = { [field]: `${field}-private`, sourceType };

				await update({ sourceType });

				expect(service.written()).toHaveBeenCalledTimes(1);
			});
		});
	},
);
