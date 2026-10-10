import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The stored Snapvisor access token is write-only and travels as a Bearer
 * token to the integration's base URL. It must never be replayed against a
 * different URL the caller typed: changing the URL needs the token typed
 * again, and the token is never part of a response.
 */

const STORED_TOKEN = "sv-stored-token-0000beef";
const STORED_URL = "https://api.snapvisor.io";

const mocks = vi.hoisted(() => ({
	integration: null as Record<string, unknown> | null,
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
				{ ...mocks.integration, ...mocks.sets.at(-1) },
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

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const fetchSpy = vi.fn(
	async (_url: string, _init?: { headers?: Record<string, string> }) =>
		Response.json({ accounts: [] }),
);
vi.stubGlobal("fetch", fetchSpy);

const { snapvisorRouter } = await import("@/server/api/routers/snapvisor");
const { createCallerFactory } = await import("@/server/api/trpc");
const { isSameSnapvisorBaseUrl } = await import(
	"@dokploy/server/utils/snapvisor/urls"
);

const caller = createCallerFactory(snapvisorRouter)({
	user: { id: "user-1", email: "owner@test.com", role: "owner" },
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never);

const bearerOf = (call: unknown[]) =>
	(call[1] as { headers: Record<string, string> }).headers.Authorization;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.sets = [];
	mocks.integration = {
		snapvisorId: "sv-1",
		organizationId: "org-1",
		name: "Snapvisor",
		accessToken: STORED_TOKEN,
		accountSlug: "my-team",
		baseUrl: STORED_URL,
		createdAt: new Date(),
	};
});

describe("isSameSnapvisorBaseUrl", () => {
	it("ignores case and trailing slashes", () => {
		expect(
			isSameSnapvisorBaseUrl("https://API.snapvisor.io/", STORED_URL),
		).toBe(true);
	});

	it("treats the legacy app host as the API default", () => {
		expect(isSameSnapvisorBaseUrl("https://app.snapvisor.io", STORED_URL)).toBe(
			true,
		);
	});

	it("tells different hosts and paths apart", () => {
		expect(isSameSnapvisorBaseUrl("https://attacker.example", STORED_URL)).toBe(
			false,
		);
		expect(
			isSameSnapvisorBaseUrl("https://sv.example/a", "https://sv.example/b"),
		).toBe(false);
	});
});

describe("snapvisor.testConnection", () => {
	it("refuses to replay the stored token against a different URL", async () => {
		await expect(
			caller.testConnection({ baseUrl: "https://attacker.example" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("access token again"),
		});

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("accepts a different URL when the token is typed again", async () => {
		await caller.testConnection({
			baseUrl: "https://sv.example",
			accessToken: "typed-token",
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toMatch(/^https:\/\/sv\.example\//);
		expect(bearerOf(fetchSpy.mock.calls[0] ?? [])).toBe("Bearer typed-token");
	});

	it("uses the stored token for the same URL, ignoring case and trailing slashes", async () => {
		await caller.testConnection({ baseUrl: "https://API.snapvisor.io/" });

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(bearerOf(fetchSpy.mock.calls[0] ?? [])).toBe(
			`Bearer ${STORED_TOKEN}`,
		);
	});

	it("uses the stored token when the URL is left at the default", async () => {
		await caller.testConnection({});

		expect(bearerOf(fetchSpy.mock.calls[0] ?? [])).toBe(
			`Bearer ${STORED_TOKEN}`,
		);
	});

	it("does not leak the stored token in the result", async () => {
		const result = await caller.testConnection({ baseUrl: STORED_URL });

		expect(JSON.stringify(result)).not.toContain(STORED_TOKEN);
	});
});

describe("snapvisor.update", () => {
	it("refuses a changed URL without a new token", async () => {
		await expect(
			caller.update({ baseUrl: "https://attacker.example" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("access token again"),
		});

		expect(mocks.sets).toEqual([]);
	});

	it("accepts a changed URL together with a new token and never returns it", async () => {
		const result = await caller.update({
			baseUrl: "https://sv.example",
			accessToken: "typed-token",
		});

		expect(mocks.sets).toEqual([
			{ accessToken: "typed-token", baseUrl: "https://sv.example" },
		]);
		expect(result).not.toHaveProperty("accessToken");
		expect(JSON.stringify(result)).not.toContain("typed-token");
		expect(JSON.stringify(result)).not.toContain(STORED_TOKEN);
	});

	it("accepts the same URL without a token", async () => {
		await caller.update({ baseUrl: `${STORED_URL}/`, name: "Renamed" });

		expect(mocks.sets).toHaveLength(1);
		expect(mocks.sets[0]).not.toHaveProperty("accessToken");
	});

	it("accepts an update that does not touch the URL", async () => {
		await caller.update({ name: "Renamed" });

		expect(mocks.sets).toEqual([{ name: "Renamed" }]);
	});
});
