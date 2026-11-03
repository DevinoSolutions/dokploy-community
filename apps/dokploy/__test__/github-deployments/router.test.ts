import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	member: {
		role: "member" as string,
		accessedServices: [] as string[],
	},
	/** A member the admin granted read access to git providers (legacy flag). */
	memberMayReadGitProviders: false,
	/** gitProviders actions a custom role gives a plain member (read, create, delete). */
	memberGitProviderActions: [] as string[],
	serviceOrganizationId: "org-a",
	checkServicePermissionAndAccess: vi.fn(),
	beginGithubConnect: vi.fn(),
	deleteGithubConnection: vi.fn(),
	deleteGithubWatch: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	countGhaConnectionsForGithubConnection: vi.fn(),
	findGhaConnection: vi.fn(),
	findGithubConnectionInOrganization: vi.fn(),
	findGithubWatch: vi.fn(),
	findRecentOtherGithubDeployer: vi.fn(),
	listGithubConnectionRecords: vi.fn(),
	setGithubConnectionShared: vi.fn(),
	listGithubWatchesForConnection: vi.fn(),
	listGithubWatchesForOrganization: vi.fn(),
	progressGithubConnect: vi.fn(),
	removeGhcrWatchConfigDirs: vi.fn(),
	upsertGithubConnection: vi.fn(),
	upsertGithubWatch: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({ db: {} }));
vi.mock("@dokploy/server/services/gha-connect", () => ({
	countGhaConnectionsForGithubConnection:
		mocks.countGhaConnectionsForGithubConnection,
	findGhaConnection: mocks.findGhaConnection,
}));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

// The real role statements decide checkPermission here, so "a member cannot
// create a git provider thing" is a fact about the product, not about a stub.
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
			if (
				ctx.user.role === "member" &&
				mocks.memberMayReadGitProviders &&
				JSON.stringify(permissions) ===
					JSON.stringify({ gitProviders: ["read"] })
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
		findMemberByUserId: vi.fn(async () => mocks.member),
		checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	};
});

// The real ownership rules decide who may bind, list, share and remove a
// connection here, so "another member cannot use it" is a fact about the
// product, not about a stub.
vi.mock("@dokploy/server", async () => ({
	...(await vi.importActual<object>(
		"@dokploy/server/services/github-deployments/connection-access",
	)),
	IS_CLOUD: false,
	createGithubFetch: () => vi.fn(),
	beginGithubConnect: mocks.beginGithubConnect,
	deleteGithubConnection: mocks.deleteGithubConnection,
	deleteGithubWatch: mocks.deleteGithubWatch,
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
	findGithubConnectionInOrganization: mocks.findGithubConnectionInOrganization,
	findGithubWatch: mocks.findGithubWatch,
	findRecentOtherGithubDeployer: mocks.findRecentOtherGithubDeployer,
	listGithubConnectionRecords: mocks.listGithubConnectionRecords,
	setGithubConnectionShared: mocks.setGithubConnectionShared,
	listGithubWatchesForConnection: mocks.listGithubWatchesForConnection,
	listGithubWatchesForOrganization: mocks.listGithubWatchesForOrganization,
	presentGithubWatch: (row: unknown) => row,
	progressGithubConnect: mocks.progressGithubConnect,
	removeGhcrWatchConfigDirs: mocks.removeGhcrWatchConfigDirs,
	upsertGithubConnection: mocks.upsertGithubConnection,
	upsertGithubWatch: mocks.upsertGithubWatch,
}));

const { githubDeploymentRouter } = await import(
	"@/server/api/routers/github-deployment"
);

const callerFor = (
	role: "owner" | "admin" | "member",
	organizationId = "org-a",
	userId = "user-1",
) =>
	githubDeploymentRouter.createCaller({
		session: { activeOrganizationId: organizationId },
		user: { id: userId, email: "u@example.com", role },
	} as Parameters<typeof githubDeploymentRouter.createCaller>[0]);

