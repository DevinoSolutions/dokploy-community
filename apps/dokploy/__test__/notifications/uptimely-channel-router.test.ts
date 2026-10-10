import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Uptimely notification channel: router input validation and the "Test
 * Notification" button, which must stay read-only (it must never declare an
 * incident in a real Uptimely project).
 */

const PROJECT = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
	callTool: vi.fn(),
	inserted: [] as Record<string, unknown>[],
}));

vi.mock("@dokploy/server/db", () => {
	const tableMock = () => ({
		findFirst: vi.fn(async () => undefined),
		findMany: vi.fn(async () => []),
	});
	return {
		db: {
			query: new Proxy({} as Record<string, unknown>, {
				get: (_target, table) =>
					table === "member"
						? {
								findFirst: vi.fn(async () => ({
									id: "member-1",
									userId: "user-1",
									organizationId: "org-1",
									role: "owner",
									accessedServices: [],
									accessedProjects: [],
									accessedEnvironments: [],
									user: { id: "user-1" },
								})),
								findMany: vi.fn(async () => []),
							}
						: tableMock(),
			}),
			transaction: vi.fn(async (run: (tx: unknown) => unknown) =>
				run({
					insert: () => ({
						values: (row: Record<string, unknown>) => {
							mocks.inserted.push(row);
							return {
								returning: async () => [
									{ ...row, uptimelyChannelId: "chan-1" },
								],
							};
						},
					}),
				}),
			),
			execute: vi.fn(async () => []),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server/utils/uptimely/client", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/uptimely/client")
	>()),
	createUptimelyClient: vi.fn(() => ({ callTool: mocks.callTool })),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { notificationRouter } = await import(
	"@/server/api/routers/notification"
);
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = createCallerFactory(notificationRouter)({
	user: { id: "user-1", email: "owner@test.com", role: "owner" },
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never);

const valid = {
	name: "Uptimely incidents",
	appDeploy: false,
	appBuildError: true,
	databaseBackup: false,
	volumeBackup: false,
	dokployRestart: false,
	dokployBackup: false,
	dockerCleanup: false,
	serverThreshold: false,
	scheduleFailure: false,
	apiKey: "uptimely-key",
	projectId: PROJECT,
	baseUrl: "https://app.getuptimely.com",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.callTool.mockReset();
	mocks.inserted = [];
});

describe("notification.testUptimelyConnection", () => {
	it("reads the project list and declares nothing", async () => {
		mocks.callTool.mockResolvedValue({
			projects: [{ id: PROJECT, name: "Devino", slug: "devino" }],
			defaultProjectId: PROJECT,
		});

		await expect(
			caller.testUptimelyConnection({
				apiKey: valid.apiKey,
				projectId: PROJECT,
				baseUrl: valid.baseUrl,
			}),
		).resolves.toBe(true);

		expect(mocks.callTool.mock.calls.map((c) => c[0])).toEqual([
			"uptimely_project_list",
		]);
	});

	it("fails when the key cannot see the project", async () => {
		mocks.callTool.mockResolvedValue({
			projects: [{ id: "other", name: "Other", slug: "other" }],
			defaultProjectId: null,
		});

		await expect(
			caller.testUptimelyConnection({
				apiKey: valid.apiKey,
				projectId: PROJECT,
				baseUrl: valid.baseUrl,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("project id"),
		});
	});

	it("surfaces a rejected API key", async () => {
		mocks.callTool.mockRejectedValue(
			new Error("Uptimely rejected the API key."),
		);

		await expect(
			caller.testUptimelyConnection({
				apiKey: valid.apiKey,
				projectId: PROJECT,
				baseUrl: valid.baseUrl,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Uptimely rejected the API key.",
		});
	});

	it("validates its input before calling Uptimely", async () => {
		for (const bad of [
			{ projectId: "nope" },
			{ apiKey: "" },
			{ baseUrl: "not a url" },
		]) {
			await expect(
				caller.testUptimelyConnection({
					apiKey: valid.apiKey,
					projectId: PROJECT,
					baseUrl: valid.baseUrl,
					...bad,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(mocks.callTool).not.toHaveBeenCalled();
	});
});

describe("notification.createUptimely", () => {
	it("stores the channel credentials and the notification", async () => {
		await caller.createUptimely({ ...valid, baseUrl: `${valid.baseUrl}/` });

		expect(mocks.inserted[0]).toMatchObject({
			apiKey: "uptimely-key",
			projectId: PROJECT,
			baseUrl: "https://app.getuptimely.com",
			resolvedStateId: null,
		});
		expect(mocks.inserted[1]).toMatchObject({
			notificationType: "uptimely",
			uptimelyChannelId: "chan-1",
			organizationId: "org-1",
			appBuildError: true,
		});
	});

	it("rejects an invalid project id or base URL", async () => {
		await expect(
			caller.createUptimely({ ...valid, projectId: "nope" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			caller.createUptimely({ ...valid, baseUrl: "ftp://uptimely.test" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.inserted).toEqual([]);
	});
});
