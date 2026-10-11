import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outbound DoDomain status sync. The panel asks DoDomain what happened (poll)
 * instead of waiting for DoDomain to push (webhook), and both feed ONE
 * idempotent transition function.
 *
 * DoDomain is faked at the `fetch` boundary so the real client runs. The
 * database is a small stateful fake: it builds the real drizzle statement
 * (no connection), renders it to SQL and evaluates the guards the transition
 * relies on (`IS DISTINCT FROM`, compare-and-set on the status, ...) against
 * the in-memory domain row. That is what lets a webhook and a poll race on the
 * same row and prove exactly one of them changes it.
 */

const SECRET_KEY = "dd_sk_org1_secret";
const OTHER_SECRET_KEY = "dd_sk_org2_secret";
const WEBHOOK_SECRET = "whsec_sync_secret";
const TOKEN = "dd_sess_supersecrettoken";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
	integrations: [] as Row[],
	domains: {} as Record<string, Row>,
	session: null as Row | null,
	/** Rows the (mocked) candidate SELECT reports. */
	candidates: [] as { domainId: string }[],
	apps: {} as Record<string, Row>,
	statements: [] as { sql: string; params: unknown[] }[],
	selects: [] as { sql: string; params: unknown[] }[],
	inserts: [] as { table: string; row: Row }[],
	claimResult: [{ deliveryId: "del_1" }] as unknown[],
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	manageDomain: vi.fn(async () => {}),
	notify: vi.fn(async () => {}),
}));

