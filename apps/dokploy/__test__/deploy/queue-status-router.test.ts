import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * deployment.queueStatus (T-12497): says whether a service's deploy waits in the
 * local queue or runs, with its lane, place in line and wait. Same access rules as
 * reading the service's deployments, and it only ever describes that service.
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
	restoreSettled: vi.fn(() => true),
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
		restoreSettled: mocks.restoreSettled,
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
	extra: { lane?: "build" | "pull"; state?: string; timestamp?: number } = {},
) => ({
	id,
	data,
	state: extra.state ?? "waiting",
	lane: extra.lane ?? "build",
	timestamp: extra.timestamp ?? Date.now() - 30_000,
	processedOn: extra.state === "active" ? Date.now() - 5_000 : undefined,
});

const appJob = (
	applicationId: string,
	extra: Record<string, unknown> = {},
) => ({
	applicationId,
	applicationType: "application",
	titleLog: "t",
	descriptionLog: "",
	type: "deploy",
	...extra,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.executeCalls.length = 0;
	mocks.cloud.value = false;
	mocks.member.role = "owner";
	mocks.member.accessedServices = [];
	mocks.intakeClosed.mockReturnValue(false);
	mocks.restoreSettled.mockReturnValue(true);
	mocks.getJobs.mockImplementation(async (states?: string[]) =>
		mocks.jobs
			.filter((queued) => !states || states.includes(queued.state))
			.map((queued) => ({
				...queued,
				getState: async () => queued.state,
			})),
	);
	mocks.jobs = [
		job("j-other", appJob("app-org1-other")),
		job("j-mine", appJob("app-org1"), { lane: "pull" }),
		job("j-org2", appJob("app-org2")),
	];
});

describe("deployment.queueStatus", () => {
	it("reports a waiting deploy of the service: queued, lane, place and wait", async () => {
		const status = await caller.queueStatus({ applicationId: "app-org1" });

		expect(status).toMatchObject({
			state: "queued",
			lane: "pull",
			position: 1,
			ahead: 0,
			startedAt: null,
			heldReason: null,
			restoring: false,
		});
		expect(status.waitingSinceMs).toBeGreaterThanOrEqual(30_000);
	});

	it("reports a running deploy with its start time", async () => {
		mocks.jobs = [job("j-run", appJob("app-org1"), { state: "active" })];
		const status = await caller.queueStatus({ applicationId: "app-org1" });

		expect(status.state).toBe("running");
		expect(status.startedAt).toEqual(expect.any(Number));
	});

	it("says none when the service has nothing in the queue", async () => {
		mocks.jobs = [job("j-other", appJob("app-org1-other"))];
		await expect(
			caller.queueStatus({ applicationId: "app-org1" }),
		).resolves.toMatchObject({ state: "none", lane: null });
	});

	it("answers for a compose by its id", async () => {
		mocks.jobs = [
			job("j-c", {
				composeId: "comp-org1",
				applicationType: "compose",
				titleLog: "t",
				descriptionLog: "",
				type: "deploy",
			}),
		];
		await expect(
			caller.queueStatus({ composeId: "comp-org1" }),
		).resolves.toMatchObject({ state: "queued" });
	});

	it("takes the registered row as a filter", async () => {
		mocks.jobs = [
			job("j-1", appJob("app-org1", { deploymentId: "dep-1" })),
			job("j-2", appJob("app-org1", { deploymentId: "dep-2" })),
		];
		await expect(
			caller.queueStatus({ applicationId: "app-org1", deploymentId: "dep-2" }),
		).resolves.toMatchObject({ state: "queued", position: 2 });
		await expect(
			caller.queueStatus({ applicationId: "app-org1", deploymentId: "dep-x" }),
		).resolves.toMatchObject({ state: "none" });
	});

	it("needs exactly one of applicationId and composeId", async () => {
		await expect(caller.queueStatus({})).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(
			caller.queueStatus({ applicationId: "app-org1", composeId: "comp-org1" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("refuses a service of another organization, and reveals nothing about its queue", async () => {
		await expect(
			caller.queueStatus({ applicationId: "app-org2" }),
		).rejects.toThrow();
		expect(mocks.getJobs).not.toHaveBeenCalled();
	});

	it("refuses a service that does not exist", async () => {
		await expect(
			caller.queueStatus({ applicationId: "app-deleted" }),
		).rejects.toThrow();
	});

	it("a member answers only for the services on their access list", async () => {
		const member = callerAs("member");
		mocks.member.role = "member";
		mocks.member.accessedServices = ["app-org1"];
		await expect(
			member.queueStatus({ applicationId: "app-org1" }),
		).resolves.toMatchObject({ state: "queued" });

		mocks.member.accessedServices = [];
		await expect(
			member.queueStatus({ applicationId: "app-org1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("says the queue is still restoring and why a waiting deploy is held", async () => {
		mocks.restoreSettled.mockReturnValue(false);
		mocks.intakeClosed.mockReturnValue(true);
		await expect(
			caller.queueStatus({ applicationId: "app-org1" }),
		).resolves.toMatchObject({
			state: "queued",
			heldReason: "intake-closed-for-update",
			restoring: true,
		});
	});

	it("stops saying the queue is restoring once the grace period has passed", async () => {
		mocks.restoreSettled.mockReturnValue(false);
		const uptime = vi.spyOn(process, "uptime").mockReturnValue(6 * 60);
		try {
			await expect(
				caller.queueStatus({ applicationId: "app-org1" }),
			).resolves.toMatchObject({ state: "queued", restoring: false });
		} finally {
			uptime.mockRestore();
		}
	});

	it("a job that starts after the snapshot is read is queued, never running with a null start", async () => {
		// The slot frees between getJobs and any later read of the live state: the
		// snapshot has no processedOn, the live state says active.
		const getState = vi.fn(async () => "active");
		mocks.getJobs.mockImplementation(async () => [
			{
				id: "j-race",
				data: appJob("app-org1"),
				timestamp: Date.now() - 30_000,
				lane: "build",
				getState,
			},
		]);
		const status = await caller.queueStatus({ applicationId: "app-org1" });

		expect(status).toMatchObject({ state: "queued", startedAt: null });
		expect(getState).not.toHaveBeenCalled();
	});

	it("with the registered row, the caller's queued deploy is answered even while an older one runs", async () => {
		mocks.jobs = [
			job("j-old", appJob("app-org1", { deploymentId: "dep-old" }), {
				state: "active",
			}),
			job("j-new", appJob("app-org1", { deploymentId: "dep-new" })),
		];
		await expect(
			caller.queueStatus({
				applicationId: "app-org1",
				deploymentId: "dep-new",
			}),
		).resolves.toMatchObject({ state: "queued", startedAt: null });
		await expect(
			caller.queueStatus({ applicationId: "app-org1" }),
		).resolves.toMatchObject({ state: "running", queuedBehind: 1 });
	});

	it("names no job id and none of another organization's data", async () => {
		const serialized = JSON.stringify(
			await caller.queueStatus({ applicationId: "app-org1" }),
		);
		expect(serialized).not.toContain("j-mine");
		expect(serialized).not.toContain("org2");
	});

	it("has no local queue to read in the cloud", async () => {
		mocks.cloud.value = true;
		await expect(
			caller.queueStatus({ applicationId: "app-org1" }),
		).resolves.toMatchObject({ state: "none" });
		expect(mocks.getJobs).not.toHaveBeenCalled();
	});
});
