import { beforeEach, describe, expect, it, vi } from "vitest";

// Same as move-target-environment.test.ts, but the organization check itself is
// the real one: only the database rows it reads are scripted (T-6822).
const mocks = vi.hoisted(() => ({
	findEnvironment: vi.fn(),
	update: vi.fn(),
	set: vi.fn(),
	returning: vi.fn(),
}));

vi.mock("@dokploy/server", () => {
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

vi.mock("@dokploy/server/services/permission", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/permission")
	>()),
	checkServicePermissionAndAccess: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/db")>()),
	db: {
		update: mocks.update,
		query: { environments: { findFirst: mocks.findEnvironment } },
	},
}));

vi.mock("@/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/server/db")>()),
	db: { update: mocks.update },
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

const SERVICES = [
	{ router: "application", idKey: "applicationId" },
	{ router: "compose", idKey: "composeId" },
	{ router: "postgres", idKey: "postgresId" },
	{ router: "libsql", idKey: "libsqlId" },
] as const;

const ctx = {
	session: { activeOrganizationId: "org-b" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.returning.mockResolvedValue([{ appName: "x" }]);
	mocks.set.mockReturnValue({ where: () => ({ returning: mocks.returning }) });
	mocks.update.mockReturnValue({ set: mocks.set });
});

describe.each(SERVICES)(
	"$router.move with the real check",
	{
		timeout: 60_000,
	},
	({ router, idKey }) => {
		const callerFor = async () => {
			const module = await import(`@/server/api/routers/${router}`);
			return module[`${router}Router`].createCaller(ctx);
		};

		it("refuses an environment that belongs to another organization", async () => {
			mocks.findEnvironment.mockResolvedValue({
				environmentId: "env-a",
				project: { organizationId: "org-a" },
			});

			await expect(
				(await callerFor()).move({
					[idKey]: "svc-1",
					targetEnvironmentId: "env-a",
				}),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(mocks.update).not.toHaveBeenCalled();
		});

		it("refuses an environment that does not exist, with the same error", async () => {
			mocks.findEnvironment.mockResolvedValue(undefined);

			await expect(
				(await callerFor()).move({
					[idKey]: "svc-1",
					targetEnvironmentId: "missing",
				}),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(mocks.update).not.toHaveBeenCalled();
		});

		it("moves into an environment of the caller's organization", async () => {
			mocks.findEnvironment.mockResolvedValue({
				environmentId: "env-b",
				project: { organizationId: "org-b" },
			});

			await (await callerFor()).move({
				[idKey]: "svc-1",
				targetEnvironmentId: "env-b",
			});

			expect(mocks.set).toHaveBeenCalledWith({ environmentId: "env-b" });
		});
	},
);