vi.mock("@dokploy/server/db", async () => {
	const { getTableName } = await import("drizzle-orm");
	const { drizzle } = await import("drizzle-orm/postgres-js");
	const postgres = (await import("postgres")).default;
	const builder = drizzle(postgres("postgres://mock:mock@localhost:5432/mock"));

	const boundValues = (condition: unknown): string[] => {
		if (!condition || typeof condition !== "object") return [];
		if (Array.isArray(condition)) return condition.flatMap(boundValues);
		const node = condition as { value?: unknown; queryChunks?: unknown[] };
		const found: string[] = [];
		if (typeof node.value === "string") found.push(node.value);
		for (const chunk of node.queryChunks ?? []) {
			found.push(...boundValues(chunk));
		}
		return found;
	};

	/**
	 * Evaluates the WHERE of an UPDATE on "domain" against `row`. Only the
	 * clauses the sync code emits are modelled; anything else throws so a new
	 * clause cannot silently pass.
	 */
	const matches = (sqlText: string, params: unknown[], row: Row) => {
		const where = sqlText.slice(sqlText.toLowerCase().indexOf(" where ") + 7);
		const clauses = where.replace(/^\(/, "").replace(/\)$/, "").split(/ and /i);
		return clauses.every((clause) => {
			const text = clause.trim();
			let m = /^"domain"\."(\w+)" is not distinct from \$(\d+)$/i.exec(text);
			if (m)
				return (
					(row[m[1] as string] ?? null) === (params[Number(m[2]) - 1] ?? null)
				);
			m = /^"domain"\."(\w+)" is distinct from \$(\d+)$/i.exec(text);
			if (m)
				return (
					(row[m[1] as string] ?? null) !== (params[Number(m[2]) - 1] ?? null)
				);
			m = /^"domain"\."(\w+)" = \$(\d+)$/i.exec(text);
			if (m)
				return (
					(row[m[1] as string] ?? null) === (params[Number(m[2]) - 1] ?? null)
				);
			m = /^"domain"\."(\w+)" is not null$/i.exec(text);
			if (m) return (row[m[1] as string] ?? null) !== null;
			throw new Error(`Unmodelled clause in test db: ${text}`);
		});
	};

	const liveSession = () =>
		!!mocks.session && (mocks.session.expiresAt as Date).getTime() > Date.now();

	const updateChain = (table: never) => {
		const name = getTableName(table);
		let setValues: Row = {};
		const self: any = {
			set: (values: Row) => {
				setValues = values;
				return self;
			},
			where: (condition: never) => {
				self.condition = condition;
				return self;
			},
			returning: async () => run(true),
			// biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenables
			then: (resolve: (value: unknown) => void, reject: (e: unknown) => void) =>
				run(false).then(resolve, reject),
		};
		const run = async (returning: boolean) => {
			const query = (builder.update(table) as any)
				.set(setValues)
				.where(self.condition)
				.toSQL();
			mocks.statements.push({ sql: query.sql, params: query.params });
			if (name === "dodomain_connect_session") {
				if (mocks.session) Object.assign(mocks.session, setValues);
				return [];
			}
			// The expired-session sweep (existing helper): modelled by its meaning,
			// its SQL is covered by dodomain-session-expiry.test.ts.
			if (/not exists/i.test(query.sql)) {
				const ids = boundValues(self.condition);
				const reset: Row[] = [];
				for (const row of Object.values(mocks.domains)) {
					if (
						ids.includes(row.domainId as string) &&
						row.dnsVerificationStatus === "pending" &&
						!row.dodomainConnectionId &&
						!liveSession()
					) {
						Object.assign(row, setValues);
						reset.push({ domainId: row.domainId });
					}
				}
				return returning ? reset : [];
			}
			const id = boundValues(self.condition)[0] as string;
			const row = mocks.domains[id];
			if (!row || !matches(query.sql, query.params, row)) return [];
			Object.assign(row, setValues);
			return returning ? [{ ...row }] : [];
		};
		return self;
	};

	return {
		db: {
			query: new Proxy({} as Record<string, unknown>, {
				get: (_target, table) => {
					if (table === "domains") {
						return {
							findFirst: vi.fn(async (args?: { where?: unknown }) => {
								const wanted = boundValues(args?.where);
								const row = Object.values(mocks.domains).find(
									(candidate) =>
										wanted.includes(candidate.domainId as string) ||
										wanted.includes(candidate.dodomainSessionId as string) ||
										wanted.includes(candidate.dodomainConnectionId as string),
								);
								return row ? { ...row } : undefined;
							}),
							findMany: vi.fn(async () => []),
						};
					}
					if (table === "dodomainIntegration") {
						const byId = (args?: { where?: unknown }) => {
							const wanted = boundValues(args?.where);
							return mocks.integrations.find(
								(integration) =>
									wanted.includes(integration.organizationId as string) ||
									wanted.includes(integration.dodomainId as string),
							);
						};
						return {
							findFirst: vi.fn(async (args?: { where?: unknown }) =>
								byId(args),
							),
							findMany: vi.fn(async () => mocks.integrations),
						};
					}
					if (table === "dodomainConnectSession") {
						return {
							findFirst: vi.fn(async () =>
								mocks.session ? { ...mocks.session } : undefined,
							),
						};
					}
					return {
						findFirst: vi.fn(async () => undefined),
						findMany: vi.fn(async () => []),
					};
				},
			}),
			// Real drizzle select builders (they are also used as sub-queries), made
			// awaitable with the rows the test configured; awaiting records the SQL.
			select: (fields: never) => ({
				from: (table: never) => {
					const name = getTableName(table);
					const rows = () =>
						name === "dodomain_integration"
							? mocks.integrations.map((i) => ({ id: i.dodomainId }))
							: mocks.candidates;
					const settle = (query: any) => {
						// biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenables
						query.then = (
							resolve: (value: unknown) => void,
							reject: (e: unknown) => void,
						) => {
							const rendered = query.toSQL();
							mocks.selects.push({
								sql: rendered.sql,
								params: rendered.params,
							});
							return Promise.resolve(rows()).then(resolve, reject);
						};
						return query;
					};
					const query: any = (builder.select(fields) as any).from(table);
					const where = query.where.bind(query);
					const limit = query.limit.bind(query);
					query.where = (condition: never) => settle(where(condition));
					query.limit = (count: number) => settle(limit(count));
					return settle(query);
				},
			}),
			insert: (table: unknown) => ({
				values: (row: Row) => {
					mocks.inserts.push({ table: getTableName(table as never), row });
					const result = { returning: async () => mocks.claimResult };
					return {
						...result,
						onConflictDoNothing: () => result,
					};
				},
			}),
			update: (table: never) => updateChain(table),
			delete: () => ({ where: async () => [] }),
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
	resolveGeneratedDomainBase: vi.fn(async () => ({
		baseDomain: null as string | null,
		source: "none",
	})),
}));

vi.mock("@dokploy/server/services/web-server-settings", async () => ({
	getWebServerSettings: vi.fn(async () => ({
		serverIp: "203.0.113.10",
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

const { DoDomainError, signDoDomainPayload } = await import(
	"@dokploy/server/utils/dodomain/client"
);
const { setBackgroundErrorReporter } = await import(
	"@dokploy/server/utils/process/background"
);
const {
	createDoDomainConnectSession,
	getDoDomainConnectionStatus,
	handleDoDomainWebhook,
} = await import("@dokploy/server/services/dodomain");
const {
	findDoDomainSyncCandidates,
	reverifyDoDomainDomain,
	resetDoDomainSyncState,
	runDoDomainSyncCycle,
	syncDoDomainDomain,
} = await import("@dokploy/server/services/dodomain-sync");
const { dodomainConnectSession } = await import("@dokploy/server/db/schema");

const integration = {
	dodomainId: "dd-1",
	organizationId: "org-1",
	name: "DoDomain",
	secretKey: SECRET_KEY,
	appId: "app_1",
	baseUrl: "https://dodomain.test",
	webhookEndpointId: "we_1",
	webhookUrl: "https://dok.example.com/api/webhooks/dodomain",
	webhookSecret: WEBHOOK_SECRET,
	createdAt: new Date(),
};

const appFor = (organizationId: string, applicationId = "app-1") => ({
	applicationId,
	appName: `web-${applicationId}`,
	name: "Web",
	serverId: null,
	server: null,
	environmentId: "env-1",
	environment: {
		projectId: "proj-1",
		project: { projectId: "proj-1", name: "Shop", organizationId },
	},
});

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

/** DoDomain's hosted link is `<origin>/connect/<token>`: it carries the token. */
const connectUrlFor = (token: string) =>
	`https://connect.dodomain.test/connect/${token}`;
/** A link from before tokens were stored, with nothing token-shaped in it. */
const LEGACY_CONNECT_URL = "https://connect.dodomain.test/s/abc123";

const liveSession = (overrides: Row = {}) => ({
	sessionId: "ses_1",
	domainId: "dom-1",
	dodomainId: "dd-1",
	connectUrl: connectUrlFor(TOKEN),
	records: [{ type: "A", host: "@", value: "203.0.113.10" }],
	expiresAt: new Date(Date.now() + 3_600_000),
	createdAt: new Date(),
	token: TOKEN,
	...overrides,
});

const connection = (overrides: Row = {}) => ({
	id: "conn_1",
	appId: "app_1",
	sessionId: "ses_1",
	domain: "app.customer.com",
	recordFqdns: ["app.customer.com"],
	status: "active",
	verifiedAt: "2026-10-11T10:00:00.000Z",
	lastCheckedAt: "2026-10-11T10:00:00.000Z",
	brokenAt: null,
	disconnectedAt: null,
	createdAt: "2026-10-11T09:00:00.000Z",
	...overrides,
});

const sessionState = (overrides: Row = {}) => ({
	id: "ses_1",
	appId: "app_1",
	domain: "app.customer.com",
	status: "pending",
	connectionId: null,
	createdAt: new Date().toISOString(),
	expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
	expired: false,
	...overrides,
});

interface FetchCall {
	key: string;
	url: string;
	authorization: string | null;
}
let fetchCalls: FetchCall[] = [];
let routes: Record<
	string,
	(call: FetchCall) => {
		status?: number;
		body: unknown;
		headers?: Record<string, string>;
		/** The request never gets an answer (timeout, connection refused). */
		networkError?: boolean;
	}
> = {};
let logged: string[] = [];

const stubLogs = () => {
	logged = [];
	for (const level of ["log", "info", "warn", "error"] as const) {
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			logged.push(
				args
					.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
					.join(" "),
			);
		});
	}
};

const domainRow = (id = "dom-1") => mocks.domains[id] as Row;

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
		signature: signDoDomainPayload(WEBHOOK_SECRET, rawBody),
	});
};

beforeEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	resetDoDomainSyncState();
	stubLogs();
	mocks.integrations = [integration];
	mocks.domains = { "dom-1": { ...baseDomain } };
	mocks.session = liveSession();
	mocks.candidates = [];
	mocks.statements = [];
	mocks.selects = [];
	mocks.inserts = [];
	mocks.claimResult = [{ deliveryId: "del_1" }];
	mocks.apps = { "app-1": appFor("org-1") };
	mocks.findApplicationById.mockImplementation(async (id: string) => {
		const app = mocks.apps[id];
		if (!app) throw new Error(`no app ${id}`);
		return app;
	});
	fetchCalls = [];
	routes = {};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const path = new URL(url).pathname;
			const key = `${method} ${path}`;
			const headers = (init?.headers ?? {}) as Record<string, string>;
			const call: FetchCall = {
				key,
				url,
				authorization: headers.authorization ?? null,
			};
			fetchCalls.push(call);
			const route = routes[key];
			if (!route) {
				return new Response(JSON.stringify({ error: "not_found" }), {
					status: 404,
				});
			}
			const { status = 200, body, headers: extra, networkError } = route(call);
			if (networkError) throw new TypeError("fetch failed");
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json", ...(extra ?? {}) },
			});
		}),
	);
});

