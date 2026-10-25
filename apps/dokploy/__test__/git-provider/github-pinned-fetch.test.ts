import { EventEmitter } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import {
	createPinnedGithubFetch,
	GITHUB_DNS_TIMEOUT_MS,
	GITHUB_REDIRECT_REFUSED,
	GITHUB_REQUEST_TIMEOUT_MS,
	parseAllowedGithubHosts,
} from "@dokploy/server/utils/providers/github-host";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// Every call the server makes to the host a GitHub provider stored goes
// through one fetch that checks the host and its addresses when it connects,
// connects to the addresses it checked, and follows no redirect. DNS and the
// transport are injected; a local http server stands in for the instance (the
// allowlisted host name resolves to 127.0.0.1), so nothing leaves the machine.

const resolveTo = (...addresses: string[]) =>
	vi.fn(async (_hostname: string) =>
		addresses.map((address) => ({
			address,
			family: address.includes(":") ? 6 : 4,
		})),
	);

const none = new Set<string>();

let server: Server;
let port: number;
let hits: {
	url: string;
	method: string;
	host: string;
	body: string;
	acceptEncoding: string | undefined;
}[];

beforeAll(async () => {
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			hits.push({
				url: req.url ?? "",
				method: req.method ?? "",
				host: req.headers.host ?? "",
				body: Buffer.concat(chunks).toString(),
				acceptEncoding: req.headers["accept-encoding"],
			});
			if (req.url?.startsWith("/hang")) return;
			if (req.url?.startsWith("/redirect")) {
				res.writeHead(302, { location: "http://169.254.169.254/latest" });
				res.end();
				return;
			}
			if (req.url?.startsWith("/empty")) {
				res.writeHead(204);
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
	hits = [];
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

// http.request instead of https.request, so the local server needs no TLS.
const viaHttp = httpRequest as unknown as typeof httpsRequest;

const stored = "https://ghe.test:";

describe("createPinnedGithubFetch", () => {
	it("connects to an allowlisted host, whatever it resolves to, after one lookup", async () => {
		const resolveHost = resolveTo("127.0.0.1");
		const fetchPinned = createPinnedGithubFetch({
			allowedHosts: parseAllowedGithubHosts("ghe.test"),
			resolveHost,
			request: viaHttp,
		});

		const response = await fetchPinned(`${stored}${port}/api/v3/repos?page=2`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ a: 1 }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(resolveHost).toHaveBeenCalledTimes(1);
		expect(resolveHost).toHaveBeenCalledWith("ghe.test");
		expect(hits).toEqual([
			{
				url: "/api/v3/repos?page=2",
				method: "POST",
				host: `ghe.test:${port}`,
				body: '{"a":1}',
				acceptEncoding: "identity",
			},
		]);
	});

	it("asks for an uncompressed answer, whatever the caller asked for", async () => {
		const fetchPinned = createPinnedGithubFetch({
			allowedHosts: parseAllowedGithubHosts("ghe.test"),
			resolveHost: resolveTo("127.0.0.1"),
			request: viaHttp,
		});
		await fetchPinned(`${stored}${port}/x`);
		await fetchPinned(`${stored}${port}/x`, {
			headers: { "Accept-Encoding": "gzip, br" },
		});
		expect(hits.map((hit) => hit.acceptEncoding)).toEqual([
			"identity",
			"identity",
		]);
	});

	it("reads an answer without a body", async () => {
		const fetchPinned = createPinnedGithubFetch({
			allowedHosts: parseAllowedGithubHosts("ghe.test"),
			resolveHost: resolveTo("127.0.0.1"),
			request: viaHttp,
		});
		const response = await fetchPinned(`${stored}${port}/empty`);
		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
	});

	it.each([
		["loopback", "127.0.0.1"],
		["private 10/8", "10.1.2.3"],
		["private 192.168/16", "192.168.1.1"],
		["metadata", "169.254.169.254"],
		["CGNAT", "100.100.100.100"],
		["unique-local", "fd00::5"],
		["mapped v4", "::ffff:10.0.0.1"],
	])(
		"refuses a stored host that resolves to %s, and connects to nothing",
		async (_label, address) => {
			const warn = quiet();
			const fetchPinned = createPinnedGithubFetch({
				allowedHosts: none,
				resolveHost: resolveTo(address),
				request: viaHttp,
			});

			const response = await fetchPinned(`${stored}${port}/api/v3/repos`);

			expect(response.status).toBe(400);
			const { message } = (await response.json()) as { message: string };
			expect(message).toContain("ghe.test");
			expect(message).toContain("does not resolve to a public address");
			expect(message).not.toContain(address);
			expect(hits).toHaveLength(0);
			expect(warn.mock.calls.join("\n")).not.toContain(address);
		},
	);

	it("refuses one private address among public ones", async () => {
		quiet();
		const fetchPinned = createPinnedGithubFetch({
			allowedHosts: none,
			resolveHost: resolveTo("140.82.112.3", "10.0.0.1"),
			request: viaHttp,
		});
		const response = await fetchPinned(`${stored}${port}/x`);
		expect(response.status).toBe(400);
		expect(hits).toHaveLength(0);
	});

	it("gives one answer for a name that does not resolve and one that is private", async () => {
		quiet();
		const messages: string[] = [];
		for (const resolveHost of [
			vi.fn(async () => {
				throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
					code: "ENOTFOUND",
				});
			}),
			resolveTo(),
			resolveTo("10.20.30.40"),
		]) {
			const response = await createPinnedGithubFetch({
				allowedHosts: none,
				resolveHost,
				request: viaHttp,
			})(`${stored}${port}/x`);
			expect(response.status).toBe(400);
			messages.push(((await response.json()) as { message: string }).message);
		}
		expect(new Set(messages).size).toBe(1);
		expect(hits).toHaveLength(0);
	});

	it("does not wait for a resolver that never answers", async () => {
		quiet();
		const started = Date.now();
		const response = await createPinnedGithubFetch({
			allowedHosts: none,
			resolveHost: () => new Promise(() => {}),
			dnsTimeoutMs: 30,
			request: viaHttp,
		})(`${stored}${port}/x`);
		expect(response.status).toBe(400);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(GITHUB_DNS_TIMEOUT_MS).toBe(5_000);
	});

	it("refuses an IP literal and an internal name without a lookup or a connection", async () => {
		quiet();
		const resolveHost = resolveTo("140.82.112.3");
		const request = vi.fn() as unknown as typeof httpsRequest;
		const fetchPinned = createPinnedGithubFetch({
			allowedHosts: none,
			resolveHost,
			request,
		});
		for (const url of [
			"https://10.0.0.5/api/v3/x",
			"https://[::1]/api/v3/x",
			"https://ghe.local/api/v3/x",
			"https://ghe.internal/api/v3/x",
		]) {
			expect((await fetchPinned(url)).status).toBe(400);
		}
		expect(resolveHost).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it("refuses a plain http URL", async () => {
		const request = vi.fn() as unknown as typeof httpsRequest;
		const response = await createPinnedGithubFetch({
			allowedHosts: parseAllowedGithubHosts("ghe.test"),
			request,
		})("http://ghe.test/api/v3/x");
		expect(response.status).toBe(400);
		expect(request).not.toHaveBeenCalled();
	});

	it.each(["/redirect", "/redirect/a"])(
		"does not follow a redirect (%s)",
		async (path) => {
			const response = await createPinnedGithubFetch({
				allowedHosts: parseAllowedGithubHosts("ghe.test"),
				resolveHost: resolveTo("127.0.0.1"),
				request: viaHttp,
			})(`${stored}${port}${path}`);

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				message: GITHUB_REDIRECT_REFUSED,
			});
			expect(hits).toHaveLength(1);
		},
	);

	it("leaves github.com to the global fetch", async () => {
		const globalFetch = vi.fn(
			async (..._args: unknown[]) => new Response("{}", { status: 200 }),
		);
		vi.stubGlobal("fetch", globalFetch);
		const resolveHost = resolveTo("10.0.0.1");
		const request = vi.fn() as unknown as typeof httpsRequest;
		const fetchPinned = createPinnedGithubFetch({
			allowedHosts: none,
			resolveHost,
			request,
		});

		for (const url of [
			"https://api.github.com/repos/a/b",
			"https://github.com/a/b",
		]) {
			expect((await fetchPinned(url)).status).toBe(200);
		}

		expect(globalFetch).toHaveBeenCalledTimes(2);
		expect(resolveHost).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it("stops when the caller aborts", async () => {
		const controller = new AbortController();
		const pending = createPinnedGithubFetch({
			allowedHosts: parseAllowedGithubHosts("ghe.test"),
			resolveHost: resolveTo("127.0.0.1"),
			request: viaHttp,
		})(`${stored}${port}/hang`, { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		await expect(pending).rejects.toBeDefined();
	});

	it("bounds each request to 15 seconds", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		let received: AbortSignal | undefined;
		const request = vi.fn((options: { signal?: AbortSignal }) => {
			received = options.signal;
			const outgoing = new EventEmitter() as EventEmitter & {
				end: () => void;
			};
			outgoing.end = () => {};
			return outgoing;
		}) as unknown as typeof httpsRequest;

		void createPinnedGithubFetch({
			allowedHosts: parseAllowedGithubHosts("ghe.test"),
			resolveHost: resolveTo("127.0.0.1"),
			request,
		})("https://ghe.test/api/v3/x");
		await vi.waitFor(() => expect(received).toBeInstanceOf(AbortSignal));

		expect(timeout).toHaveBeenCalledWith(GITHUB_REQUEST_TIMEOUT_MS);
		expect(GITHUB_REQUEST_TIMEOUT_MS).toBe(15_000);
		expect(received?.aborted).toBe(false);
	});
});

describe("the connection is pinned to the checked address", () => {
	// A transport that does what net.connect does with a `lookup` option: call
	// it once for the connection and connect to what it answers.
	const connectingTransport = () => {
		const connectedTo: string[] = [];
		const lookupAnswers: unknown[] = [];
		const request = vi.fn(
			(
				options: {
					hostname: string;
					lookup: (
						name: string,
						options: { all?: boolean },
						callback: (...args: unknown[]) => void,
					) => void;
				},
				callback: (response: unknown) => void,
			) => {
				const outgoing = new EventEmitter() as EventEmitter & {
					end: () => void;
				};
				outgoing.end = () => {
					options.lookup(options.hostname, { all: true }, (error, answer) => {
						if (error) {
							outgoing.emit("error", error);
							return;
						}
						lookupAnswers.push(answer);
						const [first] = answer as { address: string }[];
						connectedTo.push(first?.address ?? "");
						callback(
							Object.assign(Readable.from(["{}"]), {
								statusCode: 200,
								statusMessage: "OK",
								rawHeaders: ["content-type", "application/json"],
							}),
						);
					});
				};
				return outgoing;
			},
		) as unknown as typeof httpsRequest;
		return { request, connectedTo, lookupAnswers };
	};

	it("connects to the address it checked, with no second lookup", async () => {
		const { request, connectedTo, lookupAnswers } = connectingTransport();
		// The name answers a public address now and a private one afterwards.
		const resolveHost = vi
			.fn()
			.mockResolvedValueOnce([{ address: "140.82.112.3", family: 4 }])
			.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
		const fetchPinned = createPinnedGithubFetch({
			allowedHosts: none,
			resolveHost,
			request,
		});

		const response = await fetchPinned("https://ghe.corp.acme.com/api/v3/x");

		expect(response.status).toBe(200);
		expect(connectedTo).toEqual(["140.82.112.3"]);
		expect(lookupAnswers).toEqual([[{ address: "140.82.112.3", family: 4 }]]);
		expect(resolveHost).toHaveBeenCalledTimes(1);
	});

	it("checks the name again for the next connection", async () => {
		quiet();
		const { request, connectedTo } = connectingTransport();
		const resolveHost = vi
			.fn()
			.mockResolvedValueOnce([{ address: "140.82.112.3", family: 4 }])
			.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
		const fetchPinned = createPinnedGithubFetch({
			allowedHosts: none,
			resolveHost,
			request,
		});

		expect((await fetchPinned("https://ghe.corp.acme.com/a")).status).toBe(200);
		// The name now points at an internal address: refused, not connected.
		expect((await fetchPinned("https://ghe.corp.acme.com/b")).status).toBe(400);
		expect(connectedTo).toEqual(["140.82.112.3"]);
		expect(resolveHost).toHaveBeenCalledTimes(2);
	});

	it("answers a single address when the connection asks for one", async () => {
		const answers: unknown[][] = [];
		const request = vi.fn(
			(
				options: {
					hostname: string;
					lookup: (
						name: string,
						options: { family?: number },
						callback: (...args: unknown[]) => void,
					) => void;
				},
				callback: (response: unknown) => void,
			) => {
				const outgoing = new EventEmitter() as EventEmitter & {
					end: () => void;
				};
				outgoing.end = () => {
					options.lookup(options.hostname, { family: 6 }, (...args) => {
						answers.push(args);
						callback(
							Object.assign(Readable.from(["{}"]), {
								statusCode: 200,
								rawHeaders: [],
							}),
						);
					});
				};
				return outgoing;
			},
		) as unknown as typeof httpsRequest;

		await createPinnedGithubFetch({
			allowedHosts: none,
			resolveHost: resolveTo("140.82.112.3", "2606:4700::1"),
			request,
		})("https://ghe.corp.acme.com/x");

		expect(answers).toEqual([[null, "2606:4700::1", 6]]);
	});
});
