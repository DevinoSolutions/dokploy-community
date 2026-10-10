import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The DoDomain secret key is write-only: it is masked on read, a blank or
 * omitted key keeps the stored one, and the stored key is never replayed
 * against a base URL the caller just typed (update and the "Test connection"
 * button of the edit form). The webhook signing secret is never returned.
 */

const SECRET_KEY = "dd_sk_live_0123456789abcdef";
const WEBHOOK_SECRET = "whsec_router_secret_value";
const STORED_URL = "https://dodomain.test";
const OTHER_URL = "https://attacker.example";

const mocks = vi.hoisted(() => ({
	integration: null as Record<string, unknown> | null,
	clientOptions: [] as { secretKey: string; baseUrl: string }[],
	updates: [] as Record<string, unknown>[],
}));

vi.mock("@dokploy/server/db", () => {
	const chain = (): any => {
		const self: any = {
			set: vi.fn((values: Record<string, unknown>) => {
				mocks.updates.push(values);
				return self;
			}),
			where: vi.fn(() => self),
			values: vi.fn(() => self),
			returning: vi.fn(async () => [{ ...mocks.integration }]),
			// biome-ignore lint/suspicious/noThenProperty: drizzle's query builder is itself a thenable, so the fake standing in for it must be one too
			then: (resolve: (value: unknown) => void) => resolve([]),
		};
		return self;
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
						: table === "dodomainIntegration"
							? {
									findFirst: vi.fn(async () => mocks.integration ?? undefined),
									findMany: vi.fn(async () => []),
								}
							: {
									findFirst: vi.fn(async () => undefined),
									findMany: vi.fn(async () => []),
								},
			}),
			execute: vi.fn(async () => []),
			select: vi.fn(() => chain()),
			insert: vi.fn(() => chain()),
			update: vi.fn(() => chain()),
			delete: vi.fn(() => chain()),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server/utils/dodomain/client", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/dodomain/client")
	>()),
	createDoDomainClient: vi.fn(
		(options: { secretKey: string; baseUrl: string }) => {
			mocks.clientOptions.push(options);
			return {
				apps: { list: async () => ({ apps: [{ id: "app_1", name: "App" }] }) },
				webhookEndpoints: {
					update: async () => ({ id: "we_1", url: "https://x" }),
					delete: async () => ({}),
				},
			};
		},
	),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { dodomainRouter } = await import("@/server/api/routers/dodomain");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = createCallerFactory(dodomainRouter)({
	user: { id: "user-1", email: "owner@test.com", role: "owner" },
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.clientOptions = [];
	mocks.updates = [];
	mocks.integration = {
		dodomainId: "dd-1",
		organizationId: "org-1",
		name: "DoDomain",
		secretKey: SECRET_KEY,
		appId: "app_1",
		baseUrl: STORED_URL,
		webhookEndpointId: "we_1",
		webhookUrl: "https://dok.example.com/api/webhooks/dodomain?integration=dd-1",
		webhookSecret: WEBHOOK_SECRET,
		createdAt: new Date(),
	};
});

describe("DoDomain credentials are write-only", () => {
	it("one masks the secret key and never returns the key or the webhook secret", async () => {
		const result = await caller.one();

		expect(result).not.toHaveProperty("secretKey");
		expect(result).not.toHaveProperty("webhookSecret");
		expect(result?.secretKeyMasked).toBe("dd_sk_••••cdef");
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(SECRET_KEY);
		expect(serialized).not.toContain(WEBHOOK_SECRET);
	});

	it("update returns the masked view, never the key or the webhook secret", async () => {
		const result = await caller.update({ name: "Renamed" });

		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(SECRET_KEY);
		expect(serialized).not.toContain(WEBHOOK_SECRET);
		expect(result).toHaveProperty("secretKeyMasked");
	});

	it("update keeps the stored key when the field is omitted", async () => {
		await caller.update({ name: "Renamed" });

		expect(mocks.updates.at(-1)).toEqual({ name: "Renamed" });
		expect(mocks.updates.at(-1)).not.toHaveProperty("secretKey");
	});

	it("update replaces the key when a new one is given", async () => {
		await caller.update({ secretKey: "dd_sk_live_brand_new_key" });

		expect(mocks.updates.at(-1)).toMatchObject({
			secretKey: "dd_sk_live_brand_new_key",
		});
	});
});

describe("the stored secret key is never replayed against another URL", () => {
	it("update: a changed URL without a new key is rejected before anything is called or written", async () => {
		await expect(caller.update({ baseUrl: OTHER_URL })).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("secret key again"),
		});

		expect(mocks.clientOptions).toEqual([]);
		expect(mocks.updates).toEqual([]);
	});

	it("update: a changed port or path is a changed URL", async () => {
		await expect(
			caller.update({ baseUrl: `${STORED_URL}:8443` }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			caller.update({ baseUrl: `${STORED_URL}/proxy` }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.clientOptions).toEqual([]);
	});

	it("update: a changed URL with a new key passes the rule", async () => {
		// The webhook step needs a configured public URL; the rule under test
		// is the one before it, so any other failure is fine here.
		await caller
			.update({ baseUrl: OTHER_URL, secretKey: "dd_sk_live_typed_key" })
			.catch((error) => {
				expect(error.message).not.toContain("secret key again");
			});
	});

	it("update: the same URL, normalized, passes the rule", async () => {
		await caller
			.update({ baseUrl: `${STORED_URL.toUpperCase().replace("HTTPS", "https")}///` })
			.catch((error) => {
				expect(error.message).not.toContain("secret key again");
			});
	});

	it("test: a blank key tests with the stored key of the caller's integration", async () => {
		await expect(
			caller.testConnection({ baseUrl: STORED_URL }),
		).resolves.toMatchObject({ appFound: true });

		expect(mocks.clientOptions).toEqual([
			{ secretKey: SECRET_KEY, baseUrl: STORED_URL },
		]);
	});

	it("test: the stored key is not sent to a different URL", async () => {
		await expect(
			caller.testConnection({ baseUrl: OTHER_URL }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("secret key again"),
		});

		expect(mocks.clientOptions).toEqual([]);
	});

	it("test: a different URL with a typed key uses the typed key", async () => {
		await caller.testConnection({
			baseUrl: OTHER_URL,
			secretKey: "dd_sk_live_typed_key",
		});

		expect(mocks.clientOptions).toEqual([
			{ secretKey: "dd_sk_live_typed_key", baseUrl: OTHER_URL },
		]);
	});

	it("test: with no integration and no key there is nothing to borrow", async () => {
		mocks.integration = null;

		await expect(
			caller.testConnection({ baseUrl: OTHER_URL }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.clientOptions).toEqual([]);
	});
});