const calledKeys = () => fetchCalls.map((call) => call.key);

describe("syncDoDomainDomain: pending → verified", () => {
	it("runs the live check, reads the finalized connection and verifies the domain", async () => {
		let finalized = false;
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			body: sessionState(
				finalized ? { status: "verified", connectionId: "conn_1" } : {},
			),
		});
		routes[`POST /api/v1/sessions/${TOKEN}/verify`] = () => {
			finalized = true;
			return { body: { verified: true, records: [], advisories: [] } };
		};
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });

		const result = await syncDoDomainDomain("dom-1");

		expect(result.outcome).toBe("verified");
		expect(domainRow()).toMatchObject({
			dnsVerificationStatus: "verified",
			dodomainConnectionId: "conn_1",
		});
		expect(domainRow().dnsVerifiedAt).toBeInstanceOf(Date);
		// The same Traefik re-apply the webhook path triggers.
		expect(mocks.manageDomain).toHaveBeenCalledTimes(1);
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("authenticates the verify route by the token alone, never the secret key", async () => {
		routes["GET /api/v1/sessions/ses_1"] = () => ({ body: sessionState() });
		routes[`POST /api/v1/sessions/${TOKEN}/verify`] = () => ({
			body: { verified: false, records: [], advisories: [] },
		});
		await syncDoDomainDomain("dom-1");
		const verify = fetchCalls.find((call) => call.key.endsWith("/verify"));
		expect(verify?.authorization).toBeNull();
		const get = fetchCalls.find((call) => call.key.startsWith("GET"));
		expect(get?.authorization).toBe(`Bearer ${SECRET_KEY}`);
	});

	it("keeps waiting, without writing, while the records have not propagated", async () => {
		routes["GET /api/v1/sessions/ses_1"] = () => ({ body: sessionState() });
		routes[`POST /api/v1/sessions/${TOKEN}/verify`] = () => ({
			body: { verified: false, records: [], advisories: [] },
		});
		const result = await syncDoDomainDomain("dom-1");
		expect(result.outcome).toBe("waiting");
		expect(domainRow().dnsVerificationStatus).toBe("pending");
		expect(mocks.statements).toHaveLength(0);
		expect(mocks.manageDomain).not.toHaveBeenCalled();
	});

	it("leaves a compose domain verified without touching Traefik (it follows the next deploy)", async () => {
		mocks.domains["dom-1"] = {
			...baseDomain,
			applicationId: null,
			composeId: "cmp-1",
		};
		mocks.findComposeById.mockResolvedValue({
			composeId: "cmp-1",
			appName: "stack-abc",
			name: "Stack",
			serverId: null,
			server: null,
			environmentId: "env-1",
			environment: {
				projectId: "proj-1",
				project: { projectId: "proj-1", name: "Shop", organizationId: "org-1" },
			},
		});
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			body: sessionState({ status: "verified", connectionId: "conn_1" }),
		});
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });

		const result = await syncDoDomainDomain("dom-1");

		expect(result.outcome).toBe("verified");
		expect(mocks.manageDomain).not.toHaveBeenCalled();
		// The status view still tells the UI a compose service needs a redeploy.
		const status = await getDoDomainConnectionStatus({
			integration: integration as never,
			domainId: "dom-1",
		});
		expect(status).toMatchObject({
			status: "verified",
			requiresRedeploy: true,
		});
	});
});

