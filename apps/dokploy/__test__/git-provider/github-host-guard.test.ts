import {
	convertGithubManifest,
	verifyGithubInstallation,
} from "@dokploy/server/utils/providers/github";
import {
	assertGithubHostReachable,
	createNoRedirectFetch,
	GITHUB_REQUEST_TIMEOUT_MS,
	GithubHostError,
	isBlockedGithubAddress,
	parseAllowedGithubHosts,
} from "@dokploy/server/utils/providers/github-host";
import { afterEach, describe, expect, it, vi } from "vitest";

// A GitHub Enterprise URL names a host the server POSTs to. The host is
// checked by name when the URL is entered and by address before the request,
// redirects are not followed and the request is bounded in time. Nothing here
// touches the network: DNS and fetch are injected.

const resolveTo =
	(...addresses: string[]) =>
	async () =>
		addresses.map((address) => ({
			address,
			family: address.includes(":") ? 6 : 4,
		}));

const none = new Set<string>();

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isBlockedGithubAddress", () => {
	it.each([
		"127.0.0.1",
		"127.255.255.254",
		"10.0.0.1",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.0.1",
		"169.254.169.254",
		"100.64.0.1",
		"100.127.255.255",
		"0.0.0.0",
		"224.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"fe80::1",
		"fe80::1%eth0",
		"febf::1",
		"fc00::1",
		"fd12:3456::1",
		"ff02::1",
		"::ffff:127.0.0.1",
		"::ffff:10.0.0.1",
		"::ffff:7f00:1",
		"::ffff:a9fe:a9fe",
		"::127.0.0.1",
		"::7f00:1",
		"64:ff9b::7f00:1",
		"64:ff9b::a9fe:a9fe",
		"2002:7f00:1::1",
		"2002:0a00:0001::1",
		"fec0::1",
	])("blocks %s", (address) => {
		expect(isBlockedGithubAddress(address)).toBe(true);
	});

	it.each([
		"140.82.112.3",
		"8.8.8.8",
		"172.15.255.255",
		"172.32.0.1",
		"100.63.255.255",
		"100.128.0.1",
		"169.253.1.1",
		"192.169.0.1",
		"2606:4700:4700::1111",
		"2001:4860:4860::8888",
		"::ffff:8.8.8.8",
		"64:ff9b::808:808",
		"2002:808:808::1",
	])("allows %s", (address) => {
		expect(isBlockedGithubAddress(address)).toBe(false);
	});

	it("blocks what it cannot read", () => {
		expect(isBlockedGithubAddress("not-an-ip")).toBe(true);
		expect(isBlockedGithubAddress("")).toBe(true);
	});
});

