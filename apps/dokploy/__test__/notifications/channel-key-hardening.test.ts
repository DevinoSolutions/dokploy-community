import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sendly and Notifly notification channels: the API key is write-only. It is
 * masked on read, a blank or omitted key keeps the stored one, the "Test
 * Notification" button of the edit form uses the stored key of the caller's own
 * notification, and the stored key is never replayed against a changed URL.
 */

const API_KEYS = {
	sendly: "sk_sendly_secret_key_1234",
	notifly: "nk_notifly_secret_key_5678",
} as const;
const DEFAULT_URLS = {
	sendly: "https://app.sendly.now",
	notifly: "https://api.notifly.io",
} as const;
const OTHER_URL = "https://attacker.example";

const mocks = vi.hoisted(() => ({
	notification: null as Record<string, unknown> | null,
	updates: [] as {
		table: string;
		values: Record<string, unknown>;
		bound: unknown[];
	}[],
	deletes: [] as string[],
	fetch: vi.fn(),
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
				where: (condition: unknown) => {
					mocks.updates.push({
						table: tableName(table),
						values,
						bound: boundValues(condition),
					});
					const result = Promise.resolve([{ notificationId: "n-1" }]);
					return Object.assign(result, { returning: () => result });
				},
			}),
		}),
		delete: (table: unknown) => ({
			where: () => {
				mocks.deletes.push(tableName(table));
				return {
					// biome-ignore lint/suspicious/noThenProperty: awaited like a drizzle query
					then: (resolve: (value: unknown) => void) => resolve(undefined),
					returning: async () => (mocks.notification ? [mocks.notification] : []),
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
			transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(tx)),
			execute: vi.fn(async () => []),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { notificationRouter } = await import(
	"@/server/api/routers/notification"
);
const { createCallerFactory } = await import("@/server/api/trpc");
const { updateSendlyNotification, updateNotiflyNotification } = await import(
	"@dokploy/server/services/notification"
);

const caller = createCallerFactory(notificationRouter)({
	user: { id: "user-1", email: "owner@test.com", role: "owner" },
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never);

const storedNotification = (
	type: "sendly" | "notifly",
	overrides: Record<string, unknown> = {},
) => ({
	notificationId: "n-1",
	name: `${type} channel`,
	notificationType: type,
	organizationId: "org-1",
	sendlyId: type === "sendly" ? "sendly-1" : null,
	notiflyId: type === "notifly" ? "notifly-1" : null,
	sendly:
		type === "sendly"
			? {
					sendlyId: "sendly-1",
					apiKey: API_KEYS.sendly,
					fromAddress: "alerts@example.com",
					toAddresses: ["team@example.com"],
					baseUrl: DEFAULT_URLS.sendly,
				}
			: null,
	notifly:
		type === "notifly"
			? {
					notiflyId: "notifly-1",
					apiKey: API_KEYS.notifly,
					workflowKey: "dokploy",
					subscriberId: null,
					baseUrl: DEFAULT_URLS.notifly,
				}
			: null,
	uptimelyChannel: null,
	...overrides,
});

const update = {
	sendly: updateSendlyNotification,
	notifly: updateNotiflyNotification,
};

const testButton = (
	type: "sendly" | "notifly",
	input: { apiKey?: string; notificationId?: string; baseUrl: string },
) =>
	type === "sendly"
		? caller.testSendlyConnection({
				fromAddress: "alerts@example.com",
				toAddresses: ["team@example.com"],
				...input,
			})
		: caller.testNotiflyConnection({
				workflowKey: "dokploy",
				subscriberId: "",
				...input,
			});

const authorizationOfLastRequest = () =>
	(mocks.fetch.mock.calls.at(-1)?.[1] as { headers: Record<string, string> })
		.headers.Authorization;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.updates = [];
	mocks.deletes = [];
	mocks.fetch.mockReset();
	mocks.fetch.mockResolvedValue({
		ok: true,
		json: async () => ({ success: true, data: {} }),
		text: async () => "",
	});
	vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe.each(["sendly", "notifly"] as const)("%s channel", (type) => {
	const apiKey = API_KEYS[type];
	const defaultUrl = DEFAULT_URLS[type];
	const tableOfChannel = type;

	beforeEach(() => {
		mocks.notification = storedNotification(type);
	});

	describe("the API key is write-only", () => {
		it("notification.one masks the key and never returns it", async () => {
			const result = await caller.one({ notificationId: "n-1" });

			expect(JSON.stringify(result)).not.toContain(apiKey);
			expect(result[type]).not.toHaveProperty("apiKey");
			expect(result[type]).toMatchObject({
				baseUrl: defaultUrl,
				apiKeyMasked: expect.stringContaining(apiKey.slice(-4)),
			});
		});

		it("notification.all masks the key and never returns it", async () => {
			const result = await caller.all();

			expect(JSON.stringify(result)).not.toContain(apiKey);
			expect(result[0]?.[type]).not.toHaveProperty("apiKey");
			expect(result[0]?.[type]).toHaveProperty("apiKeyMasked");
		});

		it("keeps the other channel columns null for this type", async () => {
			const result = await caller.one({ notificationId: "n-1" });
			const other = type === "sendly" ? "notifly" : "sendly";

			expect(result[other]).toBeNull();
			expect(result.uptimelyChannel).toBeNull();
		});

		it("keeps the stored key when an update leaves it blank", async () => {
			await update[type]({
				notificationId: "n-1",
				organizationId: "org-1",
				apiKey: "",
				baseUrl: defaultUrl,
			} as never);

			const channel = mocks.updates.find((u) => u.table === tableOfChannel);
			expect(channel?.values).toEqual({ baseUrl: defaultUrl });
			expect(channel?.values).not.toHaveProperty("apiKey");
		});

		it("keeps the stored key when an update omits it", async () => {
			await update[type]({
				notificationId: "n-1",
				organizationId: "org-1",
				...(type === "sendly"
					? { fromAddress: "other@example.com" }
					: { workflowKey: "other-flow" }),
			} as never);

			const channel = mocks.updates.find((u) => u.table === tableOfChannel);
			expect(channel?.values).not.toHaveProperty("apiKey");
			expect(Object.keys(channel?.values ?? {})).toHaveLength(1);
		});

		it("replaces the key when a new one is given", async () => {
			await update[type]({
				notificationId: "n-1",
				organizationId: "org-1",
				apiKey: "brand-new-key",
			} as never);

			const channel = mocks.updates.find((u) => u.table === tableOfChannel);
			expect(channel?.values).toEqual({ apiKey: "brand-new-key" });
		});

		it("a name-only update succeeds and does not touch the channel", async () => {
			await expect(
				update[type]({
					notificationId: "n-1",
					organizationId: "org-1",
					name: "Renamed",
				} as never),
			).resolves.toBeUndefined();

			expect(mocks.updates.map((u) => u.table)).toEqual(["notification"]);
		});
	});

	describe("the channel is derived from the notification row", () => {
		it("never updates another organization's channel id", async () => {
			await update[type]({
				notificationId: "n-1",
				organizationId: "org-1",
				...(type === "sendly"
					? { sendlyId: "channel-of-org-2" }
					: { notiflyId: "channel-of-org-2" }),
				apiKey: "attacker-key",
				baseUrl: "https://sendly.test",
			} as never);

			const channel = mocks.updates.find((u) => u.table === tableOfChannel);
			expect(channel?.values).toMatchObject({ apiKey: "attacker-key" });
			expect(channel?.bound).toContain(`${type}-1`);
			expect(channel?.bound).not.toContain("channel-of-org-2");
		});

		it("refuses a notification of another organization", async () => {
			mocks.notification = storedNotification(type, {
				organizationId: "org-2",
			});

			await expect(
				update[type]({
					notificationId: "n-1",
					organizationId: "org-1",
					name: "Hijack",
				} as never),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mocks.updates).toEqual([]);
		});

		it("refuses a notification of another channel type", async () => {
			mocks.notification = storedNotification(type, {
				notificationType: "slack",
				sendly: null,
				notifly: null,
			});

			await expect(
				update[type]({
					notificationId: "n-1",
					organizationId: "org-1",
					name: "Wrong type",
				} as never),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mocks.updates).toEqual([]);
		});
	});

	describe("the stored key is never replayed against another URL", () => {
		const updateName = type === "sendly" ? "updateSendly" : "updateNotifly";
		const routerUpdate = (input: Record<string, unknown>) =>
			caller[updateName]({
				notificationId: "n-1",
				[`${type}Id`]: `${type}-1`,
				...input,
			} as never);

		it("update: a changed URL without a new key is rejected and nothing is written", async () => {
			await expect(
				update[type]({
					notificationId: "n-1",
					organizationId: "org-1",
					baseUrl: OTHER_URL,
				} as never),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("API key again"),
			});

			expect(mocks.updates).toEqual([]);
		});

		it("update: a changed URL with a blank key is rejected too", async () => {
			await expect(
				update[type]({
					notificationId: "n-1",
					organizationId: "org-1",
					baseUrl: OTHER_URL,
					apiKey: "",
				} as never),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.updates).toEqual([]);
		});

		it("update: a changed URL with a new key is accepted", async () => {
			await update[type]({
				notificationId: "n-1",
				organizationId: "org-1",
				baseUrl: "https://elsewhere.test",
				apiKey: "typed-key",
			} as never);

			const channel = mocks.updates.find((u) => u.table === tableOfChannel);
			expect(channel?.values).toEqual({
				apiKey: "typed-key",
				baseUrl: "https://elsewhere.test",
			});
		});

		it("update: the same URL without a key is accepted, ignoring case, slashes, query and userinfo", async () => {
			const shouty = defaultUrl
				.replace("https://", "https://user:pw@")
				.toUpperCase()
				.replace("HTTPS://", "https://");
			await update[type]({
				notificationId: "n-1",
				organizationId: "org-1",
				baseUrl: `${shouty}//?x=1#frag`,
			} as never);

			const channel = mocks.updates.find((u) => u.table === tableOfChannel);
			expect(channel?.values).not.toHaveProperty("apiKey");
		});

		it("update: a different port or path is a different URL", async () => {
			await expect(
				update[type]({
					notificationId: "n-1",
					organizationId: "org-1",
					baseUrl: `${defaultUrl}:8443`,
				} as never),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			await expect(
				update[type]({
					notificationId: "n-1",
					organizationId: "org-1",
					baseUrl: `${defaultUrl}/proxy`,
				} as never),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});

		it("update through the router keeps the specific message", async () => {
			await expect(routerUpdate({ baseUrl: OTHER_URL })).rejects.toMatchObject(
				{
					code: "BAD_REQUEST",
					message: expect.stringContaining("API key again"),
				},
			);
		});

		it("update through the router accepts a blank key on the same URL", async () => {
			await expect(
				routerUpdate({ apiKey: "", baseUrl: defaultUrl }),
			).resolves.toBeUndefined();

			const channel = mocks.updates.find((u) => u.table === tableOfChannel);
			expect(channel?.values).not.toHaveProperty("apiKey");
		});

		it("test: a blank key tests with the stored key of the caller's notification", async () => {
			await expect(
				testButton(type, {
					apiKey: "",
					notificationId: "n-1",
					baseUrl: defaultUrl,
				}),
			).resolves.toBe(true);

			expect(mocks.fetch).toHaveBeenCalledTimes(1);
			expect(authorizationOfLastRequest()).toContain(apiKey);
		});

		it("test: the stored key is not sent to a different URL", async () => {
			await expect(
				testButton(type, {
					apiKey: "",
					notificationId: "n-1",
					baseUrl: OTHER_URL,
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("API key again"),
			});

			expect(mocks.fetch).not.toHaveBeenCalled();
		});

		it("test: a different URL with a typed key uses the typed key", async () => {
			await expect(
				testButton(type, {
					apiKey: "typed-key",
					notificationId: "n-1",
					baseUrl: OTHER_URL,
				}),
			).resolves.toBe(true);

			expect(authorizationOfLastRequest()).toContain("typed-key");
			expect(authorizationOfLastRequest()).not.toContain(apiKey);
		});

		it("test: a typed key is used as is, without reading the stored notification", async () => {
			await testButton(type, { apiKey: "typed-key", baseUrl: defaultUrl });

			expect(authorizationOfLastRequest()).toContain("typed-key");
		});

		it("test: no key and no notification is an error", async () => {
			await expect(
				testButton(type, { apiKey: "", baseUrl: defaultUrl }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("API key is required"),
			});
			expect(mocks.fetch).not.toHaveBeenCalled();
		});

		it("test: will not borrow the stored key of another organization's notification", async () => {
			mocks.notification = storedNotification(type, {
				organizationId: "org-2",
			});

			await expect(
				testButton(type, {
					apiKey: "",
					notificationId: "n-1",
					baseUrl: defaultUrl,
				}),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(mocks.fetch).not.toHaveBeenCalled();
		});

		it("test: a notification of another channel type has no key to borrow", async () => {
			mocks.notification = storedNotification(type, {
				notificationType: "slack",
				sendly: null,
				notifly: null,
			});

			await expect(
				testButton(type, {
					apiKey: "",
					notificationId: "n-1",
					baseUrl: defaultUrl,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.fetch).not.toHaveBeenCalled();
		});
	});

	it("notification.one refuses another organization's notification", async () => {
		mocks.notification = storedNotification(type, { organizationId: "org-2" });

		await expect(
			caller.one({ notificationId: "n-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
