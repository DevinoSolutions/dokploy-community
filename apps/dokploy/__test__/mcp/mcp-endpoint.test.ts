import { beforeEach, describe, expect, it, vi } from "vitest";

/** Small ceiling so the oversize cases stay readable. */
const BODY_LIMIT = 64;

let disabled = false;
let origin: string | null = "https://dok.example.com";
let auth: { scopes: Set<string>; session: unknown; user: unknown } | null =
	null;
let throttledFor: number | null = null;
const handledBodies: unknown[] = [];
const authOptions: unknown[] = [];

vi.mock("@dokploy/server", () => ({
	isMcpDisabled: () => disabled,
	resolveMcpOrigin: async () => origin,
	OPENAPI_MAX_JSON_BODY_SIZE: BODY_LIMIT,
}));

vi.mock("@/server/api/root", () => ({ appRouter: {} }));
vi.mock("@/server/api/trpc", () => ({
	createCallerFactory: () => () => ({}),
}));
vi.mock("@/server/mcp/registry", () => ({
	getMcpToolRegistry: async () => [],
}));
vi.mock("@/server/sentry", () => ({ captureError: vi.fn() }));

vi.mock("@/server/mcp/handler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/server/mcp/handler")>();
	return {
		...actual,
		authenticateMcpRequest: vi.fn(
			async (_headers: unknown, options: unknown) => {
				authOptions.push(options);
				if (throttledFor !== null) {
					throw new actual.McpApiKeyRateLimitedError(throttledFor);
				}
				return auth;
			},
		),
		createMcpRequestServer: vi.fn(() => ({
			connect: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		})),
	};
});

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
	StreamableHTTPServerTransport: class {
		async handleRequest(
			_req: unknown,
			res: { end: () => void },
			body: unknown,
		) {
			handledBodies.push(body);
			res.end();
		}
		async close() {}
	},
}));

const handler = (await import("@/pages/api/mcp")).default;

const makeReq = ({
	method = "POST",
	headers = {},
	chunks = [],
}: {
	method?: string;
	headers?: Record<string, string>;
	chunks?: Buffer[];
} = {}) => ({
	method,
	headers,
	async *[Symbol.asyncIterator]() {
		for (const chunk of chunks) yield chunk;
	},
});

const makeRes = () => {
	const recorded = {
		status: undefined as number | undefined,
		headers: {} as Record<string, string>,
		body: undefined as unknown,
		ended: false,
	};
	const res = {
		headersSent: false,
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
			res.headersSent = true;
			return res;
		},
		end() {
			recorded.ended = true;
			res.headersSent = true;
			return res;
		},
		on() {
			return res;
		},
	};
	return { res, recorded };
};

// biome-ignore lint/suspicious/noExplicitAny: the fakes stand in for Next's req/res.
const run = (req: unknown, res: unknown) => handler(req as any, res as any);

const jsonHeaders = (extra: Record<string, string> = {}) => ({
	"content-type": "application/json",
	authorization: "Bearer tok",
	...extra,
});