describe("assertGithubHostReachable", () => {
	it("does not resolve github.com", async () => {
		const resolveHost = vi.fn();
		await assertGithubHostReachable("https://github.com", {
			allowedHosts: none,
			resolveHost,
		});
		await assertGithubHostReachable("https://www.github.com", {
			allowedHosts: none,
			resolveHost,
		});
		expect(resolveHost).not.toHaveBeenCalled();
	});

	it("accepts a public host name that resolves to public addresses", async () => {
		const resolveHost = vi.fn(resolveTo("140.82.112.3", "2606:4700::1"));
		await expect(
			assertGithubHostReachable("https://github.acme.com:8443", {
				allowedHosts: none,
				resolveHost,
			}),
		).resolves.toBeUndefined();
		expect(resolveHost).toHaveBeenCalledWith("github.acme.com");
	});

	it.each([
		["loopback", ["127.0.0.1"]],
		["private 10/8", ["10.1.2.3"]],
		["private 172.16/12", ["172.20.0.5"]],
		["private 192.168/16", ["192.168.1.1"]],
		["metadata", ["169.254.169.254"]],
		["link-local v6", ["fe80::1"]],
		["CGNAT", ["100.100.100.100"]],
		["unique-local", ["fd00::5"]],
		["unspecified", ["0.0.0.0"]],
		["multicast", ["224.0.0.251"]],
		["mapped v4", ["::ffff:10.0.0.1"]],
		["one private among public ones", ["140.82.112.3", "10.0.0.1"]],
		["no address at all", []],
	])("refuses a name that resolves to %s", async (_label, addresses) => {
		const error = await assertGithubHostReachable(
			"https://github.acme.com",
			{ allowedHosts: none, resolveHost: resolveTo(...addresses) },
		).catch((e) => e);
		expect(error).toBeInstanceOf(GithubHostError);
		// Neutral: the host the user typed, no resolved address.
		expect(error.message).toContain("github.acme.com");
		for (const address of addresses) {
			expect(error.message).not.toContain(address);
		}
	});

	it("refuses a name that does not resolve", async () => {
		await expect(
			assertGithubHostReachable("https://github.acme.com", {
				allowedHosts: none,
				resolveHost: async () => {
					throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
						code: "ENOTFOUND",
					});
				},
			}),
		).rejects.toThrow('Could not resolve "github.acme.com"');
	});

	it("refuses an IP address and an internal name without resolving", async () => {
		const resolveHost = vi.fn(resolveTo("140.82.112.3"));
		for (const url of [
			"https://140.82.112.3",
			"https://10.0.0.1",
			"https://ghe.local",
			"https://ghe.internal",
			"https://app.localhost",
		]) {
			await expect(
				assertGithubHostReachable(url, { allowedHosts: none, resolveHost }),
			).rejects.toBeInstanceOf(GithubHostError);
		}
		expect(resolveHost).not.toHaveBeenCalled();
	});

	it("lets an allowlisted host through, whatever it resolves to", async () => {
		const allowedHosts = parseAllowedGithubHosts("ghe.corp.internal, 10.0.0.5");
		const resolveHost = vi.fn(resolveTo("10.0.0.5"));
		await assertGithubHostReachable("https://ghe.corp.internal:8443", {
			allowedHosts,
			resolveHost,
		});
		await assertGithubHostReachable("https://10.0.0.5", {
			allowedHosts,
			resolveHost,
		});
		// An allowlisted public name that points at a private address too.
		await assertGithubHostReachable("https://ghe.corp.internal", {
			allowedHosts: parseAllowedGithubHosts("ghe.corp.internal"),
			resolveHost: resolveTo("192.168.1.1"),
		});
		expect(resolveHost).not.toHaveBeenCalled();
	});

	it("does not extend the allowlist to other names", async () => {
		await expect(
			assertGithubHostReachable("https://other.corp.internal", {
				allowedHosts: parseAllowedGithubHosts("ghe.corp.internal"),
				resolveHost: resolveTo("10.0.0.5"),
			}),
		).rejects.toBeInstanceOf(GithubHostError);
		await expect(
			assertGithubHostReachable("https://github.acme.com", {
				allowedHosts: parseAllowedGithubHosts("ghe.corp.internal"),
				resolveHost: resolveTo("10.0.0.5"),
			}),
		).rejects.toBeInstanceOf(GithubHostError);
	});
});

describe("createNoRedirectFetch", () => {
	it("asks fetch not to follow redirects", async () => {
		const base = vi.fn(async () => new Response("{}", { status: 200 }));
		await createNoRedirectFetch(base as unknown as typeof fetch)(
			"https://github.acme.com/x",
			{ method: "POST", redirect: "follow" },
		);
		expect(base).toHaveBeenCalledWith(
			"https://github.acme.com/x",
			expect.objectContaining({ method: "POST", redirect: "manual" }),
		);
	});

	it.each([301, 302, 303, 307, 308])("refuses a %i answer", async (status) => {
		const base = vi.fn(
			async () =>
				new Response(null, {
					status,
					headers: { location: "http://169.254.169.254/latest" },
				}),
		);
		await expect(
			createNoRedirectFetch(base as unknown as typeof fetch)(
				"https://github.acme.com/x",
			),
		).rejects.toBeInstanceOf(GithubHostError);
	});

	it("passes other answers through, errors included", async () => {
		for (const status of [200, 201, 404, 422, 500]) {
			const base = vi.fn(async () => new Response("{}", { status }));
			const response = await createNoRedirectFetch(
				base as unknown as typeof fetch,
			)("https://github.acme.com/x");
			expect(response.status).toBe(status);
		}
	});
});

