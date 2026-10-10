import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The stored Uptimely API key is write-only and travels as a Bearer token to
 * the integration's base URL. It must never be replayed against a different
 * URL the caller typed: changing the URL needs the key typed again.
 */

const PROJECT = "22222222-2222-4222-8222-222222222222";
const STORED_KEY = "stored-integration-key";
const STORED_URL = "https://app.getuptimely.com";

const mocks = vi.hoisted(() => ({
	integration: null as Record<string, unknown> | null,
	callTool: vi.fn(),
	clients: [] as { apiKey: string; baseUrl: string }[],
	sets: [] as Record<string, unknown>[],
}));

vi.mock("@dokploy/server/db", () => {
	const chain = (): any => {
		const self: any = {
			set: vi.fn((values: Record<string, unknown>) => {
				mocks.sets.push(values);
				return self;
			}),
			where: vi.fn(() => self),
			returning: vi.fn(async () => [
				{ ...mocks.integration, uptimelyId: "u-1" },
			]),
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
						: {
								findFirst: vi.fn(async () => mocks.integration ?? undefined),
								findMany: vi.fn(async () => []),
							},
			}),
			update: vi.fn(() => chain()),
			execute: vi.fn(async () => []),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server/utils/uptimely/client", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/uptimely/client")
	>()),
	createUptimelyClient: vi.fn(
		(options: { apiKey: string; baseUrl: string }) => {
			mocks.clients.push(options);
			return { callTool: mocks.callTool };
		},
	),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { uptimelyRouter } = await import("@/server/api/routers/uptimely");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = createCallerFactory(uptimelyRouter)({
	user: { id: "user-1", email: "owner@test.com", role: "owner" },
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.callTool.mockReset();
	mocks.callTool.mockResolvedValue({ projects: [], defaultProjectId: null });
	mocks.clients = [];
	mocks.sets = [];
	mocks.integration = {
		uptimelyId: "u-1",
		organizationId: "org-1",
		name: "Uptimely",
		apiKey: STORED_KEY,
		projectId: PROJECT,
		baseUrl: STORED_URL,
		statusPageSlug: null,
	};
});

describe("uptimely.testConnection", () => {
	it("refuses to replay the stored key against a different URL", async () => {
		await expect(
			caller.testConnection({ baseUrl: "https://attacker.example" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("API key again"),
		});

		expect(mocks.clients).toEqual([]);
	});

	it("accepts a different URL when the key is typed again", async () => {
		await caller.testConnection({
			baseUrl: "https://uptimely.test",
			apiKey: "typed-key",
		});

		expect(mocks.clients).toEqual([
			{ apiKey: "typed-key", baseUrl: "https://uptimely.test" },
		]);
	});

	it("uses the stored key for the same URL, ignoring case and trailing slashes", async () => {
		await caller.testConnection({ baseUrl: "https://APP.getuptimely.com/" });

		expect(mocks.clients).toHaveLength(1);
		expect(mocks.clients[0]?.apiKey).toBe(STORED_KEY);
		expect(new URL(mocks.clients[0]?.baseUrl ?? "").host).toBe(
			"app.getuptimely.com",
		);
	});
});

describe("uptimely.update", () => {
	it("refuses a changed URL without a new key", async () => {
		await expect(
			caller.update({ baseUrl: "https://attacker.example" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("API key again"),
		});

		expect(mocks.sets).toEqual([]);
	});

	it("accepts a changed URL together with a new key", async () => {
		await caller.update({
			baseUrl: "https://uptimely.test",
			apiKey: "typed-key",
		});

		expect(mocks.sets).toEqual([
			{ apiKey: "typed-key", baseUrl: "https://uptimely.test" },
		]);
	});

	it("accepts the same URL without a key", async () => {
		await caller.update({ baseUrl: `${STORED_URL}/`, name: "Renamed" });

		expect(mocks.sets).toHaveLength(1);
		expect(mocks.sets[0]).not.toHaveProperty("apiKey");
	});

	it("accepts an update that does not touch the URL", async () => {
		await caller.update({ name: "Renamed" });

		expect(mocks.sets).toEqual([{ name: "Renamed" }]);
	});
});
