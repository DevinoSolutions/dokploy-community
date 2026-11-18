import { deletedServiceResult } from "@dokploy/server/services/service-secrets";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A delete mutation needs the `delete` permission and nothing else, so it must
// not answer with the row `find*ById` loaded: that row holds `env`, the webhook
// `refreshToken`, database passwords and (compose) the backup metadata. The
// dashboard only reads the project and environment ids to go back to the
// environment page (components/dashboard/compose/delete-service.tsx).
const mocks = vi.hoisted(() => ({
	finders: {
		findPostgresById: vi.fn(),
		findMySqlById: vi.fn(),
		findMariadbById: vi.fn(),
		findMongoById: vi.fn(),
		findRedisById: vi.fn(),
		findLibsqlById: vi.fn(),
		findRollbackById: vi.fn(),
		removeRollbackById: vi.fn(),
		findApplicationById: vi.fn(),
		findComposeById: vi.fn(),
	} as Record<string, ReturnType<typeof vi.fn>>,
}));

const ROUTES = [
	["postgres", "remove", "postgresId", "findPostgresById"],
	["mysql", "remove", "mysqlId", "findMySqlById"],
	["mariadb", "remove", "mariadbId", "findMariadbById"],
	["mongo", "remove", "mongoId", "findMongoById"],
	["redis", "remove", "redisId", "findRedisById"],
	["libsql", "remove", "libsqlId", "findLibsqlById"],
	["application", "delete", "applicationId", "findApplicationById"],
	["compose", "delete", "composeId", "findComposeById"],
] as const;

vi.mock("@dokploy/server", () => {
	const stubs: Record<string | symbol, unknown> = {};
	const named: Record<string, unknown> = {
		IS_CLOUD: false,
		...mocks.finders,
		findBackupsByDbId: vi.fn(async () => []),
		findDomainsByApplicationId: vi.fn(async () => []),
		findDomainsByComposeId: vi.fn(async () => []),
		findPreviewDeploymentsByApplicationId: vi.fn(async () => []),
	};
	return new Proxy(stubs, {
		get: (target, key) => {
			if (key === "then") return undefined;
			if (typeof key === "string" && key in named) return named[key];
			target[key] ??= vi.fn();
			return target[key];
		},
		has: () => true,
	});
});

vi.mock("@dokploy/server/db", () => {
	const tx = {
		delete: () => ({ where: () => ({ returning: async () => [] }) }),
	};
	return {
		db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) },
	};
});

vi.mock("@dokploy/server/services/gha-connect/store", () => ({
	removeGhaConnectionsForServices: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	assertEnvironmentInOrganization: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	checkServiceAccess: vi.fn(),
	addNewService: vi.fn(),
	findMemberByUserId: vi.fn(),
	hasPermission: vi.fn(async () => false),
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: vi.fn(), holdIdleGroup: () => ({ release: () => {} }) },
	cleanQueuesByApplication: vi.fn(),
	cleanQueuesByCompose: vi.fn(),
	killDockerBuild: vi.fn(),
}));

const ctx = {
	session: { activeOrganizationId: "org-1", userId: "user-1" },
	user: { id: "user-1", email: "user@example.com", role: "member" },
};

type Caller = Record<string, (input: unknown) => unknown>;
type RouterModule = { createCaller: (context: never) => unknown };

const loaders: Record<string, () => Promise<RouterModule>> = {
	postgres: async () =>
		(await import("@/server/api/routers/postgres")).postgresRouter,
	mysql: async () => (await import("@/server/api/routers/mysql")).mysqlRouter,
	mariadb: async () =>
		(await import("@/server/api/routers/mariadb")).mariadbRouter,
	mongo: async () => (await import("@/server/api/routers/mongo")).mongoRouter,
	redis: async () => (await import("@/server/api/routers/redis")).redisRouter,
	libsql: async () =>
		(await import("@/server/api/routers/libsql")).libsqlRouter,
	application: async () =>
		(await import("@/server/api/routers/application")).applicationRouter,
	compose: async () =>
		(await import("@/server/api/routers/compose")).composeRouter,
};

const callerFor = async (router: string): Promise<Caller> => {
	const load = loaders[router];
	if (!load) throw new Error(`no router ${router}`);
	return (await load()).createCaller(ctx as never) as Caller;
};