const setInput = {
	serviceType: "application" as const,
	serviceId: "app-1",
	connectionId: "conn-1",
	owner: "DevinoSolutions",
	repo: "sendly",
	environment: "production",
	enabled: true,
	postLogUrl: false,
};
const connection = (overrides: Record<string, unknown> = {}) => ({
	connectionId: "conn-1",
	githubLogin: "amin",
	scopes: ["repo_deployment", "read:packages"],
	status: "active",
	lastError: null,
	createdAt: new Date("2026-11-01T00:00:00Z"),
	createdByUserId: "user-1",
	sharedWithOrganization: false,
	...overrides,
});
const watchRow = (overrides: Record<string, unknown> = {}) => ({
	watchId: "w1",
	organizationId: "org-a",
	serviceType: "application",
	serviceId: "app-1",
	connectionId: "conn-1",
	owner: "DevinoSolutions",
	repo: "sendly",
	environment: "production",
	enabled: true,
	postLogUrl: false,
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.member.role = "member";
	mocks.member.accessedServices = [];
	mocks.memberMayReadGitProviders = false;
	mocks.memberGitProviderActions = [];
	mocks.serviceOrganizationId = "org-a";
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findApplicationById.mockImplementation(async () => ({
		applicationId: "app-1",
		environment: { project: { organizationId: mocks.serviceOrganizationId } },
	}));
	mocks.findComposeById.mockImplementation(async () => ({
		composeId: "c-1",
		environment: { project: { organizationId: mocks.serviceOrganizationId } },
	}));
	mocks.findGithubConnectionInOrganization.mockResolvedValue(
		connection({ connectionId: "conn-1", createdByUserId: "user-1" }),
	);
	mocks.findRecentOtherGithubDeployer.mockResolvedValue(null);
	mocks.setGithubConnectionShared.mockResolvedValue({ connectionId: "conn-1" });
	mocks.listGithubConnectionRecords.mockResolvedValue([]);
	mocks.upsertGithubWatch.mockImplementation(async (input) =>
		watchRow({ ...input }),
	);
	mocks.listGithubWatchesForOrganization.mockResolvedValue([watchRow()]);
	mocks.listGithubWatchesForConnection.mockResolvedValue([
		watchRow({ watchId: "w1" }),
		watchRow({ watchId: "w2", serviceId: "app-2" }),
	]);
	mocks.deleteGithubConnection.mockResolvedValue(true);
	mocks.removeGhcrWatchConfigDirs.mockResolvedValue(undefined);
	mocks.findGithubWatch.mockResolvedValue(watchRow());
	mocks.findGhaConnection.mockResolvedValue(null);
	mocks.countGhaConnectionsForGithubConnection.mockResolvedValue(0);
});

describe("watchSet and watchRemove need to be allowed to manage git providers AND to deploy", () => {
	it.each(["watchSet", "watchRemove"] as const)(
		"%s: a plain member is refused before anything is read or written",
		async (procedure) => {
			const input =
				procedure === "watchSet"
					? setInput
					: { serviceType: "application" as const, serviceId: "app-1" };
			await expect(
				(callerFor("member")[procedure] as any)(input),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
			expect(mocks.upsertGithubWatch).not.toHaveBeenCalled();
			expect(mocks.findGithubWatch).not.toHaveBeenCalled();
		},
	);

	it.each(["owner", "admin"] as const)(
		"watchSet: an %s passes, with service create AND deployment create on the service",
		async (role) => {
			await callerFor(role).watchSet(setInput);
			expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
				expect.anything(),
				"app-1",
				{ service: ["create"], deployment: ["create"] },
			);
			expect(mocks.upsertGithubWatch).toHaveBeenCalledWith(
				expect.objectContaining({
					organizationId: "org-a",
					postLogUrl: false,
				}),
			);
		},
	);

	it("watchSet: an admin whose service access check fails writes nothing", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new TRPCError({ code: "UNAUTHORIZED", message: "no access" }),
		);
		await expect(callerFor("admin").watchSet(setInput)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.upsertGithubWatch).not.toHaveBeenCalled();
	});

	it("watchSet: a service of another organization is not found", async () => {
		mocks.serviceOrganizationId = "org-b";
		await expect(callerFor("admin").watchSet(setInput)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.upsertGithubWatch).not.toHaveBeenCalled();
	});

	it("watchSet: a connection of another organization is not found", async () => {
		mocks.findGithubConnectionInOrganization.mockResolvedValue(null);
		await expect(callerFor("admin").watchSet(setInput)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.findGithubConnectionInOrganization).toHaveBeenCalledWith(
			"conn-1",
			"org-a",
		);
		expect(mocks.upsertGithubWatch).not.toHaveBeenCalled();
	});

	it("watchSet: the opt-in to the dashboard link is off unless asked for", async () => {
		const { postLogUrl: _omit, ...withoutIt } = setInput;
		await callerFor("admin").watchSet(withoutIt);
		expect(mocks.upsertGithubWatch).toHaveBeenCalledWith(
			expect.objectContaining({ postLogUrl: false }),
		);
		await callerFor("admin").watchSet({ ...setInput, postLogUrl: true });
		expect(mocks.upsertGithubWatch).toHaveBeenLastCalledWith(
			expect.objectContaining({ postLogUrl: true }),
		);
	});

	it("watchSet: turning a watch off deletes its docker login from the hosts", async () => {
		await callerFor("admin").watchSet({ ...setInput, enabled: false });
		expect(mocks.removeGhcrWatchConfigDirs).toHaveBeenCalledWith(
			["w1"],
			"org-a",
		);
		mocks.removeGhcrWatchConfigDirs.mockClear();
		await callerFor("admin").watchSet(setInput);
		expect(mocks.removeGhcrWatchConfigDirs).not.toHaveBeenCalled();
	});

	it("watchRemove: needs service and deployment create, deletes the watch and its docker login", async () => {
		await callerFor("admin").watchRemove({
			serviceType: "application",
			serviceId: "app-1",
		});
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"app-1",
			{ service: ["create"], deployment: ["create"] },
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

	it("watchRemove: a watch of another organization is left alone", async () => {
		mocks.findGithubWatch.mockResolvedValue(
			watchRow({ organizationId: "org-b" }),
		);
		await callerFor("admin").watchRemove({
			serviceType: "application",
			serviceId: "app-1",
		});
		expect(mocks.deleteGithubWatch).not.toHaveBeenCalled();
		expect(mocks.removeGhcrWatchConfigDirs).not.toHaveBeenCalled();
	});
});