describe("convertGithubManifest", () => {
	const ok = () =>
		new Response(JSON.stringify({ id: 7, html_url: "https://x" }), {
			status: 201,
			headers: { "content-type": "application/json" },
		});

	it("posts the code to the instance API with no redirects and a timeout", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const fetchMock = vi.fn(async (..._args: unknown[]) => ok());

		const data = await convertGithubManifest("https://github.acme.com", "abc", {
			allowedHosts: none,
			resolveHost: resolveTo("140.82.112.3"),
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(data).toMatchObject({ id: 7 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe(
			"https://github.acme.com/api/v3/app-manifests/abc/conversions",
		);
		expect(init.method).toBe("POST");
		expect(init.redirect).toBe("manual");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(timeout).toHaveBeenCalledWith(GITHUB_REQUEST_TIMEOUT_MS);
		expect(GITHUB_REQUEST_TIMEOUT_MS).toBe(15_000);
	});

	it("keeps working for github.com without any configuration", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => ok());
		const resolveHost = vi.fn();

		await convertGithubManifest("https://github.com", "abc", {
			allowedHosts: none,
			resolveHost,
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(resolveHost).not.toHaveBeenCalled();
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://api.github.com/app-manifests/abc/conversions",
		);
	});

	it.each([
		["https://10.0.0.5", resolveTo("10.0.0.5")],
		["https://169.254.169.254", resolveTo("169.254.169.254")],
		["https://ghe.internal", resolveTo("140.82.112.3")],
		["https://github.acme.com", resolveTo("127.0.0.1")],
		["https://github.acme.com", resolveTo("fd00::1")],
	])("sends nothing to %s", async (baseUrl, resolveHost) => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => ok());
		await expect(
			convertGithubManifest(baseUrl, "abc", {
				allowedHosts: none,
				resolveHost,
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toBeInstanceOf(GithubHostError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("sends to an allowlisted internal host", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => ok());
		await convertGithubManifest("https://ghe.corp.internal", "abc", {
			allowedHosts: parseAllowedGithubHosts("ghe.corp.internal"),
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://ghe.corp.internal/api/v3/app-manifests/abc/conversions",
		);
	});

	it.each([301, 302, 307, 308])(
		"refuses a %i answer instead of following it",
		async (status) => {
			const fetchMock = vi.fn(
				async (..._args: unknown[]) =>
					new Response(null, {
						status,
						headers: { location: "https://10.0.0.5/steal" },
					}),
			);
			await expect(
				convertGithubManifest("https://github.acme.com", "abc", {
					allowedHosts: none,
					resolveHost: resolveTo("140.82.112.3"),
					fetch: fetchMock as unknown as typeof fetch,
				}),
			).rejects.toBeInstanceOf(GithubHostError);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it("lets a GitHub error through unchanged", async () => {
		const fetchMock = vi.fn(
			async (..._args: unknown[]) =>
				new Response(JSON.stringify({ message: "Not Found" }), {
					status: 404,
					headers: { "content-type": "application/json" },
				}),
		);
		const error = await convertGithubManifest("https://github.acme.com", "abc", {
			allowedHosts: none,
			resolveHost: resolveTo("140.82.112.3"),
			fetch: fetchMock as unknown as typeof fetch,
		}).catch((e) => e);
		expect(error).not.toBeInstanceOf(GithubHostError);
		expect(error.status).toBe(404);
	});
});

describe("verifyGithubInstallation host check", () => {
	const provider = (githubUrl: string) => ({
		githubAppId: 7,
		githubPrivateKey: "pem",
		githubUrl,
	});

	it.each([
		["https://10.0.0.5", resolveTo("10.0.0.5")],
		["https://github.acme.com", resolveTo("192.168.1.1")],
		["https://ghe.local", resolveTo("140.82.112.3")],
	])("does not contact %s", async (githubUrl, resolveHost) => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("{}"));
		await expect(
			verifyGithubInstallation(provider(githubUrl), "42", {
				allowedHosts: none,
				resolveHost,
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).resolves.toEqual({ ok: false, reason: "unavailable" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
