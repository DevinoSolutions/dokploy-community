import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The deploy queue is one list shared by every organization, and a job payload
 * names its service (and, with priority, the requesting user). queueList and
 * prioritizeQueued must only ever see the caller's own organization's jobs,
 * and a member only the jobs of the services they were given.
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

const job = (id: string, data: Record<string, unknown>, state = "waiting") => ({
	id,
	data,
	state,
});

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
	mocks.prioritize.mockReturnValue({
		requested: true,
		applied: true,
		wentAheadOf: 1,
	});
	mocks.jobs = [
		job("j-app1", {
			applicationId: "app-org1",
			applicationType: "application",
		}),
		job("j-comp1", { composeId: "comp-org1", applicationType: "compose" }),
		job("j-prev1", {
			applicationId: "app-org1",
			applicationType: "application-preview",
			previewDeploymentId: "prev-1",
		}),
		job(
			"j-app2",
			{
				applicationId: "app-org2",
				applicationType: "application",
				priority: true,
				priorityBy: "user-of-org-2",
			},
			"waiting",
		),
		job("j-comp2", { composeId: "comp-org2", applicationType: "compose" }),
		job(
			"j-active2",
			{ applicationId: "app-org2", applicationType: "application" },
			"active",
		),
		job("j-gone", {
			applicationId: "app-deleted",
			applicationType: "application",
		}),
		job("j-nodata", {}),
	];
});

describe("deployment.queueList", () => {
	it("returns only the jobs of the caller's organization", async () => {
		const rows = await caller.queueList();

		expect(rows.map((row) => row.id).sort()).toEqual([
			"j-app1",
			"j-comp1",
			"j-prev1",
		]);
	});

	it("leaks nothing of another organization's payload", async () => {
		const serialized = JSON.stringify(await caller.queueList());

		expect(serialized).not.toContain("org2");
		expect(serialized).not.toContain("user-of-org-2");
	});

	it("drops jobs whose service no longer exists, or that name none", async () => {
		const ids = (await caller.queueList()).map((row) => row.id);

		expect(ids).not.toContain("j-gone");
		expect(ids).not.toContain("j-nodata");
	});

	it("resolves every job's organization in one query", async () => {
		await caller.queueList();

		expect(mocks.executeCalls).toHaveLength(1);
	});

	it("returns an empty list when the caller's organization has no jobs", async () => {
		mocks.jobs = mocks.jobs.filter((j) => j.id.endsWith("2"));

		expect(await caller.queueList()).toEqual([]);
	});

	it("resolves the organization through application or compose -> environment -> project", async () => {
		await caller.queueList();

		const [sqlText] = mocks.executeCalls as string[];
		expect(sqlText).toMatch(/FROM "application"/);
		expect(sqlText).toMatch(/FROM "compose"/);
		expect(sqlText).toMatch(/JOIN "environment" e ON e\."environmentId"/);
		expect(sqlText).toMatch(
			/JOIN "project" p ON p\."projectId" = e\."projectId"/,
		);
		expect(sqlText).toMatch(/p\."organizationId"/);
	});
});