describe("a connection is its owner's: another member of the organization cannot spend its token", () => {
	const ATTACKER = "user-attacker";
	const VICTIM = "user-victim";
	/** A member whose custom role may manage git providers (read, create, delete). */
	const attacker = () => {
		mocks.memberGitProviderActions = ["read", "create", "delete"];
		return callerFor("member", "org-a", ATTACKER);
	};
	const victimsConnection = (overrides: Record<string, unknown> = {}) =>
		connection({
			connectionId: "conn-victim",
			githubLogin: "victim",
			createdByUserId: VICTIM,
			...overrides,
		});
	const bindVictims = () => ({ ...setInput, connectionId: "conn-victim" });

	beforeEach(() => {
		mocks.findGithubConnectionInOrganization.mockImplementation(
			async (id: string) =>
				id === "conn-victim" ? victimsConnection() : connection(),
		);
	});

	it("watchSet: the attacker cannot bind the victim's connection to a service", async () => {
		const input = bindVictims();
		await expect(attacker().watchSet(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.upsertGithubWatch).not.toHaveBeenCalled();
	});

	it("watchSet: not even when the watch already uses that connection (only the service change is theirs)", async () => {
		mocks.findGithubWatch.mockResolvedValue(
			watchRow({ connectionId: "conn-victim" }),
		);
		const input = bindVictims();
		await expect(attacker().watchSet(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.upsertGithubWatch).not.toHaveBeenCalled();
	});

	it("watchSet: the attacker can bind their own connection", async () => {
		mocks.findGithubConnectionInOrganization.mockResolvedValue(
			connection({ connectionId: "conn-mine", createdByUserId: ATTACKER }),
		);
		await attacker().watchSet({ ...setInput, connectionId: "conn-mine" });
		expect(mocks.upsertGithubWatch).toHaveBeenCalledWith(
			expect.objectContaining({ connectionId: "conn-mine" }),
		);
	});

	it("watchSet: the victim, an admin and an owner can bind the victim's connection", async () => {
		const input = bindVictims();
		mocks.memberGitProviderActions = ["create"];
		await callerFor("member", "org-a", VICTIM).watchSet(input);
		await callerFor("admin", "org-a", "user-admin").watchSet(input);
		await callerFor("owner", "org-a", "user-owner").watchSet(input);
		expect(mocks.upsertGithubWatch).toHaveBeenCalledTimes(3);
	});

	it("watchSet: a connection the owner shared with the organization can be bound by a member", async () => {
		mocks.findGithubConnectionInOrganization.mockImplementation(async () =>
			victimsConnection({ sharedWithOrganization: true }),
		);
		const input = bindVictims();
		await attacker().watchSet(input);
		expect(mocks.upsertGithubWatch).toHaveBeenCalledWith(
			expect.objectContaining({ connectionId: "conn-victim" }),
		);
	});

	it("disconnect: the attacker cannot remove the victim's connection, its watches or its docker logins", async () => {
		await expect(
			attacker().disconnect({ connectionId: "conn-victim" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.deleteGithubConnection).not.toHaveBeenCalled();
		expect(mocks.listGithubWatchesForConnection).not.toHaveBeenCalled();
		expect(mocks.removeGhcrWatchConfigDirs).not.toHaveBeenCalled();
	});

	it("disconnect: a shared connection can be used by the attacker but still not removed", async () => {
		mocks.findGithubConnectionInOrganization.mockImplementation(async () =>
			victimsConnection({ sharedWithOrganization: true }),
		);
		await expect(
			attacker().disconnect({ connectionId: "conn-victim" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.deleteGithubConnection).not.toHaveBeenCalled();
	});

	it("disconnect: the owner of the connection, an admin and an owner can remove it", async () => {
		mocks.memberGitProviderActions = ["delete"];
		await callerFor("member", "org-a", VICTIM).disconnect({
			connectionId: "conn-victim",
		});
		await callerFor("admin", "org-a", "user-admin").disconnect({
			connectionId: "conn-victim",
		});
		await callerFor("owner", "org-a", "user-owner").disconnect({
			connectionId: "conn-victim",
		});
		expect(mocks.deleteGithubConnection).toHaveBeenCalledTimes(3);
	});

	describe("the connection list", () => {
		const all = () => [
			victimsConnection(),
			connection({ connectionId: "conn-mine", createdByUserId: ATTACKER }),
			victimsConnection({
				connectionId: "conn-shared",
				sharedWithOrganization: true,
			}),
		];
		beforeEach(() => {
			mocks.listGithubConnectionRecords.mockResolvedValue(all());
		});

		it("shows the attacker their own and the shared ones, not the victim's private one", async () => {
			const seen = await attacker().connections();
			expect(seen.map((c) => c.connectionId).sort()).toEqual([
				"conn-mine",
				"conn-shared",
			]);
			expect(seen.find((c) => c.connectionId === "conn-mine")?.isOwner).toBe(
				true,
			);
			expect(seen.find((c) => c.connectionId === "conn-shared")?.isOwner).toBe(
				false,
			);
		});

		it("shows the victim their own, and an admin or owner every connection", async () => {
			mocks.memberGitProviderActions = ["read"];
			const victimSees = await callerFor(
				"member",
				"org-a",
				VICTIM,
			).connections();
			expect(victimSees.map((c) => c.connectionId).sort()).toEqual([
				"conn-shared",
				"conn-victim",
			]);
			expect(
				(await callerFor("admin", "org-a", "user-admin").connections()).length,
			).toBe(3);
			expect(
				(await callerFor("owner", "org-a", "user-owner").connections()).length,
			).toBe(3);
		});

		it("never carries the owner's user id or the token", async () => {
			for (const seen of await callerFor(
				"admin",
				"org-a",
				"user-admin",
			).connections()) {
				expect(seen).not.toHaveProperty("createdByUserId");
				expect(JSON.stringify(seen)).not.toContain(VICTIM);
				expect(seen).not.toHaveProperty("accessToken");
			}
		});
	});

	describe("toggleShare", () => {
		it("only the member who connected the account can share it", async () => {
			mocks.memberGitProviderActions = ["create"];
			await callerFor("member", "org-a", VICTIM).toggleShare({
				connectionId: "conn-victim",
				sharedWithOrganization: true,
			});
			expect(mocks.setGithubConnectionShared).toHaveBeenCalledWith(
				"conn-victim",
				"org-a",
				true,
			);
		});

		it("another member, even an admin or owner, cannot share (or unshare) it", async () => {
			mocks.memberGitProviderActions = ["create"];
			for (const caller of [
				callerFor("member", "org-a", ATTACKER),
				callerFor("admin", "org-a", "user-admin"),
				callerFor("owner", "org-a", "user-owner"),
			]) {
				await expect(
					caller.toggleShare({
						connectionId: "conn-victim",
						sharedWithOrganization: true,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
			}
			expect(mocks.setGithubConnectionShared).not.toHaveBeenCalled();
		});

		it("a connection of another organization is not found", async () => {
			mocks.findGithubConnectionInOrganization.mockResolvedValue(null);
			await expect(
				callerFor("admin", "org-b").toggleShare({
					connectionId: "conn-victim",
					sharedWithOrganization: true,
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	});
});

describe("watchSet refuses a second deployer", () => {
	const other = { title: "GHA production 0123abcd: ship it [run 9.1]" };

	it("refuses with a clear conflict when GitHub Actions deployed the service in the last 24 hours", async () => {
		mocks.findRecentOtherGithubDeployer.mockResolvedValue(other);
		mocks.findGithubWatch.mockResolvedValue(null);
		const refused = callerFor("admin").watchSet(setInput);
		await expect(refused).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(refused).rejects.toThrow(/two deployers/);
		expect(mocks.findRecentOtherGithubDeployer).toHaveBeenCalledWith(
			"application",
			"app-1",
		);
		expect(mocks.upsertGithubWatch).not.toHaveBeenCalled();
	});

	it("override: true goes ahead and is not stored on the watch", async () => {
		mocks.findRecentOtherGithubDeployer.mockResolvedValue(other);
		mocks.findGithubWatch.mockResolvedValue(null);
		await callerFor("admin").watchSet({ ...setInput, override: true });
		expect(mocks.upsertGithubWatch).toHaveBeenCalledTimes(1);
		expect(mocks.upsertGithubWatch.mock.calls[0]?.[0]).not.toHaveProperty(
			"override",
		);
		expect(mocks.findRecentOtherGithubDeployer).not.toHaveBeenCalled();
	});

	it("is not checked for a watch that is already on (it is the pull deployer itself) or for one being turned off", async () => {
		mocks.findRecentOtherGithubDeployer.mockResolvedValue(other);
		mocks.findGithubWatch.mockResolvedValue(watchRow({ enabled: true }));
		await callerFor("admin").watchSet(setInput);
		mocks.findGithubWatch.mockResolvedValue(null);
		await callerFor("admin").watchSet({ ...setInput, enabled: false });
		expect(mocks.upsertGithubWatch).toHaveBeenCalledTimes(2);
		expect(mocks.findRecentOtherGithubDeployer).not.toHaveBeenCalled();
	});

	it("is checked again when a disabled watch is turned back on", async () => {
		mocks.findRecentOtherGithubDeployer.mockResolvedValue(other);
		mocks.findGithubWatch.mockResolvedValue(watchRow({ enabled: false }));
		await expect(callerFor("admin").watchSet(setInput)).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});

	it("lets a service nobody else deploys through", async () => {
		mocks.findGithubWatch.mockResolvedValue(null);
		await callerFor("admin").watchSet(setInput);
		expect(mocks.upsertGithubWatch).toHaveBeenCalledTimes(1);
	});
});

describe("the watches list respects the member's accessedServices", () => {
	it("an owner or admin gets the organization's watches, unfiltered", async () => {
		await callerFor("owner").watches();
		expect(mocks.listGithubWatchesForOrganization).toHaveBeenLastCalledWith(
			"org-a",
			null,
		);
		await callerFor("admin").watches();
		expect(mocks.listGithubWatchesForOrganization).toHaveBeenLastCalledWith(
			"org-a",
			null,
		);
	});

	it("a plain member is refused by the gitProviders gate before any list is read", async () => {
		mocks.member.accessedServices = ["app-1"];
		await expect(callerFor("member").watches()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.listGithubWatchesForOrganization).not.toHaveBeenCalled();
	});

	it("a member who may read git providers only gets the services they were given", async () => {
		mocks.memberMayReadGitProviders = true;
		mocks.member.accessedServices = ["app-1", "c-9"];
		await callerFor("member").watches();
		expect(mocks.listGithubWatchesForOrganization).toHaveBeenLastCalledWith(
			"org-a",
			["app-1", "c-9"],
		);
	});

	it("a member with no services gets an empty allow-list, never the whole organization", async () => {
		mocks.memberMayReadGitProviders = true;
		mocks.member.accessedServices = [];
		await callerFor("member").watches();
		expect(mocks.listGithubWatchesForOrganization).toHaveBeenLastCalledWith(
			"org-a",
			[],
		);
	});

	it("read access to git providers is not enough to change a watch (confused deputy)", async () => {
		mocks.memberMayReadGitProviders = true;
		mocks.member.accessedServices = ["app-1"];
		await expect(callerFor("member").watchSet(setInput)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.upsertGithubWatch).not.toHaveBeenCalled();
	});
});

describe("disconnect", () => {
	it("deletes the docker login of every watch that used the connection, after deleting it", async () => {
		const order: string[] = [];
		mocks.deleteGithubConnection.mockImplementation(async () => {
			order.push("delete");
			return true;
		});
		mocks.removeGhcrWatchConfigDirs.mockImplementation(async () => {
			order.push("remove-dirs");
		});
		await callerFor("admin").disconnect({ connectionId: "conn-1" });
		expect(mocks.listGithubWatchesForConnection).toHaveBeenCalledWith(
			"conn-1",
			"org-a",
		);
		expect(mocks.removeGhcrWatchConfigDirs).toHaveBeenCalledWith(
			["w1", "w2"],
			"org-a",
		);
		expect(order).toEqual(["delete", "remove-dirs"]);
	});

	it("a connection of another organization is not found and nothing is removed", async () => {
		mocks.findGithubConnectionInOrganization.mockResolvedValue(null);
		await expect(
			callerFor("admin", "org-b").disconnect({ connectionId: "conn-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.deleteGithubConnection).not.toHaveBeenCalled();
		expect(mocks.removeGhcrWatchConfigDirs).not.toHaveBeenCalled();
	});
});

describe("startConnect asks GitHub for the scopes the caller chose", () => {
	const started = {
		ok: true as const,
		flowId: "f1",
		userCode: "ABCD-1234",
		verificationUri: "https://github.com/login/device",
		intervalSeconds: 5,
		expiresInSeconds: 900,
	};

	it("asks for the default scopes (public_repo) when nothing is said", async () => {
		mocks.beginGithubConnect.mockResolvedValue(started);
		await callerFor("owner").startConnect();
		expect(mocks.beginGithubConnect).toHaveBeenCalledWith(
			expect.anything(),
			{ organizationId: "org-a", userId: "user-1" },
			{},
		);
		await callerFor("owner").startConnect({ repositoryAccess: "public" });
		expect(mocks.beginGithubConnect.mock.calls[1]?.[2]).toEqual({});
	});

	it("asks for the repo scope for private repositories", async () => {
		mocks.beginGithubConnect.mockResolvedValue(started);
		await callerFor("admin").startConnect({ repositoryAccess: "private" });
		expect(mocks.beginGithubConnect.mock.calls[0]?.[2]).toEqual({
			scope: "repo_deployment repo",
		});
	});

	it("never returns the device code", async () => {
		mocks.beginGithubConnect.mockResolvedValue({
			...started,
			deviceCode: "secret-device-code",
		});
		const out = await callerFor("owner").startConnect();
		expect(JSON.stringify(out)).not.toContain("secret-device-code");
	});

	it("a plain member cannot start a connection", async () => {
		await expect(callerFor("member").startConnect()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.beginGithubConnect).not.toHaveBeenCalled();
	});
});

describe("a service that follows GitHub Actions releases keeps its watch", () => {
	beforeEach(() => {
		mocks.findGhaConnection.mockResolvedValue({ ghaConnectionId: "gc-1" });
	});

	it.each([true, false])(
		"watchSet refuses to edit it or turn it %s and writes nothing",
		async (enabled) => {
			await expect(
				callerFor("admin").watchSet({ ...setInput, enabled }),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(mocks.upsertGithubWatch).not.toHaveBeenCalled();
			expect(mocks.removeGhcrWatchConfigDirs).not.toHaveBeenCalled();
		},
	);

	it("watchRemove refuses to delete it", async () => {
		await expect(
			callerFor("admin").watchRemove({
				serviceType: "application",
				serviceId: "app-1",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.deleteGithubWatch).not.toHaveBeenCalled();
	});
});

describe("disconnect refuses an account that services follow GitHub Actions through", () => {
	it("is a conflict that names how many, and removes nothing", async () => {
		mocks.countGhaConnectionsForGithubConnection.mockResolvedValue(2);
		await expect(
			callerFor("owner").disconnect({ connectionId: "conn-1" }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("Disconnect the 2 services"),
		});
		expect(mocks.deleteGithubConnection).not.toHaveBeenCalled();
		expect(mocks.removeGhcrWatchConfigDirs).not.toHaveBeenCalled();
	});

	it("says service for a single one", async () => {
		mocks.countGhaConnectionsForGithubConnection.mockResolvedValue(1);
		await expect(
			callerFor("owner").disconnect({ connectionId: "conn-1" }),
		).rejects.toMatchObject({
			message: expect.stringContaining("Disconnect the 1 service "),
		});
	});

	it("still removes an account no service uses", async () => {
		mocks.countGhaConnectionsForGithubConnection.mockResolvedValue(0);
		await callerFor("owner").disconnect({ connectionId: "conn-1" });
		expect(mocks.deleteGithubConnection).toHaveBeenCalledWith(
			"conn-1",
			"org-a",
		);
	});
});
