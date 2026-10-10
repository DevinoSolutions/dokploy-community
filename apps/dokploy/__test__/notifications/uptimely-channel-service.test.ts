import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The stored side of the Uptimely notification channel: the API key is
 * write-only, the channel is derived from the notification row, and the
 * channel goes away with its notification.
 */

const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const API_KEY = "uptimely-secret-key-1234";

const mocks = vi.hoisted(() => ({
	notification: null as Record<string, unknown> | null,
	updates: [] as {
		table: string;
		values: Record<string, unknown>;
		bound: unknown[];
	}[],
	deletes: [] as string[],
	transactions: 0,
	callTool: vi.fn(),
	clientKeys: [] as string[],
}));

const tableName = (table: unknown) => {
	const symbols = Object.getOwnPropertySymbols(table as object);
	const nameSymbol = symbols.find((s) => s.toString().includes("Name"));
	return nameSymbol
		? String((table as Record<symbol, unknown>)[nameSymbol])
		: "unknown";
};

// The values a drizzle condition binds, e.g. the id in eq(column, id).
const boundValues = (node: unknown): unknown[] => {
	if (!node || typeof node !== "object") return [];
	const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
	if (Array.isArray(chunks)) return chunks.flatMap(boundValues);
	return "value" in node && !Array.isArray((node as { value: unknown }).value)
		? [(node as { value: unknown }).value]
		: [];
};

vi.mock("@dokploy/server/db", () => {
	const tx = {
		query: {
			notifications: { findFirst: vi.fn(async () => mocks.notification) },
		},
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: async (condition: unknown) => {
					mocks.updates.push({
						table: tableName(table),
						values,
						bound: boundValues(condition),
					});
				},
			}),
		}),
		delete: (table: unknown) => ({
			where: () => {
				const name = tableName(table);
				mocks.deletes.push(name);
				return {
					// biome-ignore lint/suspicious/noThenProperty: awaited like a drizzle query
					then: (resolve: (value: unknown) => void) => resolve(undefined),
					returning: async () =>
						name === "notification" && mocks.notification
							? [mocks.notification]
							: [],
				};
			},
		}),
	};
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
						: {
								findFirst: vi.fn(async () => mocks.notification ?? undefined),
								findMany: vi.fn(async () =>
									mocks.notification ? [mocks.notification] : [],
								),
							},
			}),
			transaction: vi.fn(async (run: (tx: unknown) => unknown) => {
				mocks.transactions++;
				return run(tx);
			}),
			execute: vi.fn(async () => []),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server/utils/uptimely/client", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/uptimely/client")
	>()),
	createUptimelyClient: vi.fn((options: { apiKey: string }) => {
		mocks.clientKeys.push(options.apiKey);
		return { callTool: mocks.callTool };
	}),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { notificationRouter } = await import(
	"@/server/api/routers/notification"
);
const { createCallerFactory } = await import("@/server/api/trpc");
const { updateUptimelyChannelNotification, removeNotificationById } =
	await import("@dokploy/server/services/notification");

