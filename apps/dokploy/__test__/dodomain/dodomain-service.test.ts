import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Service-level behaviour of the DoDomain integration: webhook events move a
 * domain's verification state (and a verified domain is re-applied through
 * the same path a domain save uses), connect sessions are created for the
 * records the panel expects and stored on the domain. DoDomain is faked at
 * the `fetch` boundary so the real client runs.
 */

const SECRET = "whsec_service_secret";

const mocks = vi.hoisted(() => ({
	integrations: [] as Record<string, unknown>[],
	claimResult: [{ deliveryId: "del_1" }] as unknown[],
	inserts: [] as { table: string; row: Record<string, unknown> }[],
	updates: [] as Record<string, unknown>[],
	deletes: 0,
	domain: null as Record<string, unknown> | null,
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	manageDomain: vi.fn(async () => {}),
	notify: vi.fn(async () => {}),
	resolveGeneratedDomainBase: vi.fn(async () => ({
		baseDomain: null as string | null,
		source: "none",
	})),
	serverIp: "203.0.113.10",
}));

vi.mock("@dokploy/server/db", async () => {
	const { getTableName } = await import("drizzle-orm");
	const updateChain = (kind: "update" | "delete") => {
		const self: any = {
			set: vi.fn((values: Record<string, unknown>) => {
				mocks.updates.push(values);
				return self;
			}),
			where: vi.fn(() => {
				if (kind === "delete") mocks.deletes += 1;
				return self;
			}),
			returning: vi.fn(async () => [
				{ ...(mocks.domain ?? {}), ...(mocks.updates.at(-1) ?? {}) },
			]),
			// biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenables
			then: (resolve: (value: unknown) => void) => resolve([]),
		};
		return self;
	};
	return {
		db: {
			query: new Proxy({} as Record<string, unknown>, {
				get: (_target, table) => {
					if (table === "dodomainIntegration") {
						return {
							findMany: vi.fn(async () => mocks.integrations),
							findFirst: vi.fn(async () => mocks.integrations[0]),
						};
					}
					if (table === "domains") {
						return {
							findFirst: vi.fn(async () => mocks.domain ?? undefined),
							findMany: vi.fn(async () => []),
						};
					}
					return {
						findFirst: vi.fn(async () => undefined),
						findMany: vi.fn(async () => []),
					};
				},
			}),
			insert: vi.fn((table: unknown) => ({
				values: (row: Record<string, unknown>) => {
					mocks.inserts.push({
						table: getTableName(table as never),
						row,
					});
					const result = {
						returning: async () => mocks.claimResult,
					};
					return {
						...result,
						onConflictDoNothing: () => result,
						onConflictDoUpdate: () => result,
					};
				},
			})),
			update: vi.fn(() => updateChain("update")),
			delete: vi.fn(() => updateChain("delete")),
			execute: vi.fn(async () => []),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server/services/application", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/application")
	>()),
	findApplicationById: mocks.findApplicationById,
}));

vi.mock("@dokploy/server/services/compose", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/compose")
	>()),
	findComposeById: mocks.findComposeById,
}));

vi.mock("@dokploy/server/services/domain", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/services/domain")>()),
	resolveGeneratedDomainBase: mocks.resolveGeneratedDomainBase,
}));

vi.mock("@dokploy/server/services/web-server-settings", async () => ({
	getWebServerSettings: vi.fn(async () => ({
		serverIp: mocks.serverIp,
		host: "dok.example.com",
		https: true,
	})),
}));

vi.mock("@dokploy/server/utils/traefik/domain", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/traefik/domain")
	>()),
	manageDomain: mocks.manageDomain,
}));

vi.mock(
	"@dokploy/server/utils/notifications/domain-verification",
	async () => ({
		sendDomainVerificationFailedNotifications: mocks.notify,
	}),
);

const { signDoDomainPayload } = await import(
	"@dokploy/server/utils/dodomain/client"
);
const { createDoDomainConnectSession, handleDoDomainWebhook } = await import(
	"@dokploy/server/services/dodomain"
);