const serviceRow = (idKey: string) => ({
	[idKey]: "svc-1",
	name: "Service",
	appName: "svc-abc",
	serverId: null,
	env: "API_KEY=SECRET-env",
	buildArgs: "NPM_TOKEN=SECRET-build-arg",
	databasePassword: "SECRET-db-password",
	refreshToken: "SECRET-refresh-token",
	registry: { registryId: "reg-1", awsSecretAccessKey: "SECRET-aws-secret" },
	backups: [{ metadata: { mysql: { databasePassword: "SECRET-meta-pass" } } }],
	environment: {
		environmentId: "env-1",
		projectId: "proj-1",
		env: "X=SECRET-environment-env",
		project: { projectId: "proj-1", organizationId: "org-1" },
	},
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe.each(ROUTES)(
	"%s.%s",
	{ timeout: 60_000 },
	(router, procedure, idKey, finder) => {
		it("answers with the ids the dashboard needs and nothing of the row", async () => {
			mocks.finders[finder]?.mockResolvedValue(serviceRow(idKey));
			const caller = await callerFor(router);

			const result = await caller[procedure]?.({
				[idKey]: "svc-1",
				deleteVolumes: false,
			});

			expect(result).toEqual({
				[idKey]: "svc-1",
				environment: { environmentId: "env-1", projectId: "proj-1" },
			});
			expect(JSON.stringify(result)).not.toContain("SECRET-");
		});

		it("still refuses a service of another organization", async () => {
			const foreign = serviceRow(idKey);
			foreign.environment.project.organizationId = "org-other";
			mocks.finders[finder]?.mockResolvedValue(foreign);
			const caller = await callerFor(router);

			await expect(
				caller[procedure]?.({ [idKey]: "svc-1", deleteVolumes: false }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		});
	},
);

describe("deletedServiceResult", () => {
	it("copies the id and the two environment ids only", () => {
		expect(
			deletedServiceResult(
				{
					postgresId: "pg-1",
					databasePassword: "SECRET-x",
					environment: {
						environmentId: "e",
						projectId: "p",
						env: "SECRET-y",
					},
				},
				"postgresId",
			),
		).toEqual({
			postgresId: "pg-1",
			environment: { environmentId: "e", projectId: "p" },
		});
	});
});

// start, stop and changeStatus need `deployment.create`, which does not include
// reading the service (application.one withholds `password` and `refreshToken`
// from such a caller). They answer with the id and the status just set.
const STATUS_ROUTES = [
	["application", "applicationId", "findApplicationById", "stop", "idle"],
	["application", "applicationId", "findApplicationById", "start", "done"],
	["postgres", "postgresId", "findPostgresById", "stop", "idle"],
	["postgres", "postgresId", "findPostgresById", "start", "done"],
	["postgres", "postgresId", "findPostgresById", "changeStatus", "error"],
	["mysql", "mysqlId", "findMySqlById", "stop", "idle"],
	["mysql", "mysqlId", "findMySqlById", "start", "done"],
	["mysql", "mysqlId", "findMySqlById", "changeStatus", "error"],
	["mariadb", "mariadbId", "findMariadbById", "stop", "idle"],
	["mariadb", "mariadbId", "findMariadbById", "start", "done"],
	["mariadb", "mariadbId", "findMariadbById", "changeStatus", "error"],
	["mongo", "mongoId", "findMongoById", "stop", "idle"],
	["mongo", "mongoId", "findMongoById", "start", "done"],
	["mongo", "mongoId", "findMongoById", "changeStatus", "error"],
	["redis", "redisId", "findRedisById", "stop", "idle"],
	["redis", "redisId", "findRedisById", "start", "done"],
	["redis", "redisId", "findRedisById", "changeStatus", "error"],
	["libsql", "libsqlId", "findLibsqlById", "stop", "idle"],
	["libsql", "libsqlId", "findLibsqlById", "start", "done"],
	["libsql", "libsqlId", "findLibsqlById", "changeStatus", "error"],
] as const;

describe.each(STATUS_ROUTES)(
	"%s.%s",
	{ timeout: 60_000 },
	(router, idKey, finder, procedure, status) => {
		it(`answers with the id and the status ${status}, and nothing of the row`, async () => {
			mocks.finders[finder]?.mockResolvedValue({
				...serviceRow(idKey),
				registry: {
					registryId: "reg-1",
					awsAccessKeyId: "SECRET-aws-key-id",
					awsSecretAccessKey: "SECRET-aws-secret",
				},
			});
			const caller = await callerFor(router);

			const result = await caller[procedure]?.({
				[idKey]: "svc-1",
				applicationStatus: status,
			});

			expect(result).toEqual({ [idKey]: "svc-1", applicationStatus: status });
		});
	},
);

describe("rollback.delete", () => {
	it("answers with the rollback id, not the stored snapshot of the application", async () => {
		mocks.finders.findRollbackById?.mockResolvedValue({
			rollbackId: "rb-1",
			deployment: { applicationId: "svc-1" },
		});
		mocks.finders.removeRollbackById?.mockResolvedValue({
			rollbackId: "rb-1",
			image: "app:v1",
			fullContext: {
				env: "API_KEY=SECRET-env",
				registry: {
					password: "SECRET-reg-password",
					awsSecretAccessKey: "SECRET-aws-secret",
				},
			},
		});
		const { rollbackRouter } = await import("@/server/api/routers/rollbacks");

		const result = await rollbackRouter
			.createCaller(ctx as never)
			.delete({ rollbackId: "rb-1" });

		expect(result).toEqual({ rollbackId: "rb-1" });
		expect(mocks.finders.removeRollbackById).toHaveBeenCalledWith("rb-1");
	});
});
