import { beforeEach, describe, expect, it, vi } from "vitest";

// `<service>.move` writes environmentId from the input. The target environment
// has to belong to the caller's active organization, whatever the service
// type (T-6822). Everything but the check itself is stubbed.
const mocks = vi.hoisted(() => ({
	assertEnvironmentInOrganization: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	update: vi.fn(),
	set: vi.fn(),
	returning: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server", async () => {
	// the routers pull dozens of services from the barrel; none of them is
	// reached by `move`, so any name resolves to a stub
	const stubs: Record<string | symbol, unknown> = {};
	return new Proxy(stubs, {
		get: (target, key) => {
			if (key === "then") {
				return undefined;
			}
			if (key === "IS_CLOUD") {
				return false;
			}
			target[key] ??= vi.fn();
			return target[key];
		},
		has: () => true,
	});
});

vi.mock("@dokploy/server/services/permission", () => ({
	assertEnvironmentInOrganization: mocks.assertEnvironmentInOrganization,
	// The member allow-list of the target environment; the organization scope
	// under test is assertEnvironmentInOrganization.
	checkEnvironmentAccess: vi.fn(async () => undefined),
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	checkServiceAccess: vi.fn(),
	addNewService: vi.fn(),
	findMemberByUserId: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/db")>()),
	db: { update: mocks.update },
}));

vi.mock("@/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/server/db")>()),
	db: { update: mocks.update },
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: vi.fn() },
	cleanQueuesByApplication: vi.fn(),
	cleanQueuesByCompose: vi.fn(),
	killDockerBuild: vi.fn(),
}));

const SERVICES = [
	{ router: "application", idKey: "applicationId" },
	{ router: "compose", idKey: "composeId" },
	{ router: "libsql", idKey: "libsqlId" },
	{ router: "mariadb", idKey: "mariadbId" },
	{ router: "mongo", idKey: "mongoId" },
	{ router: "mysql", idKey: "mysqlId" },
	{ router: "postgres", idKey: "postgresId" },
	{ router: "redis", idKey: "redisId" },
] as const;

const loadRouter = async (name: (typeof SERVICES)[number]["router"]) => {
	const module = await import(`@/server/api/routers/${name}`);
	return module[`${name}Router`];
};

const ctx = {
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.assertEnvironmentInOrganization.mockResolvedValue(undefined);
	mocks.returning.mockResolvedValue([{ appName: "x" }]);
	mocks.set.mockReturnValue({
		where: () => ({ returning: mocks.returning }),
	});
	mocks.update.mockReturnValue({ set: mocks.set });
});

// the first import of a router pulls in its whole dependency graph
describe.each(SERVICES)(
	"$router.move",
	{ timeout: 60_000 },
	({ router, idKey }) => {
		it("refuses a target environment of another organization before writing", async () => {
			mocks.assertEnvironmentInOrganization.mockRejectedValue(
				Object.assign(new Error("not yours"), { code: "UNAUTHORIZED" }),
			);
			const caller = (await loadRouter(router)).createCaller(ctx);

			await expect(
				caller.move({ [idKey]: "svc-1", targetEnvironmentId: "env-of-org-b" }),
			).rejects.toThrow("not yours");

			expect(mocks.assertEnvironmentInOrganization).toHaveBeenCalledWith(
				"env-of-org-b",
				"org-a",
			);
			expect(mocks.update).not.toHaveBeenCalled();
			expect(mocks.audit).not.toHaveBeenCalled();
		});

		it("still moves into an environment of the caller's organization", async () => {
			const caller = (await loadRouter(router)).createCaller(ctx);

			await caller.move({
				[idKey]: "svc-1",
				targetEnvironmentId: "env-of-org-a",
			});

			expect(mocks.assertEnvironmentInOrganization).toHaveBeenCalledWith(
				"env-of-org-a",
				"org-a",
			);
			expect(mocks.set).toHaveBeenCalledWith({
				environmentId: "env-of-org-a",
			});
		});

		// `service:create` is all a move needs. The row it updates holds env,
		// build args, the deploy webhook token and database passwords, none of
		// which the move needs to hand back (T-19588); the dashboard reads no field
		// of the result.
		it("answers with the service id and its environment, not the stored row", async () => {
			mocks.returning.mockResolvedValue([
				{
					[idKey]: "svc-1",
					appName: "app-x",
					name: "x",
					environmentId: "env-of-org-a",
					env: "API_KEY=SECRET-env",
					buildArgs: "A=SECRET-build",
					buildSecrets: "B=SECRET-build-secret",
					refreshToken: "SECRET-refresh",
					password: "SECRET-registry",
					databasePassword: "SECRET-db",
					databaseRootPassword: "SECRET-db-root",
				},
			]);
			const caller = (await loadRouter(router)).createCaller(ctx);

			const result = await caller.move({
				[idKey]: "svc-1",
				targetEnvironmentId: "env-of-org-a",
			});

			expect(result).toEqual({
				[idKey]: "svc-1",
				environmentId: "env-of-org-a",
			});
			expect(JSON.stringify(result)).not.toContain("SECRET");
			// The audit entry still names the service.
			expect(mocks.audit).toHaveBeenCalledWith(
				ctx,
				expect.objectContaining({ resourceId: "svc-1" }),
			);
		});
	},
);
