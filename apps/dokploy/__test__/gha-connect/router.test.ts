import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audit } from "@/server/api/utils/audit";

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
	serviceRowExists: vi.fn(),
	listReleases: vi.fn(),
	applyConnectionEvent: vi.fn(),
	touchConnectionActivity: vi.fn(),
	updateGateSettings: vi.fn(),
	overrideGate: vi.fn(),
	findGatedRelease: vi.fn(),
	isCloud: false,
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
	get IS_CLOUD() {
		return mocks.isCloud;
	},
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
	serviceRowExists: mocks.serviceRowExists,
	touchConnectionActivity: mocks.touchConnectionActivity,
	updateGateSettings: mocks.updateGateSettings,
	overrideGate: mocks.overrideGate,
	findGatedRelease: mocks.findGatedRelease,
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
	mocks.serviceRowExists.mockResolvedValue(true);
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
			}),
			expect.anything(),
		);
	});

	it("creates the #577 watch disabled: nothing polls it until the connection poll takes over", async () => {
		await callerFor("owner").connect(connectInput);
		expect(mocks.upsertGithubWatch).toHaveBeenCalledTimes(1);
		expect(mocks.upsertGithubWatch.mock.calls[0]?.[0]).toMatchObject({
			enabled: false,
		});
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
	it("a private repository a public_repo-only connection cannot see (GitHub answers 404) hints at reconnecting with the repo scope", async () => {
		mocks.findGithubConnectionInOrganization.mockResolvedValue(
			account({ scopes: ["repo_deployment", "public_repo"] }),
		);
		mocks.getRepositoryByName.mockResolvedValue({ kind: "not-found" });
		await expect(
			callerFor("owner").connect(connectInput),
		).rejects.toMatchObject({
			code: "BAD_GATEWAY",
			message: expect.stringContaining(
				"reconnect GitHub with private repository access",
			),
		});
		nothingWritten();
	});

	it("a 404 with the repo scope is a plain not-found, without that hint", async () => {
		mocks.getRepositoryByName.mockResolvedValue({ kind: "not-found" });
		await expect(
			callerFor("owner").connect(connectInput),
		).rejects.toMatchObject({
			message: expect.not.stringContaining("reconnect GitHub"),
		});
	});

	it("a readable private repository whose connection lacks the repo scope", async () => {
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
		// The provider switch (T-13879): the stack gets the github-actions source type, nothing else changes.
		expect(mocks.updates).toEqual([{ sourceType: "github-actions" }]);
		expect(mocks.createGhaConnection).toHaveBeenCalledWith(
			expect.objectContaining({ previousSource: { sourceType: "raw" } }),
			expect.anything(),
		);
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
		expect(mocks.updates).toEqual([
			{ autoDeploy: false, sourceType: "github-actions" },
		]);
		expect(mocks.createGhaConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				previousSource: expect.objectContaining({ sourceType: "github" }),
			}),
			expect.anything(),
		);
	});

	it("writes the watch inside the same transaction as the connection row, and never deletes a watch itself", async () => {
		await callerFor("owner").connect(connectInput);
		const txOfWatch = mocks.upsertGithubWatch.mock.calls[0]?.[1];
		const txOfRow = mocks.createGhaConnection.mock.calls[0]?.[1];
		expect(txOfWatch).toBeDefined();
		expect(txOfWatch).toBe(txOfRow);
		mocks.createGhaConnection.mockRejectedValue(new Error("db is down"));
		await expect(callerFor("owner").connect(connectInput)).rejects.toThrow(
			"db is down",
		);
		// The rollback removes what this call wrote; a watch it did not create
		// (a concurrent connect's) is never touched.
		expect(mocks.deleteGithubWatch).not.toHaveBeenCalled();
	});

	it("answers a unique violation as a conflict", async () => {
		mocks.createGhaConnection.mockRejectedValue(
			Object.assign(new Error("duplicate"), { cause: { code: "23505" } }),
		);
		await expect(
			callerFor("owner").connect(connectInput),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("is already connected"),
		});
		expect(mocks.deleteGithubWatch).not.toHaveBeenCalled();
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
			expect.anything(),
		);
		expect(mocks.deleteGithubWatch).toHaveBeenCalledWith(
			"application",
			"app-1",
			expect.anything(),
		);
		expect(mocks.removeGhcrWatchConfigDirs).toHaveBeenCalledWith(
			["w1"],
			"org-a",
		);
	});

	it("keeps the image the service runs and drops a provider deleted while it was connected", async () => {
		mocks.findGhaConnection.mockResolvedValue(
			storedRow({
				serviceType: "application",
				serviceId: "app-1",
				previousSource: {
					sourceType: "github",
					autoDeploy: true,
					githubId: "gh-deleted",
					dockerImage: "ghcr.io/acme/shop:latest",
				},
			}),
		);
		// The provider row is gone: the lookup finds nothing.
		mocks.registryRows = [];
		await callerFor("owner").disconnect({
			serviceType: "application",
			serviceId: "app-1",
			restoreSource: true,
		});
		expect(mocks.updates).toEqual([
			{ sourceType: "github", autoDeploy: true, githubId: null },
		]);
	});

	it("keeps the provider reference when the record still exists", async () => {
		mocks.findGhaConnection.mockResolvedValue(
			storedRow({
				serviceType: "application",
				serviceId: "app-1",
				previousSource: { sourceType: "github", githubId: "gh-1" },
			}),
		);
		mocks.registryRows = [{ registryUrl: "row-exists" }];
		await callerFor("owner").disconnect({
			serviceType: "application",
			serviceId: "app-1",
			restoreSource: true,
		});
		expect(mocks.updates).toEqual([{ sourceType: "github", githubId: "gh-1" }]);
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
		// Not restoring means staying on the image: the source type is no longer github-actions (the write
		// only touches a service that still is).
		expect(mocks.updates).toEqual([{ sourceType: "docker" }]);
		expect(mocks.deleteGhaConnection).toHaveBeenCalled();
	});

	it("puts a compose stack back on its stored file, or leaves it on the file when not restoring", async () => {
		mocks.findGhaConnection.mockResolvedValue(
			storedRow({ previousSource: { sourceType: "raw" } }),
		);
		await callerFor("owner").disconnect({
			serviceType: "compose",
			serviceId: "compose-1",
			restoreSource: true,
		});
		await callerFor("owner").disconnect({
			serviceType: "compose",
			serviceId: "compose-1",
			restoreSource: false,
		});
		expect(mocks.updates).toEqual([
			{ sourceType: "raw" },
			{ sourceType: "raw" },
		]);
	});

	it("a connection saved without a source type only gets the fallback write", async () => {
		mocks.findGhaConnection.mockResolvedValue(
			storedRow({
				serviceType: "application",
				serviceId: "app-1",
				previousSource: { autoDeploy: true },
			}),
		);
		await callerFor("owner").disconnect({
			serviceType: "application",
			serviceId: "app-1",
			restoreSource: true,
		});
		expect(mocks.updates).toEqual([{ sourceType: "docker" }]);
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

describe("disconnect when the service is gone", () => {
	const gone = {
		serviceType: "application" as const,
		serviceId: "app-1",
		restoreSource: true,
	};
	beforeEach(() => {
		mocks.serviceRowExists.mockResolvedValue(false);
		mocks.findGhaConnection.mockResolvedValue(
			storedRow({
				serviceType: "application",
				serviceId: "app-1",
				previousSource: { sourceType: "github" },
			}),
		);
		mocks.findGithubWatch.mockResolvedValue({ watchId: "w1" });
	});

	it.each(["owner", "admin"] as const)(
		"lets an %s clear the connection and its watch without a service permission check, and restores nothing",
		async (role) => {
			await callerFor(role).disconnect(gone);
			expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
			expect(mocks.updates).toEqual([]);
			expect(mocks.deleteGhaConnection).toHaveBeenCalledWith(
				"application",
				"app-1",
				expect.anything(),
			);
			expect(mocks.deleteGithubWatch).toHaveBeenCalledWith(
				"application",
				"app-1",
				expect.anything(),
			);
		},
	);

	it("leaves it to an owner or admin for a member", async () => {
		mocks.memberGitProviderActions = ["create"];
		await expect(callerFor("member").disconnect(gone)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.deleteGhaConnection).not.toHaveBeenCalled();
	});

	it("never touches a connection of another organization", async () => {
		mocks.findGhaConnection.mockResolvedValue(
			storedRow({ organizationId: "org-b" }),
		);
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new TRPCError({ code: "NOT_FOUND", message: "Service not found" }),
		);
		await expect(callerFor("admin").disconnect(gone)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.deleteGhaConnection).not.toHaveBeenCalled();
	});
});

describe("checkNow is gated like disconnect, not like a read", () => {
	it("needs service create and deployment create on the service", async () => {
		mocks.findGhaConnection.mockResolvedValue(storedRow());
		await callerFor("admin").checkNow({
			serviceType: "compose",
			serviceId: "compose-1",
		});
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"compose-1",
			{ service: ["create"], deployment: ["create"] },
		);
	});

	it("refuses a read-only member before anything changes", async () => {
		mocks.memberGitProviderActions = ["read"];
		await expect(
			callerFor("member").checkNow({
				serviceType: "compose",
				serviceId: "compose-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.touchConnectionActivity).not.toHaveBeenCalled();
		expect(mocks.applyConnectionEvent).not.toHaveBeenCalled();
	});

	it("refuses a member who may manage git providers but has no create access to the service", async () => {
		mocks.memberGitProviderActions = ["create"];
		mocks.findGhaConnection.mockResolvedValue(storedRow());
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new TRPCError({ code: "FORBIDDEN", message: "no access" }),
		);
		await expect(
			callerFor("member").checkNow({
				serviceType: "compose",
				serviceId: "compose-1",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.touchConnectionActivity).not.toHaveBeenCalled();
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

const gateStored = (overrides: Record<string, unknown> = {}) =>
	storedRow({
		gateMode: "checks",
		gateWorkflows: [],
		gateTimeoutMinutes: 60,
		...overrides,
	});

describe("connect takes the deploy gate settings", () => {
	it("stores the gate mode, the workflows and the timeout", async () => {
		await callerFor("owner").connect({
			...connectInput,
			gateMode: "workflows",
			gateWorkflows: ["CI", "Security"],
			gateTimeoutMinutes: 90,
		});
		expect(mocks.createGhaConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				gateMode: "workflows",
				gateWorkflows: ["CI", "Security"],
				gateTimeoutMinutes: 90,
			}),
			expect.anything(),
		);
	});

	it("defaults to the image gate, no workflows and 60 minutes", async () => {
		await callerFor("owner").connect(connectInput);
		expect(mocks.createGhaConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				gateMode: "image",
				gateWorkflows: [],
				gateTimeoutMinutes: 60,
			}),
			expect.anything(),
		);
	});

	it.each([
		["workflows without names", { gateMode: "workflows" }],
		[
			"workflows with an empty list",
			{ gateMode: "workflows", gateWorkflows: [] },
		],
		[
			"more than 20 workflows",
			{
				gateMode: "workflows",
				gateWorkflows: Array.from({ length: 21 }, (_, i) => `w${i}`),
			},
		],
		["an empty workflow name", { gateMode: "workflows", gateWorkflows: [""] }],
		[
			"a workflow name over 100 characters",
			{ gateMode: "workflows", gateWorkflows: ["x".repeat(101)] },
		],
		["a timeout under 5 minutes", { gateTimeoutMinutes: 4 }],
		["a timeout over 720 minutes", { gateTimeoutMinutes: 721 }],
		["a fractional timeout", { gateTimeoutMinutes: 10.5 }],
		["an unknown mode", { gateMode: "always" }],
	])("refuses %s before anything is read", async (_label, extra) => {
		await expect(
			callerFor("owner").connect({ ...connectInput, ...extra } as never),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.findGithubConnectionInOrganization).not.toHaveBeenCalled();
		nothingWritten();
	});
});

const settings = (over: Record<string, unknown> = {}) => ({
	gateMode: "checks",
	gateWorkflows: [] as string[],
	gateTimeoutMinutes: 60,
	...over,
});

describe("update changes the deploy gate", () => {
	const target = { serviceType: "compose" as const, serviceId: "compose-1" };

	beforeEach(() => {
		mocks.findGhaConnection.mockResolvedValue(gateStored());
		mocks.findGatedRelease.mockResolvedValue(null);
		mocks.updateGateSettings.mockResolvedValue({
			before: settings(),
			after: settings({ gateMode: "workflows", gateWorkflows: ["CI"] }),
			restarted: true,
		});
	});

	it("saves the change and answers the presented connection, with the gate fields", async () => {
		mocks.findGhaConnection
			.mockResolvedValueOnce(gateStored())
			.mockResolvedValueOnce(
				gateStored({
					gateMode: "workflows",
					gateWorkflows: ["CI"],
					gateTimeoutMinutes: 30,
				}),
			);
		const saved = await callerFor("admin").update({
			...target,
			gateMode: "workflows",
			gateWorkflows: ["CI"],
			gateTimeoutMinutes: 30,
		});
		expect(mocks.updateGateSettings).toHaveBeenCalledWith("gc-1", {
			gateMode: "workflows",
			gateWorkflows: ["CI"],
			gateTimeoutMinutes: 30,
		});
		expect(saved).toMatchObject({
			gateMode: "workflows",
			gateWorkflows: ["CI"],
			gateTimeoutMinutes: 30,
		});
		expect(saved).not.toHaveProperty("previousSource");
	});

	it("audits every change with the settings before and after", async () => {
		await callerFor("admin").update({
			...target,
			gateMode: "workflows",
			gateWorkflows: ["CI"],
		});
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "update",
				resourceId: "compose-1",
				metadata: {
					before: settings(),
					after: settings({ gateMode: "workflows", gateWorkflows: ["CI"] }),
					restarted: true,
				},
			}),
		);
	});

	it("is gated like disconnect", async () => {
		await callerFor("admin").update({ ...target, gateTimeoutMinutes: 30 });
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"compose-1",
			{ service: ["create"], deployment: ["create"] },
		);
		await expect(
			callerFor("member").update({ ...target, gateTimeoutMinutes: 30 }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("refuses an empty change", async () => {
		await expect(callerFor("admin").update(target)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Nothing to change",
		});
		expect(mocks.updateGateSettings).not.toHaveBeenCalled();
	});

	it("refuses the workflows gate with no workflows, counting the ones already saved", async () => {
		await expect(
			callerFor("admin").update({ ...target, gateMode: "workflows" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateGateSettings).not.toHaveBeenCalled();
		mocks.findGhaConnection.mockResolvedValue(
			gateStored({ gateWorkflows: ["CI"] }),
		);
		await callerFor("admin").update({ ...target, gateMode: "workflows" });
		expect(mocks.updateGateSettings).toHaveBeenCalled();
	});

	it("checks the bounds of every field", async () => {
		for (const bad of [
			{ gateTimeoutMinutes: 4 },
			{ gateTimeoutMinutes: 721 },
			{ gateWorkflows: ["x".repeat(101)] },
			{ gateWorkflows: Array.from({ length: 21 }, (_, i) => `w${i}`) },
		]) {
			await expect(
				callerFor("admin").update({ ...target, ...bad }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(mocks.updateGateSettings).not.toHaveBeenCalled();
	});

	it("is not found for a service that follows nothing, or one of another organization", async () => {
		mocks.findGhaConnection.mockResolvedValue(null);
		await expect(
			callerFor("admin").update({ ...target, gateTimeoutMinutes: 30 }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		mocks.findGhaConnection.mockResolvedValue(
			gateStored({ organizationId: "org-b" }),
		);
		await expect(
			callerFor("admin").update({ ...target, gateTimeoutMinutes: 30 }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updateGateSettings).not.toHaveBeenCalled();
	});

	it("is not available in the cloud version", async () => {
		mocks.isCloud = true;
		try {
			await expect(
				callerFor("admin").update({ ...target, gateTimeoutMinutes: 30 }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(mocks.updateGateSettings).not.toHaveBeenCalled();
		} finally {
			mocks.isCloud = false;
		}
	});

	describe("a member who may manage git providers", () => {
		beforeEach(() => {
			mocks.memberGitProviderActions = ["create"];
		});

		it.each([
			["turn the gate off", { gateMode: "image" as const }],
			[
				"swap checks for workflows",
				{ gateMode: "workflows" as const, gateWorkflows: ["CI"] },
			],
			["wait longer", { gateTimeoutMinutes: 120 }],
		])("cannot %s", async (_label, change) => {
			await expect(
				callerFor("member").update({ ...target, ...change }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: "Only an organization owner or admin can loosen the gate",
			});
			expect(mocks.updateGateSettings).not.toHaveBeenCalled();
		});

		it("cannot remove a workflow", async () => {
			mocks.findGhaConnection.mockResolvedValue(
				gateStored({ gateMode: "workflows", gateWorkflows: ["CI", "Lint"] }),
			);
			await expect(
				callerFor("member").update({ ...target, gateWorkflows: ["CI"] }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.updateGateSettings).not.toHaveBeenCalled();
		});

		it("can tighten the gate while nothing waits on it", async () => {
			mocks.findGhaConnection.mockResolvedValue(
				gateStored({ gateMode: "image" }),
			);
			await callerFor("member").update({ ...target, gateMode: "checks" });
			expect(mocks.updateGateSettings).toHaveBeenCalled();
			mocks.updateGateSettings.mockClear();
			mocks.findGhaConnection.mockResolvedValue(gateStored());
			await callerFor("member").update({ ...target, gateTimeoutMinutes: 30 });
			expect(mocks.updateGateSettings).toHaveBeenCalled();
		});

		it("cannot change anything while an accepted release has not been looked at yet", async () => {
			mocks.findGatedRelease.mockResolvedValue({
				releaseId: "rel-1",
				gateState: null,
			});
			await expect(
				callerFor("member").update({ ...target, gateTimeoutMinutes: 30 }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.updateGateSettings).not.toHaveBeenCalled();
		});

		it.each(["waiting", "blocked"])(
			"cannot change anything while a release is %s",
			async (gateState) => {
				mocks.findGatedRelease.mockResolvedValue({
					releaseId: "rel-1",
					gateState,
				});
				await expect(
					callerFor("member").update({ ...target, gateTimeoutMinutes: 30 }),
				).rejects.toMatchObject({
					code: "FORBIDDEN",
					message: expect.stringContaining("release is waiting"),
				});
				expect(mocks.updateGateSettings).not.toHaveBeenCalled();
			},
		);
	});

	it.each(["owner", "admin"] as const)(
		"an %s may loosen the gate, even while a release is blocked",
		async (role) => {
			mocks.findGatedRelease.mockResolvedValue({
				releaseId: "rel-1",
				gateState: "blocked",
			});
			await callerFor(role).update({ ...target, gateMode: "image" });
			expect(mocks.updateGateSettings).toHaveBeenCalledWith("gc-1", {
				gateMode: "image",
				gateWorkflows: undefined,
				gateTimeoutMinutes: undefined,
			});
		},
	);
});

describe("deployAnyway", () => {
	const target = {
		serviceType: "compose" as const,
		serviceId: "compose-1",
		releaseId: "rel-1",
	};

	beforeEach(() => {
		mocks.findGhaConnection.mockResolvedValue(gateStored());
		mocks.overrideGate.mockResolvedValue({
			kind: "ok",
			releaseId: "rel-1",
			sha: "c".repeat(40),
		});
	});

	it.each(["owner", "admin"] as const)(
		"lets an %s do it, records who and why, and answers deploy",
		async (role) => {
			const result = await callerFor(role).deployAnyway({
				...target,
				reason: "hotfix for the outage",
			});
			expect(result).toEqual({ decision: "deploy", sha: "c".repeat(40) });
			expect(mocks.overrideGate).toHaveBeenCalledWith("gc-1", "rel-1", {
				by: "u@example.com",
				at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				reason: "hotfix for the outage",
			});
			expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
				expect.anything(),
				"compose-1",
				{ service: ["create"], deployment: ["create"] },
			);
			expect(audit).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					action: "deploy",
					resourceId: "compose-1",
					metadata: { reason: "hotfix for the outage", releaseId: "rel-1" },
				}),
			);
		},
	);

	it("needs the release to name", async () => {
		await expect(
			callerFor("owner").deployAnyway({
				serviceType: "compose",
				serviceId: "compose-1",
			} as never),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.overrideGate).not.toHaveBeenCalled();
	});

	it("is a conflict when a newer release has arrived", async () => {
		mocks.overrideGate.mockResolvedValue({
			kind: "conflict",
			newestReleaseId: "rel-2",
			newestSha: "d".repeat(40),
		});
		await expect(callerFor("owner").deployAnyway(target)).rejects.toMatchObject(
			{
				code: "CONFLICT",
				message: expect.stringContaining("ddddddd"),
			},
		);
		expect(audit).not.toHaveBeenCalled();
	});

	it("refuses a member, even one with git provider access, and changes nothing", async () => {
		mocks.memberGitProviderActions = ["create"];
		await expect(
			callerFor("member").deployAnyway(target),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.overrideGate).not.toHaveBeenCalled();
	});

	it("is not found for a service that follows nothing or another organization's", async () => {
		mocks.findGhaConnection.mockResolvedValue(
			gateStored({ organizationId: "org-b" }),
		);
		await expect(callerFor("owner").deployAnyway(target)).rejects.toMatchObject(
			{ code: "NOT_FOUND" },
		);
		expect(mocks.overrideGate).not.toHaveBeenCalled();
	});

	it("says so when no release is waiting", async () => {
		mocks.overrideGate.mockResolvedValue({ kind: "none" });
		await expect(callerFor("owner").deployAnyway(target)).rejects.toMatchObject(
			{
				code: "BAD_REQUEST",
				message: "No release is waiting to be deployed",
			},
		);
		expect(audit).not.toHaveBeenCalled();
	});

	it("keeps the reason within 300 characters", async () => {
		await expect(
			callerFor("owner").deployAnyway({ ...target, reason: "x".repeat(301) }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("one shows the gate of each release", () => {
	it("returns gateState and gateReason, not the learned set or who overrode", async () => {
		mocks.findGhaConnection.mockResolvedValue(gateStored());
		mocks.listReleases.mockResolvedValue([
			{
				releaseId: "rel-1",
				sha: "a".repeat(40),
				runId: 1,
				runAttempt: 1,
				delivery: "pull",
				status: "accepted",
				gateState: "blocked",
				gateReason: "Check test failed",
				gateExpected: { source: "required", names: ["test"] },
				gateOverride: { by: "x@y.z", at: "now", reason: null },
				createdAt: new Date(),
				settledAt: null,
			},
		]);
		const connection = await callerFor("admin").one({
			serviceType: "compose",
			serviceId: "compose-1",
		});
		expect(connection?.releases[0]).toMatchObject({
			gateState: "blocked",
			gateReason: "Check test failed",
		});
		expect(JSON.stringify(connection)).not.toContain("x@y.z");
		expect(connection).toMatchObject({
			gateMode: "checks",
			gateTimeoutMinutes: 60,
		});
	});
});

describe("testConnection (Test connection in the Connect flow)", () => {
	it("runs the Connect checks and writes nothing", async () => {
		const result = await callerFor("owner").testConnection(connectInput);
		expect(result).toEqual({
			ok: true,
			repository: "DevinoSolutions/voicelabs",
			branchHead: "a".repeat(40),
		});
		nothingWritten();
	});

	it("answers a failed check with the sentence that says what to fix, not an error", async () => {
		mocks.getEnvironmentPolicy.mockResolvedValue({
			kind: "ok",
			etag: null,
			value: {
				customBranchPolicies: false,
				protectedBranches: false,
				policies: [],
			},
		});
		const result = await callerFor("owner").testConnection(connectInput);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("development");
		nothingWritten();
	});

	it("needs the same access as connect", async () => {
		await expect(
			callerFor("member").testConnection(connectInput),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.getRepositoryByName).not.toHaveBeenCalled();
	});

	it("refuses a GitHub account of another member like connect does", async () => {
		mocks.memberGitProviderActions = ["create"];
		mocks.findGithubConnectionInOrganization.mockResolvedValue(
			account({ createdByUserId: "someone-else" }),
		);
		await expect(
			callerFor("member", "user-1").testConnection(connectInput),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("snippet", () => {
	const input = {
		mode: "build" as const,
		repository: "acme/shop",
		serviceKey: "web",
		trackedBranch: "dev",
		environment: "development",
	};

	it("returns the workflow to create, and writes nothing", async () => {
		mocks.memberGitProviderActions = ["read"];
		const result = await callerFor("member").snippet(input);
		expect(result.kind).toBe("file");
		expect(result.path).toBe(".github/workflows/dokploy.yml");
		expect(result.yaml).toContain("dokploy-release@v1");
		expect(result.yaml).toContain(
			"existing-image: ${{ needs.build.outputs.image }}",
		);
		expect(result.yaml).not.toContain("environments:");
		nothingWritten();
	});

	it("returns the job to add to the user's own workflow", async () => {
		const result = await callerFor("owner").snippet({
			mode: "existing",
			serviceKey: "web",
			trackedBranch: "dev",
			environment: "development",
			buildJob: "compose",
			imageOutput: "image",
		});
		expect(result.kind).toBe("job");
		expect(result.yaml).toContain("needs: compose");
		expect(result.yaml).toContain("environment: development");
	});

	it("asks for what the mode needs", async () => {
		await expect(
			callerFor("owner").snippet({ ...input, repository: undefined }),
		).rejects.toBeInstanceOf(TRPCError);
		await expect(
			callerFor("owner").snippet({
				mode: "existing",
				serviceKey: "web",
				trackedBranch: "dev",
				environment: "development",
				buildJob: "compose",
			}),
		).rejects.toBeInstanceOf(TRPCError);
	});

	it("is refused as bad input when a value could change the workflow", async () => {
		await expect(
			callerFor("owner").snippet({ ...input, trackedBranch: "dev; x" }),
		).rejects.toBeInstanceOf(TRPCError);
	});
});
