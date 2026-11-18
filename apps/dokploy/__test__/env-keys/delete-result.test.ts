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

describe("application.stop and application.start", () => {
	it.each(["stop", "start"] as const)(
		"%s does not echo the AWS keys of a linked registry",
		async (procedure) => {
			const row = {
				...serviceRow("applicationId"),
				applicationId: "svc-1",
				registry: {
					registryId: "reg-1",
					awsAccessKeyId: "SECRET-aws-key-id",
					awsSecretAccessKey: "SECRET-aws-secret",
					awsRegion: "us-east-1",
				},
			};
			mocks.finders.findApplicationById?.mockResolvedValue(row);
			const caller = await callerFor("application");

			const result = (await caller[procedure]?.({
				applicationId: "svc-1",
			})) as typeof row;

			expect(result.applicationId).toBe("svc-1");
			expect(result.registry).toEqual({
				registryId: "reg-1",
				awsAccessKeyId: "",
				awsSecretAccessKey: "",
				awsRegion: "us-east-1",
			});
			expect(JSON.stringify(result)).not.toContain("SECRET-aws");
		},
	);
});