const integration = {
	dodomainId: "dd-1",
	organizationId: "org-1",
	name: "DoDomain",
	secretKey: "dd_sk_test",
	appId: "app_1",
	baseUrl: "https://dodomain.test",
	webhookEndpointId: "we_1",
	webhookUrl: "https://dok.example.com/api/webhooks/dodomain",
	webhookSecret: SECRET,
	createdAt: new Date(),
};

const application = {
	applicationId: "app-1",
	appName: "web-abc",
	name: "Web",
	serverId: null,
	server: null,
	environment: {
		projectId: "proj-1",
		project: { projectId: "proj-1", name: "Shop", organizationId: "org-1" },
	},
};

const baseDomain = {
	domainId: "dom-1",
	host: "app.customer.com",
	https: true,
	port: 3000,
	path: "/",
	enabled: true,
	certificateType: "letsencrypt",
	domainType: "application",
	applicationId: "app-1",
	composeId: null,
	previewDeploymentId: null,
	uniqueConfigKey: 7,
	dodomainSessionId: "ses_1",
	dodomainConnectionId: null,
	dnsVerificationStatus: "pending",
	dnsVerifiedAt: null,
};

const deliver = (type: string, data: Record<string, unknown>, id = "del_1") => {
	const rawBody = JSON.stringify({
		id,
		type,
		occurredAt: new Date().toISOString(),
		data,
		event: type,
	});
	return handleDoDomainWebhook({
		rawBody,
		signature: signDoDomainPayload(SECRET, rawBody),
	});
};

let fetchCalls: { url: string; method: string; body: unknown }[] = [];
let fetchHandler: (url: string, method: string, body: unknown) => unknown =
	() => ({});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.integrations = [integration];
	mocks.claimResult = [{ deliveryId: "del_1" }];
	mocks.inserts = [];
	mocks.updates = [];
	mocks.deletes = 0;
	mocks.domain = { ...baseDomain };
	mocks.serverIp = "203.0.113.10";
	mocks.findApplicationById.mockResolvedValue(application);
	mocks.resolveGeneratedDomainBase.mockResolvedValue({
		baseDomain: null,
		source: "none",
	});
	fetchCalls = [];
	fetchHandler = () => ({});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			fetchCalls.push({ url, method, body });
			const payload = fetchHandler(url, method, body);
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
});

