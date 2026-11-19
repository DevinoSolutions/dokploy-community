import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * deployment.queueList reports the lane each job counts against (T-12497): a
 * pull-only deploy shows as `pull`, everything else as `build`. A row that has no
 * lane (a remote queue's rows) simply carries none.
 */

const mocks = vi.hoisted(() => ({
	// serviceId -> organizationId; ids missing here belong to no service
	serviceOrgs: {
		"app-org1": "org-1",
		"comp-org1": "org-1",
		"app-org2": "org-2",
		"comp-org2": "org-2",
	} as Record<string, string>,
	jobs: [] as { id: string; data: Record<string, unknown>; state: string }[],
	executeCalls: [] as unknown[],
	// the caller's membership row (what findMemberByUserId reads)
	member: { role: "owner", accessedServices: [] as string[] },
	cloud: { value: false },
	servers: [{ serverId: "srv-1" }, { serverId: "srv-2" }],
	fetchDeployApiJobs: vi.fn(),
	getJobs: vi.fn(),
	intakeClosed: vi.fn(() => false),
	prioritize: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	// Pull the bound service ids out of the (nested) sql template.
	const collectIds = (chunks: unknown[]): string[] =>
		chunks.flatMap((chunk) => {
			if (typeof chunk === "string") return [chunk];
			const nested = (chunk as { queryChunks?: unknown[] } | null)?.queryChunks;
			return nested ? collectIds(nested) : [];
		});
	// The SQL text of a drizzle template, with bound parameters left out.
	const sqlText = (chunks: unknown[]): string =>
		chunks
			.map((chunk) => {
				if (typeof chunk === "string") return "";
				const { value, queryChunks } = chunk as {
					value?: string[];
					queryChunks?: unknown[];
				};
				if (queryChunks) return sqlText(queryChunks);
				return value?.join("") ?? "";
			})
			.join("");
	return {
		db: {
			query: new Proxy(
				{},
				{
					get: (_target, table) =>
						table === "member"
							? {
									findFirst: vi.fn(async () => ({
										id: "member-1",
										userId: "user-1",
										organizationId: "org-1",
										role: mocks.member.role,
										accessedServices: mocks.member.accessedServices,
										accessedProjects: [],
										accessedEnvironments: [],
										user: { id: "user-1" },
									})),
								}
							: table === "server"
								? { findMany: vi.fn(async () => mocks.servers) }
								: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
				},
			),
			// Service -> organization resolvers (single and batched).
			execute: vi.fn(async (query: { queryChunks: unknown[] }) => {
				mocks.executeCalls.push(sqlText(query.queryChunks));
				const ids = [...new Set(collectIds(query.queryChunks))].filter(
					(id) => id in mocks.serviceOrgs,
				);
				return ids.map((serviceId) => ({
					serviceId,
					organizationId: mocks.serviceOrgs[serviceId],
				}));
			}),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server", async (importOriginal) => ({
	...(await importOriginal<object>()),
	get IS_CLOUD() {
		return mocks.cloud.value;
	},
}));

vi.mock("@/server/utils/deploy", async (importOriginal) => ({
	...(await importOriginal<object>()),
	fetchDeployApiJobs: mocks.fetchDeployApiJobs,
}));

vi.mock("@dokploy/server/services/application", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findApplicationById: vi.fn(async (applicationId: string) => ({
		applicationId,
		appName: `name-${applicationId}`,
	})),
}));

vi.mock("@dokploy/server/services/compose", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findComposeById: vi.fn(async (composeId: string) => ({
		composeId,
		name: `name-${composeId}`,
	})),
}));

vi.mock("@dokploy/server/services/deployment", async (importOriginal) => ({
	...(await importOriginal<object>()),
	resolveServicePath: vi.fn(async () => ({ href: null, label: "x" })),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanQueuesByCompose: vi.fn(),
	cleanQueuesByApplication: vi.fn(),
	killDockerBuild: vi.fn(),
	myQueue: {
		getJobs: mocks.getJobs,
		intakeClosed: mocks.intakeClosed,
		prioritize: mocks.prioritize,
	},
}));

// The native binding is not needed to exercise the router.
vi.mock("bcrypt", () => ({ default: {}, hash: vi.fn(), compare: vi.fn() }));

vi.mock("@/server/api/utils/cancel-audit", () => ({ auditCancel: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

const { deploymentRouter } = await import("@/server/api/routers/deployment");
const { createCallerFactory } = await import("@/server/api/trpc");

const callerAs = (role: string) =>
	createCallerFactory(deploymentRouter)({
		user: { id: "user-1", email: "user@org1.test", role },
		session: { activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

const caller = callerAs("owner");

const job = (
	id: string,
	data: Record<string, unknown>,
	lane?: "build" | "pull",
	state = "waiting",
) => ({ id, data, state, lane });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.executeCalls.length = 0;
	mocks.cloud.value = false;
	mocks.member.role = "owner";
	mocks.member.accessedServices = [];
	mocks.fetchDeployApiJobs.mockResolvedValue([]);
	mocks.getJobs.mockImplementation(async (states?: string[]) =>
		mocks.jobs
			.filter((queued) => !states || states.includes(queued.state))
			.map((queued) => ({
				...queued,
				timestamp: 1,
				getState: async () => queued.state,
			})),
	);
	mocks.jobs = [
		job(
			"j-pull",
			{ applicationId: "app-org1", applicationType: "application" },
			"pull",
		),
		job(
			"j-build",
			{ composeId: "comp-org1", applicationType: "compose" },
			"build",
		),
		job(
			"j-active-pull",
			{ applicationId: "app-org1", applicationType: "application" },
			"pull",
			"active",
		),
		job("j-nolane", {
			applicationId: "app-org1",
			applicationType: "application-preview",
			previewDeploymentId: "prev-1",
		}),
		job(
			"j-other-org",
			{ applicationId: "app-org2", applicationType: "application" },
			"pull",
		),
	];
});

describe("deployment.queueList lanes", () => {
	it("returns the lane of each job", async () => {
		const rows = await caller.queueList();
		const lanes = Object.fromEntries(
			rows.map((row) => [row.id, (row as { lane?: string }).lane]),
		);

		expect(lanes["j-pull"]).toBe("pull");
		expect(lanes["j-build"]).toBe("build");
		expect(lanes["j-active-pull"]).toBe("pull");
	});

	it("carries no lane key for a job that has none", async () => {
		const rows = await caller.queueList();
		const row = rows.find((candidate) => candidate.id === "j-nolane");

		expect(row).toBeDefined();
		expect(row && "lane" in row).toBe(false);
	});

	it("still hides another organization's jobs, pull or not", async () => {
		const ids = (await caller.queueList()).map((row) => row.id);

		expect(ids).not.toContain("j-other-org");
	});
});