describe("syncDoDomainDomain: verified → broken", () => {
	beforeEach(() => {
		mocks.domains["dom-1"] = {
			...baseDomain,
			dnsVerificationStatus: "verified",
			dodomainConnectionId: "conn_1",
			dnsVerifiedAt: new Date("2026-10-11T10:00:00Z"),
		};
	});

	it("marks a broken connection failed and notifies exactly once across repeated polls", async () => {
		routes["GET /api/v1/connections/conn_1"] = () => ({
			body: connection({
				status: "broken",
				brokenAt: "2026-10-11T11:00:00.000Z",
			}),
		});

		expect((await syncDoDomainDomain("dom-1")).outcome).toBe("failed");
		expect((await syncDoDomainDomain("dom-1")).outcome).toBe("unchanged");
		expect((await syncDoDomainDomain("dom-1")).outcome).toBe("unchanged");

		expect(domainRow().dnsVerificationStatus).toBe("failed");
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

	it("treats a disconnected connection as failed and forgets its id", async () => {
		routes["GET /api/v1/connections/conn_1"] = () => ({
			body: connection({ disconnectedAt: "2026-10-11T11:00:00.000Z" }),
		});
		await syncDoDomainDomain("dom-1");
		expect(domainRow()).toMatchObject({
			dnsVerificationStatus: "failed",
			dodomainConnectionId: null,
		});
		expect(mocks.notify).toHaveBeenCalledTimes(1);
	});

	it("does nothing while the connection stays active", async () => {
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });
		const result = await syncDoDomainDomain("dom-1");
		expect(result.outcome).toBe("unchanged");
		expect(mocks.statements).toHaveLength(0);
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("restores a failed domain whose connection recovered, and re-applies it", async () => {
		mocks.domains["dom-1"] = {
			...(domainRow() as Row),
			dnsVerificationStatus: "failed",
		};
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });
		const result = await syncDoDomainDomain("dom-1");
		expect(result.outcome).toBe("verified");
		expect(domainRow().dnsVerificationStatus).toBe("verified");
		expect(mocks.manageDomain).toHaveBeenCalledTimes(1);
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("drops a verdict computed from a read that another source has since overtaken", async () => {
		// The poll read a failed domain and an active connection; before it could
		// write, the row moved on (a webhook, a reset). Its "verified" must not
		// win the compare-and-set.
		domainRow().dnsVerificationStatus = "failed";
		routes["GET /api/v1/connections/conn_1"] = () => {
			domainRow().dnsVerificationStatus = "unverified";
			return { body: connection() };
		};
		const result = await syncDoDomainDomain("dom-1");
		expect(result.outcome).toBe("unchanged");
		expect(domainRow().dnsVerificationStatus).toBe("unverified");
		expect(mocks.manageDomain).not.toHaveBeenCalled();
	});
});

describe("webhook and poll share one transition", () => {
	beforeEach(() => {
		mocks.domains["dom-1"] = {
			...baseDomain,
			dnsVerificationStatus: "verified",
			dodomainConnectionId: "conn_1",
		};
		routes["GET /api/v1/connections/conn_1"] = () => ({
			body: connection({ status: "broken" }),
		});
	});

	const failedEvent = {
		domain: "app.customer.com",
		sessionId: "ses_1",
		connectionId: "conn_1",
		fqdn: "app.customer.com",
		reason: "dns_drift",
		scope: "connection",
	};

	it("poll first, then the webhook for the same event: one notification", async () => {
		await syncDoDomainDomain("dom-1");
		const result = await deliver("connection.failed", failedEvent);
		expect(result).toMatchObject({
			status: 200,
			body: { received: true, ignored: "unchanged" },
		});
		expect(mocks.notify).toHaveBeenCalledTimes(1);
	});

	it("webhook first, then the poll: one notification", async () => {
		await deliver("connection.failed", failedEvent);
		const result = await syncDoDomainDomain("dom-1");
		expect(result.outcome).toBe("unchanged");
		expect(mocks.notify).toHaveBeenCalledTimes(1);
	});

	it("both at once: a single transition, a single notification", async () => {
		await Promise.all([
			deliver("connection.failed", failedEvent),
			syncDoDomainDomain("dom-1"),
		]);
		expect(domainRow().dnsVerificationStatus).toBe("failed");
		expect(mocks.notify).toHaveBeenCalledTimes(1);
	});

	it("a verified webhook after a verified poll does not re-apply the domain", async () => {
		mocks.domains["dom-1"] = { ...baseDomain };
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			body: sessionState({ status: "verified", connectionId: "conn_1" }),
		});
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });
		await syncDoDomainDomain("dom-1");
		await deliver("connection.verified", {
			domain: "app.customer.com",
			sessionId: "ses_1",
			connectionId: "conn_1",
		});
		expect(mocks.manageDomain).toHaveBeenCalledTimes(1);
	});

	it("a redelivered failure after a disconnect does not notify again but forgets the connection", async () => {
		await deliver("connection.failed", failedEvent);
		await deliver(
			"connection.disconnected",
			{ ...failedEvent, disconnectedAt: new Date().toISOString() },
			"del_2",
		);
		expect(domainRow().dodomainConnectionId).toBeNull();
		expect(mocks.notify).toHaveBeenCalledTimes(1);
	});

	it("rolls the verified state back when re-applying it fails, so a retry runs again", async () => {
		mocks.domains["dom-1"] = { ...baseDomain };
		mocks.manageDomain.mockRejectedValueOnce(new Error("traefik down"));
		const first = await deliver("connection.verified", {
			sessionId: "ses_1",
			connectionId: "conn_1",
		});
		expect(first.status).toBe(500);
		expect(domainRow().dnsVerificationStatus).toBe("pending");
		const retry = await deliver("connection.verified", {
			sessionId: "ses_1",
			connectionId: "conn_1",
		});
		expect(retry.status).toBe(200);
		expect(domainRow().dnsVerificationStatus).toBe("verified");
		expect(mocks.manageDomain).toHaveBeenCalledTimes(2);
	});
});

describe("expired sessions", () => {
	it("resets a pending domain whose session expired locally, through the shared sweep", async () => {
		mocks.session = liveSession({ expiresAt: new Date(Date.now() - 1000) });
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			body: sessionState({ status: "expired", expired: true }),
		});
		const result = await syncDoDomainDomain("dom-1");
		expect(result.outcome).toBe("reset");
		expect(domainRow()).toMatchObject({
			dnsVerificationStatus: "unverified",
			dodomainSessionId: null,
		});
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("still picks up a connection that finalized right before the session expired", async () => {
		mocks.session = liveSession({ expiresAt: new Date(Date.now() - 1000) });
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			body: sessionState({
				status: "verified",
				connectionId: "conn_1",
				expired: true,
			}),
		});
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });
		const result = await syncDoDomainDomain("dom-1");
		expect(result.outcome).toBe("verified");
		expect(domainRow().dnsVerificationStatus).toBe("verified");
	});

	it("honours DoDomain saying the session expired when the local clock says it is live", async () => {
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			body: sessionState({ status: "expired", expired: true }),
		});
		const result = await syncDoDomainDomain("dom-1");
		expect(result.outcome).toBe("reset");
		expect(domainRow().dnsVerificationStatus).toBe("unverified");
	});

	it("treats HTTP 410 from the verify call as expiry", async () => {
		routes["GET /api/v1/sessions/ses_1"] = () => ({ body: sessionState() });
		routes[`POST /api/v1/sessions/${TOKEN}/verify`] = () => ({
			status: 410,
			body: { error: "gone" },
		});
		const result = await syncDoDomainDomain("dom-1");
		expect(result.outcome).toBe("reset");
		expect(domainRow().dodomainSessionId).toBeNull();
	});

	it("never resets a domain that is already verified", async () => {
		mocks.session = liveSession({ expiresAt: new Date(Date.now() - 1000) });
		mocks.domains["dom-1"] = {
			...baseDomain,
			dnsVerificationStatus: "verified",
			dodomainConnectionId: "conn_1",
		};
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });
		const result = await syncDoDomainDomain("dom-1");
		expect(result.outcome).toBe("unchanged");
		expect(domainRow().dnsVerificationStatus).toBe("verified");
	});
});

