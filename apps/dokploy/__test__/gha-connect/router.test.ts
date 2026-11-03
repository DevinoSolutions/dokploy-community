import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ghaConnection router with the real role statements and the real connection access rules:
 * who may connect a service through whose GitHub token, what a caller may read of a connection,
 * and that nothing is written when a check refuses.
 */

const mocks = vi.hoisted(() => ({
	memberGitProviderActions: [] as string[],
	serviceOrganizationId: "org-a",
	registryRows: [] as Array<{ registryUrl: string }>,
	checkServicePermissionAndAccess: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	findGithubConnectionInOrganization: vi.fn(),
	findGithubWatch: vi.fn(),
	loadConnectionToken: vi.fn(),
	upsertGithubWatch: vi.fn(),
	deleteGithubWatch: vi.fn(),
	removeGhcrWatchConfigDirs: vi.fn(),
	findGhaConnection: vi.fn(),
	createGhaConnection: vi.fn(),
	deleteGhaConnection: vi.fn(),
	listReleases: vi.fn(),
	applyConnectionEvent: vi.fn(),
	touchConnectionActivity: vi.fn(),
	getRepositoryByName: vi.fn(),
	getBranchHead: vi.fn(),
	getEnvironmentPolicy: vi.fn(),
	updates: [] as unknown[],
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		select: () => ({ from: () => ({ where: async () => mocks.registryRows }) }),
		update: () => ({
			set: (values: unknown) => ({
				where: async () => {
					mocks.updates.push(values);
				},
			}),
		}),
		transaction: async (fn: (tx: unknown) => unknown) =>
			fn({
				update: () => ({
					set: (values: unknown) => ({
						where: async () => {
							mocks.updates.push(values);
						},
					}),
				}),
			}),
	},
}));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server/services/permission", async () => {
	const { ownerRole, adminRole, memberRole } = await import(
		"@dokploy/server/lib/access-control"
	);
	const roles: Record<
		string,
		{ authorize: (p: never) => { success: boolean } }
	> = { owner: ownerRole, admin: adminRole, member: memberRole };
	const checkPermission = vi.fn(
		async (ctx: { user: { role: string } }, permissions: object) => {
			const privileged = ctx.user.role === "owner" || ctx.user.role === "admin";
			const onlyEnterprise = Object.keys(permissions).every(
				(resource) => resource === "deployment",
			);
			if (privileged && onlyEnterprise) return;
			if (
				ctx.user.role === "member" &&
				mocks.memberGitProviderActions.some(
					(action) =>
						JSON.stringify(permissions) ===
						JSON.stringify({ gitProviders: [action] }),
				)
			) {
				return;
			}
			const role = roles[ctx.user.role];
			if (!role?.authorize(permissions as never).success) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Permission denied",
				});
			}
		},
	);
	return {
		checkPermission,
		findMemberByUserId: vi.fn(),
		checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	};
});

vi.mock("@dokploy/server", async () => ({
	...(await vi.importActual<object>(
		"@dokploy/server/services/github-deployments/connection-access",
	)),
	IS_CLOUD: false,
	deleteGithubWatch: mocks.deleteGithubWatch,
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
	findGithubConnectionInOrganization: mocks.findGithubConnectionInOrganization,
	findGithubWatch: mocks.findGithubWatch,
	loadConnectionToken: mocks.loadConnectionToken,
	removeGhcrWatchConfigDirs: mocks.removeGhcrWatchConfigDirs,
	upsertGithubWatch: mocks.upsertGithubWatch,
}));

// The real Connect rules and presenter; only the database and GitHub reads are stubbed.
vi.mock("@dokploy/server/services/gha-connect", async () => ({
	...(await vi.importActual<object>("@dokploy/server/services/gha-connect")),
	applyConnectionEvent: mocks.applyConnectionEvent,
	createGhaConnection: mocks.createGhaConnection,
	deleteGhaConnection: mocks.deleteGhaConnection,
	findGhaConnection: mocks.findGhaConnection,
	getBranchHead: mocks.getBranchHead,
	getEnvironmentPolicy: mocks.getEnvironmentPolicy,
	getRepositoryByName: mocks.getRepositoryByName,
	listReleases: mocks.listReleases,
	touchConnectionActivity: mocks.touchConnectionActivity,
}));

const { ghaConnectionRouter } = await import(
	"@/server/api/routers/gha-connection"
);