const caller = createCallerFactory(notificationRouter)({
	user: { id: "user-1", email: "owner@test.com", role: "owner" },
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never);

const stored = (overrides: Record<string, unknown> = {}) => ({
	notificationId: "n-1",
	name: "Uptimely incidents",
	notificationType: "uptimely",
	organizationId: "org-1",
	uptimelyChannelId: "chan-1",
	appBuildError: true,
	uptimelyChannel: {
		uptimelyChannelId: "chan-1",
		apiKey: API_KEY,
		projectId: PROJECT,
		baseUrl: "https://app.getuptimely.com",
		resolvedStateId: null,
	},
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.callTool.mockReset();
	mocks.notification = stored();
	mocks.updates = [];
	mocks.deletes = [];
	mocks.transactions = 0;
	mocks.clientKeys = [];
});

describe("the channel API key is write-only", () => {
	it("notification.one masks the key and never returns it", async () => {
		const result = await caller.one({ notificationId: "n-1" });

		expect(JSON.stringify(result)).not.toContain(API_KEY);
		expect(result.uptimelyChannel).not.toHaveProperty("apiKey");
		expect(result.uptimelyChannel).toMatchObject({
			projectId: PROJECT,
			apiKeyMasked: expect.stringContaining("1234"),
		});
	});

	it("notification.all masks the key and never returns it", async () => {
		const result = await caller.all();

		expect(JSON.stringify(result)).not.toContain(API_KEY);
		expect(result[0]?.uptimelyChannel).not.toHaveProperty("apiKey");
		expect(result[0]?.uptimelyChannel).toHaveProperty("apiKeyMasked");
	});

	it("keeps the stored key when an update leaves it blank", async () => {
		await updateUptimelyChannelNotification({
			notificationId: "n-1",
			organizationId: "org-1",
			apiKey: "",
			projectId: PROJECT,
		});

		const channel = mocks.updates.find((u) => u.table === "uptimely_channel");
		expect(channel?.values).toEqual({ projectId: PROJECT });
		expect(channel?.values).not.toHaveProperty("apiKey");
		// Same project and key: nothing remembered is dropped.
		expect(mocks.deletes).toEqual([]);
	});

	it("keeps the stored key when an update omits it", async () => {
		await updateUptimelyChannelNotification({
			notificationId: "n-1",
			organizationId: "org-1",
			resolvedStateId: "33333333-3333-4333-8333-333333333333",
		});

		const channel = mocks.updates.find((u) => u.table === "uptimely_channel");
		expect(channel?.values).toEqual({
			resolvedStateId: "33333333-3333-4333-8333-333333333333",
		});
		expect(channel?.values).not.toHaveProperty("apiKey");
	});

	it("replaces the key when a new one is given", async () => {
		await updateUptimelyChannelNotification({
			notificationId: "n-1",
			organizationId: "org-1",
			apiKey: "brand-new-key",
		});

		const channel = mocks.updates.find((u) => u.table === "uptimely_channel");
		expect(channel?.values).toEqual({ apiKey: "brand-new-key" });
	});

	it("tests the connection with the stored key when the field is blank", async () => {
		mocks.callTool.mockResolvedValue({
			projects: [{ id: PROJECT, name: "Devino", slug: "devino" }],
		});

		await expect(
			caller.testUptimelyConnection({
				apiKey: "",
				notificationId: "n-1",
				projectId: PROJECT,
				baseUrl: "https://app.getuptimely.com",
			}),
		).resolves.toBe(true);

		expect(mocks.clientKeys).toEqual([API_KEY]);
	});

	it("will not borrow the stored key of another organization's notification", async () => {
		mocks.notification = stored({ organizationId: "org-2" });

		await expect(
			caller.testUptimelyConnection({
				apiKey: "",
				notificationId: "n-1",
				projectId: PROJECT,
				baseUrl: "https://app.getuptimely.com",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.clientKeys).toEqual([]);
	});
});

describe("updateUptimelyChannelNotification", () => {
	it("updates the channel of the notification row, never another organization's channel id", async () => {
		// A caller of org-1 names a channel that belongs to org-2.
		await updateUptimelyChannelNotification({
			notificationId: "n-1",
			organizationId: "org-1",
			uptimelyChannelId: "chan-of-org-2",
			apiKey: "attacker-key",
			baseUrl: "https://uptimely.test",
		});

		const channel = mocks.updates.find((u) => u.table === "uptimely_channel");
		expect(channel?.values).toMatchObject({ apiKey: "attacker-key" });
		expect(channel?.bound).toContain("chan-1");
		expect(channel?.bound).not.toContain("chan-of-org-2");
	});

	it("through the router, the client channel id cannot reach another organization's channel", async () => {
		await caller.updateUptimely({
			notificationId: "n-1",
			uptimelyChannelId: "chan-of-org-2",
			baseUrl: "https://uptimely.test",
		});

		const channel = mocks.updates.find((u) => u.table === "uptimely_channel");
		expect(channel?.bound).toContain("chan-1");
		expect(channel?.bound).not.toContain("chan-of-org-2");
	});

	it("refuses a notification of another organization", async () => {
		mocks.notification = stored({ organizationId: "org-2" });

		await expect(
			updateUptimelyChannelNotification({
				notificationId: "n-1",
				organizationId: "org-1",
				baseUrl: "https://uptimely.test",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updates).toEqual([]);
	});

	it("refuses a notification that is not an Uptimely channel", async () => {
		mocks.notification = stored({
			notificationType: "slack",
			uptimelyChannel: null,
		});

		await expect(
			updateUptimelyChannelNotification({
				notificationId: "n-1",
				organizationId: "org-1",
				baseUrl: "https://uptimely.test",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updates).toEqual([]);
	});

	it("a name-only update succeeds and does not touch the channel", async () => {
		await expect(
			updateUptimelyChannelNotification({
				notificationId: "n-1",
				organizationId: "org-1",
				name: "Renamed",
			}),
		).resolves.toBeUndefined();

		expect(mocks.updates.map((u) => u.table)).toEqual(["notification"]);
		expect(mocks.updates[0]?.values).toEqual({ name: "Renamed" });
	});

	it("an update with nothing to set is a no-op, not an error", async () => {
		await expect(
			updateUptimelyChannelNotification({
				notificationId: "n-1",
				organizationId: "org-1",
			}),
		).resolves.toBeUndefined();

		expect(mocks.updates).toEqual([]);
	});

	it("forgets the remembered incidents when the project changes", async () => {
		await updateUptimelyChannelNotification({
			notificationId: "n-1",
			organizationId: "org-1",
			projectId: OTHER_PROJECT,
		});

		expect(mocks.deletes).toEqual(["uptimely_channel_incident"]);
	});

	it("forgets the remembered incidents when the API key changes", async () => {
		await updateUptimelyChannelNotification({
			notificationId: "n-1",
			organizationId: "org-1",
			apiKey: "another-key",
		});

		expect(mocks.deletes).toEqual(["uptimely_channel_incident"]);
	});

	it("keeps the remembered incidents when the same target is saved again", async () => {
		await updateUptimelyChannelNotification({
			notificationId: "n-1",
			organizationId: "org-1",
			apiKey: API_KEY,
			projectId: PROJECT,
			baseUrl: "https://app.getuptimely.com",
			name: "Same",
		});

		expect(mocks.deletes).toEqual([]);
	});
});

describe("removeNotificationById", () => {
	it("deletes the notification and its channel in one transaction", async () => {
		await removeNotificationById("n-1");

		expect(mocks.transactions).toBe(1);
		expect(mocks.deletes).toEqual(["notification", "uptimely_channel"]);
	});

	it("does not touch channels for other notification types", async () => {
		mocks.notification = stored({ uptimelyChannelId: null });

		await removeNotificationById("n-1");

		expect(mocks.deletes).toEqual(["notification"]);
	});
});