describe("sessions created before the token was stored", () => {
	it("maps the session to its connection through the connection list", async () => {
		mocks.session = liveSession({
			token: null,
			connectUrl: LEGACY_CONNECT_URL,
		});
		routes["GET /api/v1/sessions/ses_1"] = () => ({ body: sessionState() });
		routes["GET /api/v1/connections"] = () => ({
			body: {
				connections: [
					connection({ id: "conn_other", sessionId: "ses_other" }),
					connection(),
				],
				nextCursor: null,
			},
		});
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });

		const result = await syncDoDomainDomain("dom-1");

		expect(result.outcome).toBe("verified");
		expect(domainRow().dodomainConnectionId).toBe("conn_1");
		expect(calledKeys().some((key) => key.endsWith("/verify"))).toBe(false);
		const list = fetchCalls.find(
			(call) => call.key === "GET /api/v1/connections",
		);
		expect(new URL(list?.url ?? "").searchParams.get("domain")).toBe(
			"app.customer.com",
		);
		expect(new URL(list?.url ?? "").searchParams.get("appId")).toBe("app_1");
	});

	it("waits (no error) when the session has no connection yet and no token", async () => {
		mocks.session = liveSession({
			token: null,
			connectUrl: LEGACY_CONNECT_URL,
		});
		routes["GET /api/v1/sessions/ses_1"] = () => ({ body: sessionState() });
		routes["GET /api/v1/connections"] = () => ({
			body: { connections: [], nextCursor: null },
		});
		const result = await syncDoDomainDomain("dom-1");
		expect(result.outcome).toBe("waiting");
		expect(mocks.statements).toHaveLength(0);
	});

	it("recovers the token from the connect link, which carries it", async () => {
		mocks.session = liveSession({ token: null });
		routes["GET /api/v1/sessions/ses_1"] = () => ({ body: sessionState() });
		routes[`POST /api/v1/sessions/${TOKEN}/verify`] = () => ({
			body: { verified: false, records: [], advisories: [] },
		});
		await syncDoDomainDomain("dom-1");
		expect(calledKeys()).toContain(`POST /api/v1/sessions/${TOKEN}/verify`);
	});
});

describe("rate limiting", () => {
	beforeEach(() => {
		mocks.domains = {
			"dom-1": { ...baseDomain },
			"dom-2": {
				...baseDomain,
				domainId: "dom-2",
				host: "two.customer.com",
				dodomainSessionId: "ses_2",
			},
		};
		mocks.session = liveSession();
	});

	it("backs off the whole organization after a 429 and resumes once the delay passes", async () => {
		const now = 1_000_000;
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			status: 429,
			body: { error: "rate_limited", details: { retryAfterSeconds: 90 } },
		});
		const first = await syncDoDomainDomain("dom-1", {
			respectBackoff: true,
			now: () => now,
		});
		expect(first).toEqual({ outcome: "rate_limited", retryAfterSeconds: 90 });
		const callsAfterFirst = fetchCalls.length;

		const second = await syncDoDomainDomain("dom-2", {
			respectBackoff: true,
			now: () => now + 30_000,
		});
		expect(second).toEqual({ outcome: "skipped", reason: "backoff" });
		expect(fetchCalls).toHaveLength(callsAfterFirst);

		routes["GET /api/v1/sessions/ses_1"] = () => ({ body: sessionState() });
		routes[`POST /api/v1/sessions/${TOKEN}/verify`] = () => ({
			body: { verified: false, records: [], advisories: [] },
		});
		const third = await syncDoDomainDomain("dom-1", {
			respectBackoff: true,
			now: () => now + 91_000,
		});
		expect(third.outcome).toBe("waiting");
	});

	it("uses a bounded default delay when DoDomain gives no Retry-After", async () => {
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			status: 429,
			body: { error: "rate_limited" },
		});
		const result = await syncDoDomainDomain("dom-1", { respectBackoff: true });
		expect(result.outcome).toBe("rate_limited");
		expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(30);
		expect(result.retryAfterSeconds).toBeLessThanOrEqual(900);
	});

	it("a manual check ignores the backoff the cron respects", async () => {
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			status: 429,
			body: { error: "rate_limited" },
		});
		await syncDoDomainDomain("dom-1", { respectBackoff: true });
		routes["GET /api/v1/sessions/ses_1"] = () => ({ body: sessionState() });
		routes[`POST /api/v1/sessions/${TOKEN}/verify`] = () => ({
			body: { verified: false, records: [], advisories: [] },
		});
		const manual = await syncDoDomainDomain("dom-1");
		expect(manual.outcome).toBe("waiting");
	});
});

