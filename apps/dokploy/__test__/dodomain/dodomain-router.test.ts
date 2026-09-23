import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Router-level scoping of the DoDomain integration.
 *
 * Per-domain procedures take an arbitrary `domainId`. Holding a role in the
 * active organization says nothing about that id, so every procedure must
 * prove the domain's service belongs to the caller's organization BEFORE it
 * loads the org's DoDomain credentials or calls DoDomain. The secret key and
 * the webhook signing secret must never be returned to the client.
 */

const SECRET_KEY = "dd_sk_live_0123456789abcdef";
const WEBHOOK_SECRET = "whsec_router_secret_value";

const mocks = vi.hoisted(() => ({
	serviceOrganizationId: "org-1" as string | null,
	memberRole: "owner" as string,
	integration: null as Record<string, unknown> | null,
	domain: null as Record<string, unknown> | null,
	integrationFindFirst: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const tableMock = () => ({
		findFirst: vi.fn(async () => undefined),
		findMany: vi.fn(async () => []),
	});
	const chain = (): any => {
		const self: any = {
			set: vi.fn(() => self),
			where: vi.fn(() => self),
			values: vi.fn(() => self),
			returning: vi.fn(async () => [{}]),
			// biome-ignore lint/suspicious/noThenProperty: drizzle's query builder is itself a thenable, so the fake standing in for it must be one too
			then: (resolve: (value: unknown) => void) => resolve([]),
		};
		return self;
	};
	return {
		db: {
			query: new Proxy({} as Record<string, unknown>, {
				get: (_target, table) => {
					if (table === "member") {
						return {
							findFirst: vi.fn(async () => ({
								id: "member-1",
								userId: "user-1",
								organizationId: "org-1",
								role: mocks.memberRole,
								accessedServices: [],
								accessedProjects: [],
								accessedEnvironments: [],
								user: { id: "user-1" },
							})),
							findMany: vi.fn(async () => []),
						};
					}
					if (table === "dodomainIntegration") {
						return {
							findFirst: mocks.integrationFindFirst,
							findMany: vi.fn(async () => []),
						};
					}
					if (table === "domains") {
						return {
							findFirst: vi.fn(async () => mocks.domain ?? undefined),
							findMany: vi.fn(async () => []),
						};
					}
					return tableMock();
				},
			}),
			// Service → organization resolver used by assertServiceInOrganization.
			execute: vi.fn(async () =>
				mocks.serviceOrganizationId
					? [{ organizationId: mocks.serviceOrganizationId }]
					: [],
			),
			select: vi.fn(() => chain()),
			insert: vi.fn(() => chain()),
			update: vi.fn(() => chain()),
			delete: vi.fn(() => chain()),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const fetchSpy = vi.fn(async () => {
	throw new Error("DoDomain must not be called in this test");
});
vi.stubGlobal("fetch", fetchSpy);

const { dodomainRouter } = await import("@/server/api/routers/dodomain");
const { createCallerFactory } = await import("@/server/api/trpc");

const createCaller = createCallerFactory(dodomainRouter);
const caller = (role = "owner") =>
	createCaller({
		user: { id: "user-1", email: "owner@test.com", role },
		session: { activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.serviceOrganizationId = "org-1";
	mocks.memberRole = "owner";
	mocks.integration = {
		dodomainId: "dd-1",
		organizationId: "org-1",
		name: "DoDomain",
		secretKey: SECRET_KEY,
		appId: "app_1",
		baseUrl: "https://dodomain.test",
		webhookEndpointId: "we_1",
		webhookUrl:
			"https://dok.example.com/api/webhooks/dodomain?integration=dd-1",
		webhookSecret: WEBHOOK_SECRET,
		createdAt: new Date(),
	};
	mocks.integrationFindFirst.mockImplementation(
		async () => mocks.integration ?? undefined,
	);
	mocks.domain = {
		domainId: "dom-x",
		host: "shop.foreign.com",
		applicationId: "app-x",
		composeId: null,
		previewDeploymentId: null,
		dodomainSessionId: null,
		dodomainConnectionId: "conn_x",
		dnsVerificationStatus: "verified",
		dnsVerifiedAt: null,
	};
});

describe("dodomain router org scoping", () => {
	it("rejects createConnectSession for a domain of another organization", async () => {
		mocks.serviceOrganizationId = "org-2";
		await expect(
			caller().createConnectSession({ domainId: "dom-x" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.integrationFindFirst).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects reverify and connectionStatus for a domain of another organization", async () => {
		mocks.serviceOrganizationId = "org-2";
		await expect(
			caller().reverify({ domainId: "dom-x" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			caller().connectionStatus({ domainId: "dom-x" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.integrationFindFirst).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects a domain that routes to no service", async () => {
		mocks.domain = {
			...mocks.domain,
			applicationId: null,
			composeId: null,
			previewDeploymentId: null,
		};
		await expect(
			caller().createConnectSession({ domainId: "dom-x" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND for an unknown domain id", async () => {
		mocks.domain = null;
		await expect(
			caller().createConnectSession({ domainId: "missing" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("dodomain router credentials", () => {
	it("masks the secret key and never returns the webhook secret", async () => {
		const result = await caller().one();
		expect(result).not.toHaveProperty("secretKey");
		expect(result).not.toHaveProperty("webhookSecret");
		expect(result?.secretKeyMasked).toBe("dd_sk_••••cdef");
		expect(result?.webhookRegistered).toBe(true);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(SECRET_KEY);
		expect(serialized).not.toContain(WEBHOOK_SECRET);
	});

	it("keeps credential procedures admin-only", async () => {
		await expect(caller("member").one()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(caller("member").remove()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(
			caller("member").testConnection({ baseUrl: "https://dodomain.test" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("tells members whether DoDomain is configured without exposing it", async () => {
		await expect(caller("member").configured()).resolves.toEqual({
			configured: true,
		});
		mocks.integration = null;
		await expect(caller("member").configured()).resolves.toEqual({
			configured: false,
		});
	});
});
