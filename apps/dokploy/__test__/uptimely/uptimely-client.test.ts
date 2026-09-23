import {
	createUptimelyClient,
	parseSseMessages,
	UptimelyError,
} from "@dokploy/server/utils/uptimely/client";
import { describe, expect, it, vi } from "vitest";

/**
 * The Uptimely client speaks MCP Streamable HTTP by hand: `initialize` then
 * `tools/call`, with either a plain JSON or an SSE-framed body.
 */

type Handler = (body: {
	id: number;
	method: string;
	params?: { name?: string; arguments?: Record<string, unknown> };
}) => { status?: number; contentType?: string; body: string };

const fakeFetch = (handler: Handler) =>
	vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		const out = handler(body);
		return new Response(out.body, {
			status: out.status ?? 200,
			headers: { "content-type": out.contentType ?? "application/json" },
		});
	});

const initResult = (id: number) =>
	JSON.stringify({
		jsonrpc: "2.0",
		id,
		result: {
			protocolVersion: "2025-03-26",
			capabilities: { tools: {} },
			serverInfo: { name: "uptimely", version: "1" },
		},
	});

const sse = (payload: unknown) =>
	`event: message\ndata: ${JSON.stringify(payload)}\n\n`;

const projectList = {
	projects: [{ id: "p-1", name: "Devino", slug: "devino" }],
	defaultProjectId: "p-1",
};

describe("uptimely client", () => {
	it("initializes, then calls the tool, parsing a plain JSON body", async () => {
		const fetchImpl = fakeFetch((req) => {
			if (req.method === "initialize") return { body: initResult(req.id) };
			return {
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: req.id,
					result: {
						content: [{ type: "text", text: JSON.stringify(projectList) }],
						structuredContent: projectList,
					},
				}),
			};
		});
		const client = createUptimelyClient({
			baseUrl: "https://uptimely.test/",
			apiKey: "key-123",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		const result = await client.callTool("uptimely_project_list");

		expect(result).toEqual(projectList);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toBe("https://uptimely.test/api/mcp");
		const headers = init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer key-123");
		expect(headers.Accept).toContain("text/event-stream");
		const init1 = JSON.parse(String(init?.body));
		expect(init1.method).toBe("initialize");
		expect(init1.params.protocolVersion).toBe("2025-03-26");
		const call = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
		expect(call.method).toBe("tools/call");
		expect(call.params).toEqual({
			name: "uptimely_project_list",
			arguments: {},
		});
	});

	it("parses SSE-framed responses", async () => {
		const fetchImpl = fakeFetch((req) => {
			if (req.method === "initialize") {
				return {
					contentType: "text/event-stream",
					body: sse(JSON.parse(initResult(req.id))),
				};
			}
			return {
				contentType: "text/event-stream",
				body: sse({
					jsonrpc: "2.0",
					id: req.id,
					result: {
						// No structuredContent: the text part carries the JSON.
						content: [{ type: "text", text: JSON.stringify(projectList) }],
					},
				}),
			};
		});
		const client = createUptimelyClient({
			baseUrl: "https://uptimely.test",
			apiKey: "k",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		await expect(client.callTool("uptimely_project_list")).resolves.toEqual(
			projectList,
		);
	});

	it("initializes once for several calls on the same client", async () => {
		const fetchImpl = fakeFetch((req) =>
			req.method === "initialize"
				? { body: initResult(req.id) }
				: {
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: req.id,
							result: { structuredContent: { ok: true } },
						}),
					},
		);
		const client = createUptimelyClient({
			baseUrl: "https://uptimely.test",
			apiKey: "k",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await Promise.all([client.callTool("a"), client.callTool("b")]);
		const methods = fetchImpl.mock.calls.map(
			(c) => JSON.parse(String(c[1]?.body)).method,
		);
		expect(methods.filter((m) => m === "initialize")).toHaveLength(1);
		expect(methods.filter((m) => m === "tools/call")).toHaveLength(2);
	});

	it("surfaces a JSON-RPC error with the server message", async () => {
		const fetchImpl = fakeFetch((req) =>
			req.method === "initialize"
				? { body: initResult(req.id) }
				: {
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: req.id,
							error: { code: -32602, message: "Unknown tool: nope" },
						}),
					},
		);
		const client = createUptimelyClient({
			baseUrl: "https://uptimely.test",
			apiKey: "k",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		const error = (await client
			.callTool("nope")
			.catch((e: unknown) => e)) as UptimelyError;
		expect(error).toBeInstanceOf(UptimelyError);
		expect(error.message).toBe("Unknown tool: nope");
		expect(error.code).toBe(-32602);
	});

	it("surfaces a tool denial (isError) with its code and settings link", async () => {
		const denial = {
			code: "AI_WRITE_OPS_DISABLED",
			message: "AI write operations are disabled for this project.",
			settingsUrl: "https://uptimely.test/dashboard/p/settings/api-keys",
		};
		const fetchImpl = fakeFetch((req) =>
			req.method === "initialize"
				? { body: initResult(req.id) }
				: {
						contentType: "text/event-stream",
						body: sse({
							jsonrpc: "2.0",
							id: req.id,
							result: {
								isError: true,
								content: [{ type: "text", text: JSON.stringify(denial) }],
								structuredContent: denial,
							},
						}),
					},
		);
		const client = createUptimelyClient({
			baseUrl: "https://uptimely.test",
			apiKey: "k",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		const error = (await client
			.callTool("uptimely_monitor_create", {})
			.catch((e: unknown) => e)) as UptimelyError;
		expect(error).toBeInstanceOf(UptimelyError);
		expect(error.message).toBe(denial.message);
		expect(error.code).toBe("AI_WRITE_OPS_DISABLED");
		expect(error.settingsUrl).toBe(denial.settingsUrl);
	});

	it("treats a lone { error } tool output as a failure", async () => {
		const fetchImpl = fakeFetch((req) =>
			req.method === "initialize"
				? { body: initResult(req.id) }
				: {
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: req.id,
							result: {
								structuredContent: {
									error: "Monitor not found or access denied.",
								},
							},
						}),
					},
		);
		const client = createUptimelyClient({
			baseUrl: "https://uptimely.test",
			apiKey: "k",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await expect(client.callTool("uptimely_monitor_get")).rejects.toThrow(
			"Monitor not found or access denied.",
		);
	});

	it("reports a rejected API key on HTTP 401", async () => {
		const fetchImpl = fakeFetch(() => ({ status: 401, body: "" }));
		const client = createUptimelyClient({
			baseUrl: "https://uptimely.test",
			apiKey: "bad",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await expect(client.callTool("uptimely_project_list")).rejects.toThrow(
			/rejected the API key/,
		);
	});

	it("times out instead of hanging", async () => {
		const fetchImpl = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		const client = createUptimelyClient({
			baseUrl: "https://uptimely.test",
			apiKey: "k",
			timeoutMs: 20,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await expect(client.callTool("uptimely_project_list")).rejects.toThrow(
			/did not respond/,
		);
	});

	it("parseSseMessages joins multi-line data and skips non-JSON frames", () => {
		const body = ': keep-alive\n\nevent: message\ndata: {"a":\ndata: 1}\n\n';
		expect(parseSseMessages(body)).toEqual([{ a: 1 }]);
	});
});