describe("organization isolation", () => {
	it("syncs each domain with its own organization's integration", async () => {
		mocks.integrations = [
			integration,
			{
				...integration,
				dodomainId: "dd-2",
				organizationId: "org-2",
				secretKey: OTHER_SECRET_KEY,
				appId: "app_2",
				baseUrl: "https://other.dodomain.test",
			},
		];
		mocks.apps["app-2"] = appFor("org-2", "app-2");
		mocks.domains = {
			"dom-1": {
				...baseDomain,
				dnsVerificationStatus: "verified",
				dodomainConnectionId: "conn_1",
			},
			"dom-2": {
				...baseDomain,
				domainId: "dom-2",
				applicationId: "app-2",
				dnsVerificationStatus: "verified",
				dodomainConnectionId: "conn_2",
			},
		};
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });
		routes["GET /api/v1/connections/conn_2"] = () => ({
			body: connection({ id: "conn_2" }),
		});

		await syncDoDomainDomain("dom-1");
		await syncDoDomainDomain("dom-2");

		const byKey = Object.fromEntries(
			fetchCalls.map((call) => [call.key, call]),
		);
		expect(byKey["GET /api/v1/connections/conn_1"]?.authorization).toBe(
			`Bearer ${SECRET_KEY}`,
		);
		expect(byKey["GET /api/v1/connections/conn_1"]?.url).toContain(
			"https://dodomain.test/",
		);
		expect(byKey["GET /api/v1/connections/conn_2"]?.authorization).toBe(
			`Bearer ${OTHER_SECRET_KEY}`,
		);
		expect(byKey["GET /api/v1/connections/conn_2"]?.url).toContain(
			"https://other.dodomain.test/",
		);
	});

	it("skips a domain whose organization has no integration, without calling DoDomain", async () => {
		mocks.integrations = [{ ...integration, organizationId: "org-9" }];
		const result = await syncDoDomainDomain("dom-1");
		expect(result).toEqual({ outcome: "skipped", reason: "no_integration" });
		expect(fetchCalls).toHaveLength(0);
	});

	it("refuses check-now for a domain of another organization", async () => {
		mocks.apps["app-1"] = appFor("org-2");
		await expect(
			reverifyDoDomainDomain({
				integration: integration as never,
				domainId: "dom-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchCalls).toHaveLength(0);
	});
});

describe("the background cycle", () => {
	beforeEach(() => {
		mocks.domains = {
			"dom-1": { ...baseDomain },
			"dom-2": {
				...baseDomain,
				domainId: "dom-2",
				host: "two.customer.com",
				dodomainSessionId: "ses_2",
				dodomainConnectionId: "conn_2",
			},
		};
		mocks.candidates = [{ domainId: "dom-1" }, { domainId: "dom-2" }];
	});

	it("keeps going after one domain fails and logs only ids and error classes", async () => {
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			status: 400,
			body: { error: "boom", message: `internal ${TOKEN} ${SECRET_KEY}` },
		});
		routes["GET /api/v1/connections/conn_2"] = () => ({
			body: connection({ id: "conn_2", status: "broken" }),
		});
		mocks.domains["dom-2"] = {
			...(mocks.domains["dom-2"] as Row),
			dnsVerificationStatus: "verified",
		};

		const summary = await runDoDomainSyncCycle("fast");

		expect(summary).toMatchObject({ failed: 1, changed: 1 });
		expect(mocks.domains["dom-2"]?.dnsVerificationStatus).toBe("failed");
		const output = logged.join("\n");
		expect(output).toContain("dom-1");
		expect(output).toContain("DoDomainError (HTTP 400)");
		expect(output).not.toContain(TOKEN);
		expect(output).not.toContain(SECRET_KEY);
		expect(output).not.toContain("internal");
	});

	it("stops asking an organization that is rate limited but still finishes the cycle", async () => {
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			status: 429,
			body: { error: "rate_limited" },
		});
		const summary = await runDoDomainSyncCycle("fast");
		expect(summary.rateLimited).toBe(1);
		expect(summary.skipped).toBe(1);
		expect(summary.failed).toBe(0);
		expect(calledKeys()).toEqual(["GET /api/v1/sessions/ses_1"]);
	});

	it("does nothing when no organization has DoDomain", async () => {
		mocks.integrations = [];
		const summary = await runDoDomainSyncCycle("slow");
		expect(summary.checked).toBe(0);
		// Only the integration probe ran: no candidate query, no DoDomain call.
		expect(mocks.selects.map((q) => q.sql)).toEqual([
			expect.stringContaining('from "dodomain_integration"'),
		]);
		expect(fetchCalls).toHaveLength(0);
	});

	it("selects pending domains every ~2 minutes and connected ones every ~30", async () => {
		await findDoDomainSyncCandidates("fast");
		await findDoDomainSyncCandidates("slow");
		const [fast, slow] = mocks.selects.map((s) => s.sql.toLowerCase());
		expect(fast).toContain('"dnsverificationstatus" = $1');
		expect(mocks.selects[0]?.params).toEqual(
			expect.arrayContaining(["pending", "failed"]),
		);
		expect(fast).toContain("exists");
		expect(slow).toContain("in ($1, $2)");
		expect(mocks.selects[1]?.params).toEqual(["verified", "failed"]);
		expect(slow).toContain('"dodomainconnectionid" is not null');
	});
});

