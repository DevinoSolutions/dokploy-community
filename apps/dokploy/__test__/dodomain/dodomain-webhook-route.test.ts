import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/webhooks/dodomain` — the only unauthenticated entry point of the
 * integration. The HMAC is the whole authentication, so the route must read
 * the raw bytes itself, refuse anything unsigned or mis-signed with 401
 * before touching the database, and acknowledge duplicates with 200.
 */

const SECRET = "whsec_route_secret";

const mocks = vi.hoisted(() => ({
	integrations: [] as Record<string, unknown>[],
	claimResult: [{ deliveryId: "del_1" }] as unknown[],
	inserts: [] as unknown[],
	updates: [] as unknown[],
	domainFindFirst: vi.fn(async () => undefined as unknown),
}));

vi.mock("@dokploy/server/db", () => {
	const updateChain = () => {
		const self: any = {
			set: vi.fn((values: unknown) => {
				mocks.updates.push(values);
				return self;
			}),
			where: vi.fn(() => self),
			returning: vi.fn(async () => [{}]),
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
						return { findFirst: mocks.domainFindFirst, findMany: vi.fn() };
					}
					return {
						findFirst: vi.fn(async () => undefined),
						findMany: vi.fn(async () => []),
					};
				},
			}),
			insert: vi.fn(() => ({
				values: (row: unknown) => {
					mocks.inserts.push(row);
					return {
						onConflictDoNothing: () => ({
							returning: async () => mocks.claimResult,
						}),
					};
				},
			})),
			update: vi.fn(() => updateChain()),
			delete: vi.fn(() => updateChain()),
			execute: vi.fn(async () => []),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

const { signDoDomainPayload } = await import(
	"@dokploy/server/utils/dodomain/client"
);
const handler = (await import("@/pages/api/webhooks/dodomain")).default;

const makeReq = ({
	method = "POST",
	headers = {},
	body = "",
	query = {},
}: {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	query?: Record<string, string>;
} = {}) => ({
	method,
	headers,
	query,
	async *[Symbol.asyncIterator]() {
		if (body) yield Buffer.from(body);
	},
});

const makeRes = () => {
	const recorded = {
		status: undefined as number | undefined,
		headers: {} as Record<string, string>,
		body: undefined as unknown,
	};
	const res = {
		status(code: number) {
			recorded.status = code;
			return res;
		},
		setHeader(key: string, value: string) {
			recorded.headers[key] = value;
			return res;
		},
		json(payload: unknown) {
			recorded.body = payload;
			return res;
		},
		end() {
			return res;
		},
	};
	return { res, recorded };
};

const run = (req: unknown, res: unknown) => handler(req as any, res as any);

const event = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		id: "del_1",
		type: "connection.verified",
		occurredAt: new Date().toISOString(),
		data: {
			domain: "app.customer.com",
			sessionId: "ses_unknown",
			connectionId: "conn_1",
		},
		event: "connection.verified",
		...overrides,
	});

describe("POST /api/webhooks/dodomain", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.integrations = [
			{
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
			},
		];
		mocks.claimResult = [{ deliveryId: "del_1" }];
		mocks.inserts = [];
		mocks.updates = [];
	});

	it("disables Next's body parser so the signature covers the raw bytes", async () => {
		const route = await import("@/pages/api/webhooks/dodomain");
		expect(route.config).toEqual({ api: { bodyParser: false } });
	});

	it("rejects a non-POST method with 405", async () => {
		const { res, recorded } = makeRes();
		await run(makeReq({ method: "GET" }), res);
		expect(recorded.status).toBe(405);
		expect(recorded.headers.Allow).toBe("POST");
	});

	it("answers 401 when the signature header is missing", async () => {
		const { res, recorded } = makeRes();
		await run(makeReq({ body: event() }), res);
		expect(recorded.status).toBe(401);
		expect(recorded.body).toMatchObject({ error: "invalid_signature" });
		expect(mocks.inserts).toHaveLength(0);
		expect(mocks.updates).toHaveLength(0);
	});

	it("answers 401 on a bad signature and never writes", async () => {
		const body = event();
		const { res, recorded } = makeRes();
		await run(
			makeReq({
				body,
				headers: {
					"x-dodomain-signature": signDoDomainPayload("whsec_wrong", body),
				},
			}),
			res,
		);
		expect(recorded.status).toBe(401);
		expect(mocks.inserts).toHaveLength(0);
		expect(mocks.updates).toHaveLength(0);
		expect(mocks.domainFindFirst).not.toHaveBeenCalled();
	});

	it("answers 401 when the signed body was altered", async () => {
		const signedBody = event();
		const { res, recorded } = makeRes();
		await run(
			makeReq({
				body: signedBody.replace("app.customer.com", "evil.example.com"),
				headers: {
					"x-dodomain-signature": signDoDomainPayload(SECRET, signedBody),
				},
			}),
			res,
		);
		expect(recorded.status).toBe(401);
		expect(mocks.inserts).toHaveLength(0);
	});

	it("answers 401 when no integration has a signing secret", async () => {
		mocks.integrations = [];
		const body = event();
		const { res, recorded } = makeRes();
		await run(
			makeReq({
				body,
				headers: { "x-dodomain-signature": signDoDomainPayload(SECRET, body) },
			}),
			res,
		);
		expect(recorded.status).toBe(401);
	});

	it("acknowledges a correctly signed delivery with 200", async () => {
		const body = event();
		const { res, recorded } = makeRes();
		await run(
			makeReq({
				body,
				headers: { "x-dodomain-signature": signDoDomainPayload(SECRET, body) },
			}),
			res,
		);
		expect(recorded.status).toBe(200);
		expect(recorded.body).toMatchObject({ received: true });
		expect(mocks.inserts).toEqual([{ deliveryId: "del_1" }]);
	});

	it("answers 200 duplicate for a delivery id already applied", async () => {
		mocks.claimResult = [];
		const body = event();
		const { res, recorded } = makeRes();
		await run(
			makeReq({
				body,
				headers: { "x-dodomain-signature": signDoDomainPayload(SECRET, body) },
			}),
			res,
		);
		expect(recorded.status).toBe(200);
		expect(recorded.body).toMatchObject({ received: true, duplicate: true });
		expect(mocks.domainFindFirst).not.toHaveBeenCalled();
	});

	it("answers 400 on a signed body that is not a DoDomain event", async () => {
		const body = JSON.stringify({ hello: "world" });
		const { res, recorded } = makeRes();
		await run(
			makeReq({
				body,
				headers: { "x-dodomain-signature": signDoDomainPayload(SECRET, body) },
			}),
			res,
		);
		expect(recorded.status).toBe(400);
		expect(mocks.inserts).toHaveLength(0);
	});

	it("answers 413 on an oversize body without verifying it", async () => {
		const body = "x".repeat(300 * 1024);
		const { res, recorded } = makeRes();
		await run(
			makeReq({
				body,
				headers: { "x-dodomain-signature": signDoDomainPayload(SECRET, body) },
			}),
			res,
		);
		expect(recorded.status).toBe(413);
	});
});
