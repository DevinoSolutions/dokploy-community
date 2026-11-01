import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	member: {
		role: "member" as string,
		accessedServices: [] as string[],
	},
	/** A member the admin granted read access to git providers (legacy flag). */
	memberMayReadGitProviders: false,
	serviceOrganizationId: "org-a",
	checkServicePermissionAndAccess: vi.fn(),
	beginGithubConnect: vi.fn(),
	deleteGithubConnection: vi.fn(),
	deleteGithubWatch: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	findGithubConnectionInOrganization: vi.fn(),
	findGithubWatch: vi.fn(),
	listGithubConnections: vi.fn(),
	listGithubWatchesForConnection: vi.fn(),
	listGithubWatchesForOrganization: vi.fn(),
	progressGithubConnect: vi.fn(),
	removeGhcrWatchConfigDirs: vi.fn(),
	upsertGithubConnection: vi.fn(),
	upsertGithubWatch: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({ db: {} }));
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

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	beginGithubConnect: mocks.beginGithubConnect,
	deleteGithubConnection: mocks.deleteGithubConnection,
	deleteGithubWatch: mocks.deleteGithubWatch,
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
	findGithubConnectionInOrganization: mocks.findGithubConnectionInOrganization,
	findGithubWatch: mocks.findGithubWatch,
	listGithubConnections: mocks.listGithubConnections,
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
) =>
	githubDeploymentRouter.createCaller({
		session: { activeOrganizationId: organizationId },
		user: { id: "user-1", email: "u@example.com", role },
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
	mocks.findGithubConnectionInOrganization.mockResolvedValue({
		connectionId: "conn-1",
		githubLogin: "amin",
	});
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
