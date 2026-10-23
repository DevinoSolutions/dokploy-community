import { beforeEach, describe, expect, it, vi } from "vitest";

// `<service>.update` spreads its input into the row, and environmentId decides
// which project (and so which organization and env) a service belongs to. Only
// `<service>.move` may change it, because that is the call that checks the
// target environment's organization (T-6822).
const mocks = vi.hoisted(() => ({
	updated: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server", () => {
	const stubs: Record<string | symbol, unknown> = {};
	const named: Record<string, unknown> = {
		IS_CLOUD: false,
		updateApplication: mocks.updated,
		updateCompose: mocks.updated,
		updatePostgresById: mocks.updated,
		updateMySqlById: mocks.updated,
		updateMariadbById: mocks.updated,
		updateMongoById: mocks.updated,
		updateRedisById: mocks.updated,
		updateLibsqlById: mocks.updated,
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

vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: vi.fn() },
	cleanQueuesByApplication: vi.fn(),
	cleanQueuesByCompose: vi.fn(),
	killDockerBuild: vi.fn(),
}));

const schema = await import("@dokploy/server/db/schema");

const SERVICES = [
	{
		router: "application",
		idKey: "applicationId",
		schema: schema.apiUpdateApplication,
	},
	{ router: "compose", idKey: "composeId", schema: schema.apiUpdateCompose },
	{
		router: "postgres",
		idKey: "postgresId",
		schema: schema.apiUpdatePostgres,
	},
	{ router: "mysql", idKey: "mysqlId", schema: schema.apiUpdateMySql },
	{ router: "mariadb", idKey: "mariadbId", schema: schema.apiUpdateMariaDB },
	{ router: "mongo", idKey: "mongoId", schema: schema.apiUpdateMongo },
	{ router: "redis", idKey: "redisId", schema: schema.apiUpdateRedis },
	{ router: "libsql", idKey: "libsqlId", schema: schema.apiUpdateLibsql },
] as const;

describe.each(SERVICES)("api update schema of $router", ({ idKey, schema }) => {
	it("drops environmentId and keeps the other fields", () => {
		const parsed = (
			schema as unknown as {
				parse: (value: unknown) => Record<string, unknown>;
			}
		).parse({
			[idKey]: "svc-1",
			environmentId: "env-of-another-org",
			name: "renamed",
		});

		expect(parsed).not.toHaveProperty("environmentId");
		expect(parsed).toMatchObject({ [idKey]: "svc-1", name: "renamed" });
	});
});

const ctx = {
	session: { activeOrganizationId: "org-b" },
	user: { id: "user-1", email: "user@example.com", role: "member" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.updated.mockResolvedValue({ appName: "x", applicationId: "svc-1" });
});

describe.each(SERVICES)("$router.update", { timeout: 60_000 }, (service) => {
	it("never writes an environmentId sent by the caller", async () => {
		const module = await import(`@/server/api/routers/${service.router}`);
		const caller = module[`${service.router}Router`].createCaller(ctx);

		await caller.update({
			[service.idKey]: "svc-1",
			name: "renamed",
			environmentId: "env-of-org-a",
		});

		expect(mocks.updated).toHaveBeenCalledTimes(1);
		const written = mocks.updated.mock.calls[0]?.[1];
		expect(written).toMatchObject({ name: "renamed" });
		expect(written).not.toHaveProperty("environmentId");
	});
});