describe("deployment.queueList for a member", () => {
	it("shows only the jobs of the services the member was given", async () => {
		mocks.member.role = "member";
		mocks.member.accessedServices = ["comp-org1"];

		const rows = await callerAs("member").queueList();

		expect(rows.map((row) => row.id)).toEqual(["j-comp1"]);
	});

	it("shows a preview job when the member has the application", async () => {
		mocks.member.role = "member";
		mocks.member.accessedServices = ["app-org1"];

		const rows = await callerAs("member").queueList();

		expect(rows.map((row) => row.id).sort()).toEqual(["j-app1", "j-prev1"]);
	});

	it("does not let an access-list entry from another organization through", async () => {
		mocks.member.role = "member";
		mocks.member.accessedServices = ["app-org2", "comp-org2", "comp-org1"];

		const rows = await callerAs("member").queueList();

		expect(rows.map((row) => row.id)).toEqual(["j-comp1"]);
		expect(JSON.stringify(rows)).not.toContain("user-of-org-2");
	});

	it("shows nothing, without touching the queue, to a member with no services", async () => {
		mocks.member.role = "member";
		mocks.member.accessedServices = [];

		expect(await callerAs("member").queueList()).toEqual([]);
		expect(mocks.getJobs).not.toHaveBeenCalled();
		expect(mocks.executeCalls).toHaveLength(0);
	});

	it("still shows an admin the whole organization's queue", async () => {
		mocks.member.role = "admin";

		const rows = await callerAs("admin").queueList();

		expect(rows.map((row) => row.id).sort()).toEqual([
			"j-app1",
			"j-comp1",
			"j-prev1",
		]);
	});
});

describe("deployment.queueList on cloud", () => {
	const cloudRow = (
		id: string,
		data: Record<string, unknown>,
		timestamp: number,
	) => ({ id, data, timestamp, state: "waiting" });

	beforeEach(() => {
		mocks.cloud.value = true;
		mocks.fetchDeployApiJobs.mockImplementation(async (serverId: string) =>
			serverId === "srv-1"
				? [
						cloudRow("c-app1", { applicationId: "app-org1" }, 10),
						cloudRow("c-app2", { applicationId: "app-org2" }, 20),
					]
				: [
						cloudRow("c-comp1", { composeId: "comp-org1" }, 30),
						cloudRow("c-gone", { composeId: "comp-deleted" }, 40),
					],
		);
	});

	it("reads the organization's servers, not the local queue, and keeps only its own jobs newest first", async () => {
		const rows = await caller.queueList();

		expect(mocks.fetchDeployApiJobs).toHaveBeenCalledTimes(2);
		expect(mocks.fetchDeployApiJobs).toHaveBeenCalledWith("srv-1");
		expect(mocks.fetchDeployApiJobs).toHaveBeenCalledWith("srv-2");
		expect(mocks.getJobs).not.toHaveBeenCalled();
		expect(rows.map((row) => row.id)).toEqual(["c-comp1", "c-app1"]);
		expect(mocks.executeCalls).toHaveLength(1);
	});

	it("narrows a member to their services", async () => {
		mocks.member.role = "member";
		mocks.member.accessedServices = ["app-org1"];

		const rows = await callerAs("member").queueList();

		expect(rows.map((row) => row.id)).toEqual(["c-app1"]);
	});

	it("shows a member with no services nothing and fetches nothing", async () => {
		mocks.member.role = "member";
		mocks.member.accessedServices = [];

		expect(await callerAs("member").queueList()).toEqual([]);
		expect(mocks.fetchDeployApiJobs).not.toHaveBeenCalled();
	});
});

describe("deployment.prioritizeQueued", () => {
	it("flags a waiting job of the caller's organization", async () => {
		const result = await caller.prioritizeQueued({ jobId: "j-comp1" });

		expect(mocks.prioritize).toHaveBeenCalledWith("j-comp1", "user-1");
		expect(result).toMatchObject({ success: true, jobId: "j-comp1" });
	});

	it("refuses another organization's job exactly like a job that does not exist", async () => {
		const attempt = (jobId: string) =>
			caller.prioritizeQueued({ jobId }).catch((error) => error);

		const missing = await attempt("j-nothing");
		const foreignApp = await attempt("j-app2");
		const foreignCompose = await attempt("j-comp2");
		const notWaiting = await attempt("j-active2");
		const deletedService = await attempt("j-gone");

		expect(missing).toMatchObject({ code: "NOT_FOUND" });
		for (const error of [
			foreignApp,
			foreignCompose,
			notWaiting,
			deletedService,
		]) {
			expect(error.code).toBe(missing.code);
			expect(error.message).toBe(missing.message);
		}
		expect(mocks.prioritize).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});