describe("check now", () => {
	it("syncs immediately and returns the fresh status instead of waiting for a webhook", async () => {
		mocks.domains["dom-1"] = {
			...baseDomain,
			dnsVerificationStatus: "verified",
			dodomainConnectionId: "conn_1",
		};
		routes["POST /api/v1/connections/conn_1/reverify"] = () => ({
			body: { accepted: true },
		});
		routes["GET /api/v1/connections/conn_1"] = () => ({
			body: connection({ status: "broken" }),
		});

		const result = await reverifyDoDomainDomain({
			integration: integration as never,
			domainId: "dom-1",
		});

		expect(result).toMatchObject({
			status: "failed",
			recheck: "requested",
			sync: "failed",
			message: null,
		});
		expect(mocks.notify).toHaveBeenCalledTimes(1);
	});

	it("maps a recheck 429 to the friendly message and still returns the current status", async () => {
		mocks.domains["dom-1"] = {
			...baseDomain,
			dnsVerificationStatus: "verified",
			dodomainConnectionId: "conn_1",
		};
		routes["POST /api/v1/connections/conn_1/reverify"] = () => ({
			status: 429,
			body: { error: "rate_limited", details: { retryAfterSeconds: 300 } },
		});
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });

		const result = await reverifyDoDomainDomain({
			integration: integration as never,
			domainId: "dom-1",
		});

		expect(result).toMatchObject({
			status: "verified",
			recheck: "rate_limited",
			message:
				"DoDomain checked this domain less than 10 minutes ago. Try again later.",
		});
	});

	it("also works for a pending domain that has no connection yet", async () => {
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			body: sessionState({ status: "verified", connectionId: "conn_1" }),
		});
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });
		const result = await reverifyDoDomainDomain({
			integration: integration as never,
			domainId: "dom-1",
		});
		expect(result).toMatchObject({ status: "verified", recheck: "not_needed" });
		expect(calledKeys()).not.toContain(
			"POST /api/v1/connections/conn_1/reverify",
		);
	});

	it("needs a connect link first when the domain never had a session", async () => {
		mocks.domains["dom-1"] = {
			...baseDomain,
			dnsVerificationStatus: null,
			dodomainSessionId: null,
		};
		await expect(
			reverifyDoDomainDomain({
				integration: integration as never,
				domainId: "dom-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("a disconnected connection", () => {
	const failedWithConnection = (connectionId = "conn_1") => ({
		...baseDomain,
		dnsVerificationStatus: "failed",
		dodomainConnectionId: connectionId,
	});

	it("is forgotten by the poller even when the domain already failed", async () => {
		mocks.domains["dom-1"] = failedWithConnection();
		routes["GET /api/v1/connections/conn_1"] = () => ({
			body: connection({ disconnectedAt: "2026-10-11T11:00:00.000Z" }),
		});

		await syncDoDomainDomain("dom-1");

		expect(domainRow()).toMatchObject({
			dnsVerificationStatus: "failed",
			dodomainConnectionId: null,
		});
		// It was already failed: the user was told then.
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("only drops the connection that was disconnected, never a newer one", async () => {
		mocks.domains["dom-1"] = failedWithConnection("conn_new");
		await deliver("connection.disconnected", {
			sessionId: "ses_1",
			connectionId: "conn_old",
		});
		expect(domainRow().dodomainConnectionId).toBe("conn_new");
	});

	it("check now goes straight to the sync and never asks DoDomain to recheck it", async () => {
		mocks.domains["dom-1"] = {
			...baseDomain,
			dnsVerificationStatus: "verified",
			dodomainConnectionId: "conn_1",
		};
		routes["POST /api/v1/connections/conn_1/reverify"] = () => ({
			status: 400,
			body: { error: "invalid_request", message: "connection disconnected" },
		});
		routes["GET /api/v1/connections/conn_1"] = () => ({
			body: connection({ disconnectedAt: "2026-10-11T11:00:00.000Z" }),
		});

		const result = await reverifyDoDomainDomain({
			integration: integration as never,
			domainId: "dom-1",
		});

		expect(result).toMatchObject({
			status: "failed",
			connectionId: null,
			recheck: "not_needed",
		});
		expect(calledKeys()).not.toContain(
			"POST /api/v1/connections/conn_1/reverify",
		);
		expect(mocks.notify).toHaveBeenCalledTimes(1);
	});

	it("a failure webhook with a newer connection id updates a domain that already failed", async () => {
		mocks.domains["dom-1"] = failedWithConnection("conn_old");
		const result = await deliver("connection.failed", {
			domain: "app.customer.com",
			sessionId: "ses_1",
			connectionId: "conn_new",
			fqdn: "app.customer.com",
			reason: "dns_drift",
			scope: "connection",
		});
		expect(result.status).toBe(200);
		expect(domainRow().dodomainConnectionId).toBe("conn_new");
		expect(mocks.notify).not.toHaveBeenCalled();
	});
});

describe("an unhealthy DoDomain instance", () => {
	beforeEach(() => {
		mocks.integrations = [
			integration,
			{
				...integration,
				dodomainId: "dd-2",
				organizationId: "org-2",
				secretKey: OTHER_SECRET_KEY,
				appId: "app_2",
				baseUrl: "https://other.dodomain.test",
			},
		];
		mocks.apps["app-2"] = appFor("org-2", "app-2");
		const verifiedWith = (
			domainId: string,
			connectionId: string,
			app: string,
		) => ({
			...baseDomain,
			domainId,
			applicationId: app,
			dnsVerificationStatus: "verified",
			dodomainConnectionId: connectionId,
		});
		mocks.domains = {
			"dom-1": verifiedWith("dom-1", "conn_1", "app-1"),
			"dom-3": verifiedWith("dom-3", "conn_3", "app-1"),
			"dom-2": verifiedWith("dom-2", "conn_2", "app-2"),
		};
		mocks.candidates = [
			{ domainId: "dom-1" },
			{ domainId: "dom-3" },
			{ domainId: "dom-2" },
		];
		routes["GET /api/v1/connections/conn_3"] = () => ({
			body: connection({ id: "conn_3" }),
		});
		routes["GET /api/v1/connections/conn_2"] = () => ({
			body: connection({ id: "conn_2", status: "broken" }),
		});
	});

	it("skips the rest of an organization after a 5xx, without stalling the others", async () => {
		routes["GET /api/v1/connections/conn_1"] = () => ({
			status: 503,
			body: { error: "unavailable" },
		});

		const summary = await runDoDomainSyncCycle("slow");

		expect(summary).toMatchObject({ failed: 1, skipped: 1, changed: 1 });
		expect(calledKeys()).toEqual([
			"GET /api/v1/connections/conn_1",
			"GET /api/v1/connections/conn_2",
		]);
		expect(mocks.domains["dom-2"]?.dnsVerificationStatus).toBe("failed");
	});

	it("does the same after a network failure, and tries again once the pause is over", async () => {
		let now = 5_000_000;
		routes["GET /api/v1/connections/conn_1"] = () => ({
			body: null,
			networkError: true,
		});

		const first = await runDoDomainSyncCycle("slow", { now: () => now });
		expect(first).toMatchObject({ failed: 1, skipped: 1 });
		expect(logged.join("\n")).toContain("DoDomainError (HTTP 0)");

		fetchCalls = [];
		const second = await runDoDomainSyncCycle("slow", {
			now: () => now + 120_000,
		});
		expect(second.failed).toBe(0);
		expect(second.skipped).toBe(2);
		expect(calledKeys().filter((key) => key.includes("conn_1"))).toHaveLength(
			0,
		);

		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });
		now += 6 * 60_000;
		fetchCalls = [];
		await runDoDomainSyncCycle("slow", { now: () => now });
		expect(calledKeys()).toContain("GET /api/v1/connections/conn_1");
		expect(calledKeys()).toContain("GET /api/v1/connections/conn_3");
	});

	it("a manual check is not held back by the pause the cron took", async () => {
		routes["GET /api/v1/connections/conn_1"] = () => ({
			status: 502,
			body: { error: "bad_gateway" },
		});
		await runDoDomainSyncCycle("slow");
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });
		const manual = await syncDoDomainDomain("dom-1");
		expect(manual.outcome).toBe("unchanged");
	});
});

describe("a failure that keeps repeating", () => {
	const reports: unknown[] = [];

	beforeEach(() => {
		reports.length = 0;
		setBackgroundErrorReporter((error) => reports.push(error));
		mocks.candidates = [{ domainId: "dom-1" }];
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			body: sessionState({ status: "verified", connectionId: "conn_1" }),
		});
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });
	});

	afterEach(() => {
		setBackgroundErrorReporter(undefined);
	});

	it("is reported once per domain until it succeeds, and the status is rolled back each time", async () => {
		mocks.manageDomain
			.mockRejectedValueOnce(new Error("traefik down"))
			.mockRejectedValueOnce(new Error("traefik down"))
			.mockRejectedValueOnce(new Error("traefik down"));
		for (let i = 0; i < 3; i++) {
			const summary = await runDoDomainSyncCycle("fast");
			expect(summary.failed).toBe(1);
			expect(domainRow().dnsVerificationStatus).toBe("pending");
		}
		expect(reports).toHaveLength(1);

		// It recovers: the next failure is news again.
		const ok = await runDoDomainSyncCycle("fast");
		expect(ok.changed).toBe(1);
		expect(domainRow().dnsVerificationStatus).toBe("verified");
		mocks.domains["dom-1"] = { ...baseDomain };
		mocks.manageDomain.mockRejectedValueOnce(new Error("traefik down again"));
		await runDoDomainSyncCycle("fast");
		expect(reports).toHaveLength(2);
	});
});