const callerFor = (
	role: "owner" | "admin" | "member",
	userId = "user-1",
	organizationId = "org-a",
) =>
	ghaConnectionRouter.createCaller({
		session: { activeOrganizationId: organizationId },
		user: { id: userId, email: "u@example.com", role },
	} as Parameters<typeof ghaConnectionRouter.createCaller>[0]);

const connectInput = {
	serviceType: "compose" as const,
	serviceId: "compose-1",
	githubConnectionId: "gh-1",
	owner: "DevinoSolutions",
	repo: "voicelabs",
	workflowPath: ".github/workflows/dokploy-web-build-deploy.yml",
	trackedBranch: "dev",
	environment: "development",
	serviceKey: "voicekit-web",
	registryPrefix: "localhost:5000/registry.devino.ca",
	registryId: "reg-1",
	protectionMode: "environment" as const,
	gateMode: "image" as const,
};

const account = (overrides: Record<string, unknown> = {}) => ({
	connectionId: "gh-1",
	githubLogin: "amin",
	scopes: ["repo_deployment", "repo"],
	status: "active",
	lastError: null,
	createdAt: new Date("2026-11-01T00:00:00Z"),
	createdByUserId: "user-1",
	sharedWithOrganization: false,
	...overrides,
});

const storedRow = (overrides: Record<string, unknown> = {}) => ({
	ghaConnectionId: "gc-1",
	organizationId: "org-a",
	serviceType: "compose",
	serviceId: "compose-1",
	githubConnectionId: "gh-1",
	repoId: 123,
	repoFullName: "DevinoSolutions/voicelabs",
	workflowPath: ".github/workflows/dokploy-web-build-deploy.yml",
	trackedBranch: "dev",
	environment: "development",
	serviceKey: "voicekit-web",
	protectionMode: "environment",
	registryPrefix: "localhost:5000/registry.devino.ca",
	registryId: "reg-1",
	registryProbeHost: "registry.devino.ca",
	gateMode: "image",
	state: "waiting",
	stateDetail: null,
	stateSince: new Date("2026-11-03T10:00:00Z"),
	expectedSha: "a".repeat(40),
	deployedSha: null,
	deployedRunId: null,
	deployedAt: null,
	processed: [{ runId: 999, attempt: 1 }],
	previousSource: { sourceType: "github", token: "super-secret-source" },
	lastActivityAt: null,
	lastError: null,
	createdAt: new Date("2026-11-03T10:00:00Z"),
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.memberGitProviderActions = [];
	mocks.serviceOrganizationId = "org-a";
	mocks.registryRows = [{ registryUrl: "https://registry.devino.ca" }];
	mocks.updates = [];
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findApplicationById.mockImplementation(async () => ({
		applicationId: "app-1",
		sourceType: "docker",
		owner: null,
		repository: null,
		environment: { project: { organizationId: mocks.serviceOrganizationId } },
	}));
	mocks.findComposeById.mockImplementation(async () => ({
		composeId: "compose-1",
		sourceType: "raw",
		environment: { project: { organizationId: mocks.serviceOrganizationId } },
	}));
	mocks.findGithubConnectionInOrganization.mockResolvedValue(account());
	mocks.findGithubWatch.mockResolvedValue(null);
	mocks.findGhaConnection.mockResolvedValue(null);
	mocks.loadConnectionToken.mockResolvedValue("gho_secret_token");
	mocks.upsertGithubWatch.mockResolvedValue({ watchId: "w1" });
	mocks.createGhaConnection.mockImplementation(async (input) =>
		storedRow({ ...input }),
	);
	mocks.getRepositoryByName.mockResolvedValue({
		kind: "ok",
		etag: null,
		value: {
			id: 123,
			owner: "DevinoSolutions",
			name: "voicelabs",
			fullName: "DevinoSolutions/voicelabs",
			defaultBranch: "main",
			isPrivate: true,
		},
	});
	mocks.getBranchHead.mockResolvedValue({
		kind: "ok",
		etag: null,
		value: { sha: "a".repeat(40) },
	});
	mocks.getEnvironmentPolicy.mockResolvedValue({
		kind: "ok",
		etag: null,
		value: {
			customBranchPolicies: true,
			protectedBranches: false,
			policies: [{ name: "dev", type: "branch" }],
		},
	});
	mocks.listReleases.mockResolvedValue([]);
	mocks.deleteGhaConnection.mockResolvedValue(undefined);
	mocks.deleteGithubWatch.mockResolvedValue(true);
	mocks.removeGhcrWatchConfigDirs.mockResolvedValue(undefined);
});

const nothingWritten = () => {
	expect(mocks.upsertGithubWatch).not.toHaveBeenCalled();
	expect(mocks.createGhaConnection).not.toHaveBeenCalled();
	expect(mocks.updates).toEqual([]);
};