describe("POST /api/mcp", () => {
	beforeEach(() => {
		disabled = false;
		origin = "https://dok.example.com";
		auth = {
			scopes: new Set(["dokploy:read"]),
			session: { userId: "user-1" },
			user: { id: "user-1" },
		};
		throttledFor = null;
		handledBodies.length = 0;
		authOptions.length = 0;
	});

	it("answers 503 when the instance disabled MCP", async () => {
		disabled = true;
		const { res, recorded } = makeRes();
		await run(makeReq(), res);
		expect(recorded.status).toBe(503);
		expect(recorded.body).toMatchObject({ error: "mcp_disabled" });
	});

	it("answers 503 when no public origin is configured", async () => {
		origin = null;
		const { res, recorded } = makeRes();
		await run(makeReq(), res);
		expect(recorded.status).toBe(503);
		expect(recorded.body).toMatchObject({ error: "mcp_unconfigured" });
	});

	it("rejects a non-POST method with 405 and an Allow header", async () => {
		const { res, recorded } = makeRes();
		await run(makeReq({ method: "GET" }), res);
		expect(recorded.status).toBe(405);
		expect(recorded.headers.Allow).toBe("POST");
		expect(recorded.body).toMatchObject({
			jsonrpc: "2.0",
			error: { code: -32000 },
		});
	});

	it("rejects an oversize Content-Length before reading the stream", async () => {
		const { res, recorded } = makeRes();
		await run(
			makeReq({
				headers: jsonHeaders({ "content-length": String(BODY_LIMIT + 1) }),
			}),
			res,
		);
		expect(recorded.status).toBe(413);
		expect(recorded.body).toMatchObject({
			error: { message: "Payload too large" },
		});
	});

	it("rejects an oversize stream even when Content-Length lies", async () => {
		const { res, recorded } = makeRes();
		await run(
			makeReq({
				headers: jsonHeaders({ "content-length": "2" }),
				chunks: [Buffer.alloc(BODY_LIMIT + 1, 0x61)],
			}),
			res,
		);
		expect(recorded.status).toBe(413);
		expect(recorded.body).toMatchObject({
			error: { message: "Payload too large" },
		});
		expect(handledBodies).toHaveLength(0);
	});

	it("rejects a non-JSON content type with 415", async () => {
		const { res, recorded } = makeRes();
		await run(
			makeReq({
				headers: { "content-type": "text/plain", authorization: "Bearer tok" },
				chunks: [Buffer.from("{}")],
			}),
			res,
		);
		expect(recorded.status).toBe(415);
		expect(handledBodies).toHaveLength(0);
	});

	it("answers 400 with a parse error code on malformed JSON", async () => {
		const { res, recorded } = makeRes();
		await run(
			makeReq({ headers: jsonHeaders(), chunks: [Buffer.from("{not json")] }),
			res,
		);
		expect(recorded.status).toBe(400);
		expect(recorded.body).toMatchObject({ error: { code: -32700 } });
	});

	it("answers 401 with the protected-resource WWW-Authenticate header", async () => {
		auth = null;
		const { res, recorded } = makeRes();
		await run(makeReq({ headers: jsonHeaders() }), res);
		expect(recorded.status).toBe(401);
		expect(recorded.headers["WWW-Authenticate"]).toBe(
			'Bearer resource_metadata="https://dok.example.com/.well-known/oauth-protected-resource"',
		);
		expect(recorded.body).toMatchObject({
			error: { message: "Unauthorized: Authentication required" },
		});
		expect(handledBodies).toHaveLength(0);
	});

	it("answers 429 with Retry-After, not 401, when the api key is throttled", async () => {
		throttledFor = 17;
		const { res, recorded } = makeRes();
		await run(
			makeReq({
				headers: jsonHeaders(),
				chunks: [
					Buffer.from(
						JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
					),
				],
			}),
			res,
		);
		expect(recorded.status).toBe(429);
		expect(recorded.headers["Retry-After"]).toBe("17");
		expect(recorded.headers["WWW-Authenticate"]).toBeUndefined();
		expect(recorded.body).toMatchObject({
			jsonrpc: "2.0",
			error: { code: -32000 },
		});
		expect(handledBodies).toHaveLength(0);
	});

	it("lets protocol-only requests reuse a recent api-key check", async () => {
		const { res } = makeRes();
		await run(
			makeReq({
				headers: jsonHeaders(),
				chunks: [
					Buffer.from(
						JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
					),
				],
			}),
			res,
		);
		expect(authOptions).toEqual([{ countsAgainstRateLimit: false }]);
	});

	it("makes tool calls and unreadable bodies count against the rate limit", async () => {
		await run(
			makeReq({
				headers: jsonHeaders(),
				chunks: [
					Buffer.from(
						JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call" }),
					),
				],
			}),
			makeRes().res,
		);
		await run(
			makeReq({ headers: jsonHeaders(), chunks: [Buffer.from("{not json")] }),
			makeRes().res,
		);
		expect(authOptions).toEqual([
			{ countsAgainstRateLimit: true },
			{ countsAgainstRateLimit: true },
		]);
	});

	it("still answers 401 before reporting a bad body to an unauthenticated caller", async () => {
		auth = null;
		const { res, recorded } = makeRes();
		await run(
			makeReq({ headers: jsonHeaders(), chunks: [Buffer.from("{not json")] }),
			res,
		);
		expect(recorded.status).toBe(401);
	});

	it("hands the parsed body to the transport on the happy path", async () => {
		const payload = { jsonrpc: "2.0", method: "tools/list", id: 1 };
		const { res, recorded } = makeRes();
		await run(
			makeReq({
				headers: jsonHeaders(),
				chunks: [Buffer.from(JSON.stringify(payload))],
			}),
			res,
		);
		expect(handledBodies).toEqual([payload]);
		expect(recorded.ended).toBe(true);
		expect(recorded.status).toBeUndefined();
	});
});