describe("choosing the token to verify with", () => {
	const verifyRoute = () => ({
		body: { verified: false, records: [], advisories: [] },
	});

	it("does not trust a stored value that is not token-shaped (a failed decryption)", async () => {
		mocks.session = liveSession({ token: "enc:v1:bm90LWEtdG9rZW4=" });
		routes["GET /api/v1/sessions/ses_1"] = () => ({ body: sessionState() });
		routes[`POST /api/v1/sessions/${TOKEN}/verify`] = verifyRoute;
		await syncDoDomainDomain("dom-1");
		expect(calledKeys()).toContain(`POST /api/v1/sessions/${TOKEN}/verify`);
		expect(calledKeys().some((key) => key.includes("enc:v1"))).toBe(false);
	});

	it("uses the connection list when neither the column nor the link has a token", async () => {
		mocks.session = liveSession({
			token: "enc:v1:bm90LWEtdG9rZW4=",
			connectUrl: LEGACY_CONNECT_URL,
		});
		routes["GET /api/v1/sessions/ses_1"] = () => ({ body: sessionState() });
		routes["GET /api/v1/connections"] = () => ({
			body: { connections: [connection()], nextCursor: null },
		});
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });
		const result = await syncDoDomainDomain("dom-1");
		expect(result.outcome).toBe("verified");
		expect(calledKeys().some((key) => key.endsWith("/verify"))).toBe(false);
	});

	it("falls back to the connection list when DoDomain does not know the token (404)", async () => {
		routes["GET /api/v1/sessions/ses_1"] = () => ({ body: sessionState() });
		// No verify route: the fetch stub answers 404.
		routes["GET /api/v1/connections"] = () => ({
			body: { connections: [connection()], nextCursor: null },
		});
		routes["GET /api/v1/connections/conn_1"] = () => ({ body: connection() });
		const result = await syncDoDomainDomain("dom-1");
		expect(calledKeys()).toContain(`POST /api/v1/sessions/${TOKEN}/verify`);
		expect(calledKeys()).toContain("GET /api/v1/connections");
		expect(result.outcome).toBe("verified");
	});
});

describe("the session token stays secret", () => {
	const sessionResponse = {
		id: "ses_new",
		token: TOKEN,
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		connectUrl: connectUrlFor(TOKEN),
		records: [{ type: "A", host: "@", fqdn: "app.customer.com" }],
	};

	beforeEach(() => {
		routes["POST /api/v1/domains/check"] = () => ({
			body: { zone: "customer.com" },
		});
		routes["POST /api/v1/sessions"] = () => ({ body: sessionResponse });
	});

	it("stores the token with the session and keeps it out of what the API returns", async () => {
		const created = await createDoDomainConnectSession({
			integration: integration as never,
			domainId: "dom-1",
		});

		const stored = mocks.inserts.find(
			(insert) => insert.table === "dodomain_connect_session",
		);
		expect(stored?.row.token).toBe(TOKEN);
		// The link itself embeds the token (it is what the domain owner opens), so
		// that field is the one place it may appear; there is no `token` field.
		expect(JSON.stringify({ ...created, connectUrl: undefined })).not.toContain(
			TOKEN,
		);
		expect(created).not.toHaveProperty("token");
		expect(Object.keys(created).sort()).toEqual([
			"connectUrl",
			"expiresAt",
			"records",
			"sessionId",
			"warnings",
		]);
	});

	it("is not part of the connection status the browser reads", async () => {
		const status = await getDoDomainConnectionStatus({
			integration: integration as never,
			domainId: "dom-1",
		});
		expect(JSON.stringify({ ...status, connectUrl: undefined })).not.toContain(
			TOKEN,
		);
		expect(status).not.toHaveProperty("token");
	});

	it("is not part of the check-now result and never appears in logs", async () => {
		routes["GET /api/v1/sessions/ses_1"] = () => ({ body: sessionState() });
		routes[`POST /api/v1/sessions/${TOKEN}/verify`] = () => ({
			body: { verified: false, records: [], advisories: [] },
		});
		const result = await reverifyDoDomainDomain({
			integration: integration as never,
			domainId: "dom-1",
		});
		expect(JSON.stringify({ ...result, connectUrl: undefined })).not.toContain(
			TOKEN,
		);
		expect(result).not.toHaveProperty("token");
		expect(logged.join("\n")).not.toContain(TOKEN);
	});

	it("is scrubbed from a DoDomain error message that echoes it", async () => {
		routes["GET /api/v1/sessions/ses_1"] = () => ({
			status: 400,
			body: { error: "invalid_request", message: `bad token ${TOKEN}` },
		});
		const error = await syncDoDomainDomain("dom-1").catch((e) => e);
		expect(error.message).not.toContain(TOKEN);
		expect(error.message).toContain("dd_sess_••••");
		const keyError = new DoDomainError(`key ${SECRET_KEY} rejected`, 401);
		expect(keyError.message).not.toContain(SECRET_KEY);
	});

	it("is encrypted by its column", () => {
		const encoded = dodomainConnectSession.token.mapToDriverValue(TOKEN);
		expect(encoded).toMatch(/^enc:v1:/);
		expect(encoded).not.toContain(TOKEN);
		expect(
			dodomainConnectSession.token.mapFromDriverValue(encoded as string),
		).toBe(TOKEN);
	});
});