describe("connect needs gitProviders create AND service create plus deployment create", () => {
	it("refuses a plain member before anything is read", async () => {
		await expect(
			callerFor("member").connect(connectInput),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		expect(mocks.findGithubConnectionInOrganization).not.toHaveBeenCalled();
		nothingWritten();
	});

	it.each(["owner", "admin"] as const)("lets an %s through", async (role) => {
		const saved = await callerFor(role).connect(connectInput);
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"compose-1",
			{ service: ["create"], deployment: ["create"] },
		);
		expect(saved).toMatchObject({
			repository: "DevinoSolutions/voicelabs",
			state: "waiting",
		});
	});

	it("writes nothing when the service access check fails", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new TRPCError({ code: "UNAUTHORIZED", message: "no access" }),
		);
		await expect(
			callerFor("admin").connect(connectInput),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.findGithubConnectionInOrganization).not.toHaveBeenCalled();
		nothingWritten();
	});
});

describe("connect and whose GitHub token it may spend (the githubDeployment.watchSet model)", () => {
	beforeEach(() => {
		mocks.memberGitProviderActions = ["create"];
	});

	it("lets a member connect through their own account", async () => {
		await callerFor("member", "user-1").connect(connectInput);
		expect(mocks.upsertGithubWatch).toHaveBeenCalledWith(
			expect.objectContaining({
				connectionId: "gh-1",
				serviceId: "compose-1",
				organizationId: "org-a",
				enabled: true,
			}),
		);
	});

	it("refuses a member another member's account that is not shared, before any GitHub read", async () => {
		mocks.findGithubConnectionInOrganization.mockResolvedValue(
			account({ createdByUserId: "user-2" }),
		);
		await expect(
			callerFor("member", "user-1").connect(connectInput),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.loadConnectionToken).not.toHaveBeenCalled();
		expect(mocks.getRepositoryByName).not.toHaveBeenCalled();
		nothingWritten();
	});

	it("lets a member use another member's account once its owner shared it", async () => {
		mocks.findGithubConnectionInOrganization.mockResolvedValue(
			account({ createdByUserId: "user-2", sharedWithOrganization: true }),
		);
		await callerFor("member", "user-1").connect(connectInput);
		expect(mocks.upsertGithubWatch).toHaveBeenCalled();
	});

	it.each(["owner", "admin"] as const)(
		"lets an %s use any member's account",
		async (role) => {
			mocks.findGithubConnectionInOrganization.mockResolvedValue(
				account({ createdByUserId: "user-2" }),
			);
			await callerFor(role, "user-9").connect(connectInput);
			expect(mocks.upsertGithubWatch).toHaveBeenCalled();
		},
	);

	it("does not find an account of another organization", async () => {
		mocks.findGithubConnectionInOrganization.mockResolvedValue(null);
		await expect(
			callerFor("admin").connect(connectInput),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.findGithubConnectionInOrganization).toHaveBeenCalledWith(
			"gh-1",
			"org-a",
		);
		nothingWritten();
	});

	it("does not find a service of another organization", async () => {
		mocks.serviceOrganizationId = "org-b";
		await expect(
			callerFor("admin").connect(connectInput),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		nothingWritten();
	});
});

describe("connect refuses what the design says it refuses, and writes nothing", () => {
	it("a repository that is private to a connection that only has public_repo", async () => {
		mocks.findGithubConnectionInOrganization.mockResolvedValue(
			account({ scopes: ["repo_deployment", "public_repo"] }),
		);
		await expect(
			callerFor("owner").connect(connectInput),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("lacks the repo scope"),
		});
		nothingWritten();
	});

	it("an environment whose branch policy could not be read (fails closed)", async () => {
		mocks.getEnvironmentPolicy.mockResolvedValue({
			kind: "error",
			status: 502,
		});
		await expect(
			callerFor("owner").connect(connectInput),
		).rejects.toMatchObject({
			code: "BAD_GATEWAY",
		});
		nothingWritten();
	});

	it("an environment that allows every branch", async () => {
		mocks.getEnvironmentPolicy.mockResolvedValue({
			kind: "ok",
			etag: null,
			value: {
				customBranchPolicies: false,
				protectedBranches: false,
				policies: [],
			},
		});
		await expect(
			callerFor("owner").connect(connectInput),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		nothingWritten();
	});

	it("repository-secret protection, for now", async () => {
		await expect(
			callerFor("owner").connect({
				...connectInput,
				protectionMode: "repository-secret",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		nothingWritten();
	});

	it("a registry prefix without a registry of this organization", async () => {
		mocks.registryRows = [];
		await expect(
			callerFor("owner").connect(connectInput),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		nothingWritten();
	});

	it("a git-sourced application that wants a private registry", async () => {
		mocks.findApplicationById.mockResolvedValue({
			applicationId: "app-1",
			sourceType: "github",
			owner: "DevinoSolutions",
			repository: "voicelabs",
			environment: { project: { organizationId: "org-a" } },
		});
		await expect(
			callerFor("owner").connect({
				...connectInput,
				serviceType: "application",
				serviceId: "app-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		nothingWritten();
	});

	it("a service that already follows GitHub Deployments or GitHub Actions", async () => {
		mocks.findGithubWatch.mockResolvedValue({ watchId: "w0" });
		await expect(
			callerFor("owner").connect(connectInput),
		).rejects.toMatchObject({
			code: "CONFLICT",
		});
		mocks.findGithubWatch.mockResolvedValue(null);
		mocks.findGhaConnection.mockResolvedValue(storedRow());
		await expect(
			callerFor("owner").connect(connectInput),
		).rejects.toMatchObject({
			code: "CONFLICT",
		});
		nothingWritten();
	});
});

describe("connect writes the watch and the connection", () => {
	it("stores the registry probe host from the Dokploy registry and the tracked commit", async () => {
		const saved = await callerFor("owner").connect(connectInput);
		expect(mocks.createGhaConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-a",
				serviceType: "compose",
				serviceId: "compose-1",
				githubConnectionId: "gh-1",
				repoId: 123,
				workflowPath: ".github/workflows/dokploy-web-build-deploy.yml",
				trackedBranch: "dev",
				environment: "development",
				serviceKey: "voicekit-web",
				registryPrefix: "localhost:5000/registry.devino.ca",
				registryId: "reg-1",
				registryProbeHost: "registry.devino.ca",
				state: "waiting",
				expectedSha: "a".repeat(40),
			}),
			expect.anything(),
		);
		// A raw compose has nothing to flip: no service row is changed.
		expect(mocks.updates).toEqual([]);
		expect(saved).not.toHaveProperty("previousSource");
		expect(saved).not.toHaveProperty("processed");
		expect(JSON.stringify(saved)).not.toContain("gho_secret_token");
	});

	it("turns git autodeploy off for an application built from git, and keeps its settings", async () => {
		mocks.findApplicationById.mockResolvedValue({
			applicationId: "app-1",
			sourceType: "github",
			owner: "DevinoSolutions",
			repository: "voicelabs",
			autoDeploy: true,
			branch: "dev",
			environment: { project: { organizationId: "org-a" } },
		});
		await callerFor("owner").connect({
			...connectInput,
			serviceType: "application",
			serviceId: "app-1",
			registryPrefix: null,
			registryId: null,
		});
		expect(mocks.updates).toEqual([{ autoDeploy: false }]);
		expect(mocks.createGhaConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				previousSource: expect.objectContaining({ sourceType: "github" }),
			}),
			expect.anything(),
		);
	});

	it("removes the watch again when the connection row cannot be saved", async () => {
		mocks.createGhaConnection.mockRejectedValue(new Error("db is down"));
		await expect(callerFor("owner").connect(connectInput)).rejects.toThrow(
			"db is down",
		);
		expect(mocks.deleteGithubWatch).toHaveBeenCalledWith(
			"compose",
			"compose-1",
		);
	});

	it("answers a unique violation as a conflict", async () => {
		mocks.createGhaConnection.mockRejectedValue(
			Object.assign(new Error("duplicate"), { cause: { code: "23505" } }),
		);
		await expect(
			callerFor("owner").connect(connectInput),
		).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.deleteGithubWatch).toHaveBeenCalled();
	});
});

describe("one never returns the saved source, the handled runs or a token", () => {
	it("returns the connection and its last releases", async () => {
		mocks.findGhaConnection.mockResolvedValue(storedRow());
		mocks.listReleases.mockResolvedValue([
			{
				releaseId: "r1",
				sha: "b".repeat(40),
				runId: 5,
				runAttempt: 1,
				delivery: "pull",
				status: "deployed",
				createdAt: new Date(),
				settledAt: new Date(),
				images: [{ ref: "private" }],
				sourceBackup: { secret: "backup-secret" },
			},
		]);
		const out = await callerFor("admin").one({
			serviceType: "compose",
			serviceId: "compose-1",
		});
		expect(out).toMatchObject({
			repository: "DevinoSolutions/voicelabs",
			releases: [{ releaseId: "r1", status: "deployed" }],
		});
		const text = JSON.stringify(out);
		for (const secret of [
			"super-secret-source",
			"backup-secret",
			"gho_secret_token",
			"999",
			"registryProbeHost",
		]) {
			expect(text).not.toContain(secret);
		}
	});

	it("is null for a connection of another organization and when there is none", async () => {
		mocks.findGhaConnection.mockResolvedValue(
			storedRow({ organizationId: "org-b" }),
		);
		expect(
			await callerFor("admin").one({
				serviceType: "compose",
				serviceId: "compose-1",
			}),
		).toBeNull();
		mocks.findGhaConnection.mockResolvedValue(null);
		expect(
			await callerFor("admin").one({
				serviceType: "compose",
				serviceId: "compose-1",
			}),
		).toBeNull();
	});

	it("checks read access to the service", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new TRPCError({ code: "UNAUTHORIZED", message: "no access" }),
		);
		await expect(
			callerFor("admin").one({
				serviceType: "compose",
				serviceId: "compose-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.findGhaConnection).not.toHaveBeenCalled();
	});
});

describe("disconnect", () => {
	it("puts an application back on its saved source, then removes the connection and the watch", async () => {
		mocks.findGhaConnection.mockResolvedValue(
			storedRow({
				serviceType: "application",
				serviceId: "app-1",
				previousSource: { sourceType: "github", autoDeploy: true },
			}),
		);
		mocks.findGithubWatch.mockResolvedValue({ watchId: "w1" });
		await callerFor("owner").disconnect({
			serviceType: "application",
			serviceId: "app-1",
			restoreSource: true,
		});
		expect(mocks.updates).toEqual([{ sourceType: "github", autoDeploy: true }]);
		expect(mocks.deleteGhaConnection).toHaveBeenCalledWith(
			"application",
			"app-1",
		);
		expect(mocks.deleteGithubWatch).toHaveBeenCalledWith(
			"application",
			"app-1",
		);
		expect(mocks.removeGhcrWatchConfigDirs).toHaveBeenCalledWith(
			["w1"],
			"org-a",
		);
	});

	it("leaves the service as it is when asked not to restore", async () => {
		mocks.findGhaConnection.mockResolvedValue(
			storedRow({
				serviceType: "application",
				serviceId: "app-1",
				previousSource: { sourceType: "github" },
			}),
		);
		await callerFor("owner").disconnect({
			serviceType: "application",
			serviceId: "app-1",
			restoreSource: false,
		});
		expect(mocks.updates).toEqual([]);
		expect(mocks.deleteGhaConnection).toHaveBeenCalled();
	});

	it("does nothing for a connection of another organization", async () => {
		mocks.findGhaConnection.mockResolvedValue(
			storedRow({ organizationId: "org-b" }),
		);
		expect(
			await callerFor("owner").disconnect({
				serviceType: "compose",
				serviceId: "compose-1",
				restoreSource: true,
			}),
		).toBe(true);
		expect(mocks.deleteGhaConnection).not.toHaveBeenCalled();
		expect(mocks.deleteGithubWatch).not.toHaveBeenCalled();
	});

	it("a plain member cannot disconnect", async () => {
		await expect(
			callerFor("member").disconnect({
				serviceType: "compose",
				serviceId: "compose-1",
				restoreSource: true,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.deleteGhaConnection).not.toHaveBeenCalled();
	});
});

describe("checkNow", () => {
	it("touches the activity time and unblocks a blocked connection", async () => {
		mocks.findGhaConnection.mockResolvedValue(
			storedRow({ state: "blocked", deployedSha: "c".repeat(40) }),
		);
		await callerFor("admin").checkNow({
			serviceType: "compose",
			serviceId: "compose-1",
		});
		expect(mocks.touchConnectionActivity).toHaveBeenCalledWith("gc-1");
		expect(mocks.applyConnectionEvent).toHaveBeenCalledWith(
			"gc-1",
			{ type: "unblock", hasRelease: true },
			null,
		);
	});

	it("is not found for a service that follows nothing, or one of another organization", async () => {
		await expect(
			callerFor("admin").checkNow({
				serviceType: "compose",
				serviceId: "compose-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		mocks.findGhaConnection.mockResolvedValue(
			storedRow({ organizationId: "org-b" }),
		);
		await expect(
			callerFor("admin").checkNow({
				serviceType: "compose",
				serviceId: "compose-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.touchConnectionActivity).not.toHaveBeenCalled();
	});
});