describe("handleDoDomainWebhook", () => {
	it("ignores a duplicate delivery id without touching the domain", async () => {
		mocks.claimResult = [];
		const result = await deliver("connection.verified", {
			domain: "app.customer.com",
			sessionId: "ses_1",
			connectionId: "conn_1",
		});
		expect(result).toEqual({
			status: 200,
			body: { received: true, duplicate: true },
		});
		expect(mocks.updates).toHaveLength(0);
		expect(mocks.manageDomain).not.toHaveBeenCalled();
	});

	it("marks the domain verified on connection.verified and re-applies it", async () => {
		const result = await deliver("connection.verified", {
			domain: "app.customer.com",
			sessionId: "ses_1",
			connectionId: "conn_1",
		});
		expect(result.status).toBe(200);
		expect(mocks.updates).toHaveLength(1);
		expect(mocks.updates[0]).toMatchObject({
			dnsVerificationStatus: "verified",
			dodomainConnectionId: "conn_1",
		});
		expect(mocks.updates[0]?.dnsVerifiedAt).toBeInstanceOf(Date);
		expect(mocks.manageDomain).toHaveBeenCalledTimes(1);
		const [appArg, domainArg] = mocks.manageDomain.mock.calls[0] as unknown as [
			typeof application,
			Record<string, unknown>,
		];
		expect(appArg.appName).toBe("web-abc");
		expect(domainArg).toMatchObject({
			domainId: "dom-1",
			dnsVerificationStatus: "verified",
		});
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("never applies an event to a domain of another organization", async () => {
		mocks.findApplicationById.mockResolvedValue({
			...application,
			environment: {
				...application.environment,
				project: {
					...application.environment.project,
					organizationId: "org-2",
				},
			},
		});
		const result = await deliver("connection.verified", {
			domain: "app.customer.com",
			sessionId: "ses_1",
			connectionId: "conn_1",
		});
		expect(result.status).toBe(200);
		expect(mocks.updates).toHaveLength(0);
		expect(mocks.manageDomain).not.toHaveBeenCalled();
	});

	it("marks the domain failed and notifies on connection.failed", async () => {
		mocks.domain = {
			...baseDomain,
			dnsVerificationStatus: "verified",
			dodomainConnectionId: "conn_1",
		};
		const result = await deliver("connection.failed", {
			domain: "app.customer.com",
			sessionId: "ses_1",
			connectionId: "conn_1",
			fqdn: "app.customer.com",
			reason: "dns_drift",
			scope: "connection",
			records: [{ fqdn: "app.customer.com", type: "A" }],
		});
		expect(result.status).toBe(200);
		expect(mocks.updates[0]).toMatchObject({ dnsVerificationStatus: "failed" });
		expect(mocks.notify).toHaveBeenCalledTimes(1);
		expect(mocks.notify).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				host: "app.customer.com",
				projectName: "Shop",
			}),
		);
		expect(mocks.manageDomain).not.toHaveBeenCalled();
	});

	it("marks the domain failed, drops the connection and notifies on connection.disconnected", async () => {
		mocks.domain = {
			...baseDomain,
			dnsVerificationStatus: "verified",
			dodomainConnectionId: "conn_1",
		};
		await deliver("connection.disconnected", {
			domain: "app.customer.com",
			sessionId: "ses_1",
			connectionId: "conn_1",
			fqdn: "app.customer.com",
			disconnectedAt: new Date().toISOString(),
		});
		expect(mocks.updates[0]).toMatchObject({
			dnsVerificationStatus: "failed",
			dodomainConnectionId: null,
		});
		expect(mocks.notify).toHaveBeenCalledTimes(1);
	});

	it("resets a pending domain to unverified on session.abandoned", async () => {
		await deliver("session.abandoned", {
			domain: "app.customer.com",
			sessionId: "ses_1",
			lastStatus: "pending",
			expiredAt: new Date().toISOString(),
		});
		expect(mocks.updates[0]).toMatchObject({
			dnsVerificationStatus: "unverified",
			dodomainSessionId: null,
		});
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("stores the connection id on session.completed", async () => {
		await deliver("session.completed", {
			domain: "app.customer.com",
			sessionId: "ses_1",
			connectionId: "conn_9",
		});
		expect(mocks.updates[0]).toMatchObject({ dodomainConnectionId: "conn_9" });
		expect(mocks.manageDomain).not.toHaveBeenCalled();
	});

	it("acknowledges DoDomain test pings without writing", async () => {
		const result = await deliver("connection.verified", {
			test: true,
			domain: "test.dodomain.invalid",
			sessionId: "sess_test_1",
			connectionId: "conn_test",
		});
		expect(result).toMatchObject({ status: 200, body: { test: true } });
		expect(mocks.inserts).toHaveLength(0);
		expect(mocks.updates).toHaveLength(0);
	});

	it("acknowledges an event for an unknown domain without writing", async () => {
		mocks.domain = null;
		const result = await deliver("connection.verified", {
			domain: "x.example.com",
			sessionId: "ses_other",
			connectionId: "conn_other",
		});
		expect(result.status).toBe(200);
		expect(mocks.updates).toHaveLength(0);
	});

	it("releases the delivery claim and answers 500 when applying fails", async () => {
		mocks.manageDomain.mockRejectedValueOnce(new Error("traefik down"));
		const result = await deliver("connection.verified", {
			domain: "app.customer.com",
			sessionId: "ses_1",
			connectionId: "conn_1",
		});
		expect(result.status).toBe(500);
		expect(mocks.deletes).toBe(1);
	});

	it("rejects a bad signature with 401 before any write", async () => {
		const rawBody = JSON.stringify({
			id: "del_1",
			type: "connection.verified",
			occurredAt: new Date().toISOString(),
			data: { sessionId: "ses_1", connectionId: "conn_1", domain: "x" },
		});
		const result = await handleDoDomainWebhook({
			rawBody,
			signature: signDoDomainPayload("whsec_wrong", rawBody),
		});
		expect(result.status).toBe(401);
		expect(mocks.inserts).toHaveLength(0);
		expect(mocks.updates).toHaveLength(0);
	});
});

describe("createDoDomainConnectSession", () => {
	const sessionResponse = {
		id: "ses_new",
		token: "dd_sess_abc",
		expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
		connectUrl: "https://dodomain.test/connect/dd_sess_abc",
		records: [{ type: "A", host: "@", fqdn: "app.customer.com" }],
	};

	it("creates a session for the domain host, stores its ids and returns the connect URL", async () => {
		mocks.domain = {
			...baseDomain,
			dodomainSessionId: null,
			dnsVerificationStatus: null,
		};
		fetchHandler = (url) => {
			if (url.endsWith("/api/v1/domains/check")) {
				return { domain: "app.customer.com", zone: "customer.com" };
			}
			if (url.endsWith("/api/v1/sessions")) return sessionResponse;
			return {};
		};
		const result = await createDoDomainConnectSession({
			integration,
			domainId: "dom-1",
		});

		expect(result.connectUrl).toBe(sessionResponse.connectUrl);
		expect(result.sessionId).toBe("ses_new");
		expect(result.records).toEqual([
			{ type: "A", host: "@", value: "203.0.113.10" },
		]);

		const sessionCall = fetchCalls.find((c) =>
			c.url.endsWith("/api/v1/sessions"),
		);
		expect(sessionCall?.method).toBe("POST");
		expect(sessionCall?.body).toMatchObject({
			domain: "app.customer.com",
			records: [{ type: "A", host: "@", value: "203.0.113.10" }],
		});

		expect(mocks.updates[0]).toMatchObject({
			dodomainSessionId: "ses_new",
			dnsVerificationStatus: "pending",
		});
		const stored = mocks.inserts.find(
			(i) => i.table === "dodomain_connect_session",
		);
		expect(stored?.row).toMatchObject({
			sessionId: "ses_new",
			domainId: "dom-1",
			dodomainId: "dd-1",
			connectUrl: sessionResponse.connectUrl,
		});
	});

	it("targets the wildcard base with a CNAME for a subdomain when one is configured", async () => {
		mocks.resolveGeneratedDomainBase.mockResolvedValue({
			baseDomain: "apps.example.com",
			source: "organization",
		});
		fetchHandler = (url) => {
			if (url.endsWith("/api/v1/domains/check")) {
				return { domain: "app.customer.com", zone: "customer.com" };
			}
			if (url.endsWith("/api/v1/sessions")) return sessionResponse;
			return {};
		};
		const result = await createDoDomainConnectSession({
			integration,
			domainId: "dom-1",
		});
		expect(result.records).toEqual([
			{ type: "CNAME", host: "@", value: "web-abc.apps.example.com" },
		]);
	});

	it("uses an A record at a zone apex even when a wildcard base exists", async () => {
		mocks.domain = { ...baseDomain, host: "customer.com" };
		mocks.resolveGeneratedDomainBase.mockResolvedValue({
			baseDomain: "apps.example.com",
			source: "organization",
		});
		fetchHandler = (url) => {
			if (url.endsWith("/api/v1/domains/check")) {
				return { domain: "customer.com", zone: "customer.com" };
			}
			if (url.endsWith("/api/v1/sessions")) return sessionResponse;
			return {};
		};
		const result = await createDoDomainConnectSession({
			integration,
			domainId: "dom-1",
		});
		expect(result.records).toEqual([
			{ type: "A", host: "@", value: "203.0.113.10" },
		]);
	});

	it("refuses a wildcard host before calling DoDomain", async () => {
		mocks.domain = { ...baseDomain, host: "*.customer.com" };
		await expect(
			createDoDomainConnectSession({ integration, domainId: "dom-1" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(fetchCalls).toHaveLength(0);
	});

	it("refuses when the panel knows no public IP to point the domain at", async () => {
		mocks.serverIp = "";
		fetchHandler = (url) =>
			url.endsWith("/api/v1/domains/check")
				? { domain: "app.customer.com", zone: "customer.com" }
				: sessionResponse;
		await expect(
			createDoDomainConnectSession({ integration, domainId: "dom-1" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(fetchCalls.some((c) => c.url.endsWith("/api/v1/sessions"))).toBe(
			false,
		);
	});
});
