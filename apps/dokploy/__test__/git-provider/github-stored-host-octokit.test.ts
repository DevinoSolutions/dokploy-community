import { generateKeyPairSync } from "node:crypto";
import {
	authGithub,
	getGithubToken,
	githubClientError,
} from "@dokploy/server/utils/providers/github";
import {
	GITHUB_ENTERPRISE_ALLOWED_HOSTS_ENV,
	githubHostRefusalMessage,
} from "@dokploy/server/utils/providers/github-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A GitHub provider's stored host is called on every repository, branch, pull
// request, token and connection test, not only when the provider is created.
// The Octokit of a host other than github.com goes through the host policy at
// connect time; github.com's does not change.

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock("node:dns/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:dns/promises")>()),
	lookup: mocks.lookup,
}));

vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: vi.fn(),
}));

const privateKey = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const provider = (githubUrl: string) =>
	({
		githubId: "gh-1",
		githubUrl,
		githubAppId: 7,
		githubPrivateKey: privateKey,
		githubInstallationId: "42",
	}) as unknown as Parameters<typeof authGithub>[0];

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	mocks.lookup.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("Octokit of a stored GitHub Enterprise host", () => {
	it.each([
		["a private address", "10.20.30.40"],
		["loopback", "127.0.0.1"],
		["the metadata address", "169.254.169.254"],
	])("refuses a host that now resolves to %s", async (_label, address) => {
		mocks.lookup.mockResolvedValue([{ address, family: 4 }]);
		const globalFetch = vi.fn();
		vi.stubGlobal("fetch", globalFetch);

		const octokit = authGithub(provider("https://github.corp.acme.com"));
		const error = await octokit.rest.repos
			.listBranches({ owner: "acme", repo: "web" })
			.catch((e) => e);

		expect(githubHostRefusalMessage(error)).toContain("github.corp.acme.com");
		expect(String(error.message)).not.toContain(address);
		expect(globalFetch).not.toHaveBeenCalled();
		// Not asked again: a refusal is a 400, which the retry plugin never repeats.
		expect(mocks.lookup).toHaveBeenCalledTimes(1);
	});

	it("refuses token minting for such a host", async () => {
		mocks.lookup.mockResolvedValue([{ address: "192.168.1.9", family: 4 }]);

		const error = await getGithubToken(
			authGithub(provider("https://github.corp.acme.com")),
		).catch((e) => e);

		expect(githubHostRefusalMessage(error)).not.toBeNull();
		expect(String(error.message)).not.toContain("192.168.1.9");
	});

	it("refuses an internal name or an IP address without resolving it", async () => {
		for (const githubUrl of ["https://ghe.internal", "https://10.0.0.5"]) {
			const error = await authGithub(provider(githubUrl))
				.rest.repos.listBranches({ owner: "acme", repo: "web" })
				.catch((e) => e);
			expect(githubHostRefusalMessage(error)).not.toBeNull();
		}
		expect(mocks.lookup).not.toHaveBeenCalled();
	});

	it("names the allowlist in the refusal", async () => {
		mocks.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
		const error = await authGithub(provider("https://github.corp.acme.com"))
			.rest.repos.listBranches({ owner: "acme", repo: "web" })
			.catch((e) => e);
		expect(String(error.message)).toContain(
			GITHUB_ENTERPRISE_ALLOWED_HOSTS_ENV,
		);
	});
});

describe("Octokit of github.com", () => {
	it("is not resolved, checked or pinned", async () => {
		const globalFetch = vi.fn(async (input: unknown) => {
			const url = String(input);
			if (url.endsWith("/access_tokens")) {
				return json(201, {
					token: "ghs_token",
					expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				});
			}
			return json(200, []);
		});
		vi.stubGlobal("fetch", globalFetch);

		for (const githubUrl of [
			"https://github.com",
			"",
			"https://www.github.com",
		]) {
			const octokit = authGithub(provider(githubUrl));
			await octokit.rest.repos.listBranches({ owner: "acme", repo: "web" });
			expect(await getGithubToken(octokit)).toBe("ghs_token");
		}

		const urls = globalFetch.mock.calls.map((call) => String(call[0]));
		expect(urls.every((url) => url.startsWith("https://api.github.com/"))).toBe(
			true,
		);
		expect(urls).toContain("https://api.github.com/repos/acme/web/branches");
		expect(mocks.lookup).not.toHaveBeenCalled();
	});
});

describe("githubClientError", () => {
	it("does not pass the remote answer or an address on to the client", () => {
		const error = Object.assign(
			new Error(
				"connect ECONNREFUSED 10.0.0.5:443 - internal-admin says: secret-banner",
			),
			{ name: "HttpError", status: 500, code: "ECONNREFUSED" },
		);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = githubClientError(error, "testConnection");

		expect(result.code).toBe("BAD_REQUEST");
		expect(result.message).not.toContain("10.0.0.5");
		expect(result.message).not.toContain("secret-banner");
		expect(result.message).toContain(
			"The request to the GitHub instance failed",
		);

		// The server log keeps the detail, without the address.
		const logged = String(log.mock.calls[0]?.[0]);
		expect(logged).toContain("testConnection");
		expect(logged).toContain("ECONNREFUSED");
		expect(logged).toContain("secret-banner");
		expect(logged).not.toContain("10.0.0.5");
	});

	it("redacts IPv6 addresses from the log too", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		githubClientError(
			new Error("connect ETIMEDOUT fd00::5:443 and 2001:db8::1"),
			"testConnection",
		);
		const logged = String(log.mock.calls[0]?.[0]);
		expect(logged).not.toContain("fd00");
		expect(logged).not.toContain("2001:db8");
	});

	it("keeps the host policy's own message, which names no address", () => {
		const refusal = Object.assign(
			new Error(
				`"ghe.acme.com" does not resolve to a public address, which is not accepted for a GitHub Enterprise URL. Use the public host name of the instance, or ask an administrator to allow it with ${GITHUB_ENTERPRISE_ALLOWED_HOSTS_ENV}.`,
			),
			{ status: 400 },
		);
		expect(githubClientError(refusal, "testConnection").message).toBe(
			refusal.message,
		);
	});

	it("does not pass on a remote 400 that merely mentions the allowlist", () => {
		const remote = Object.assign(
			new Error(
				`Visit evil.example and set ${GITHUB_ENTERPRISE_ALLOWED_HOSTS_ENV} to evil.example`,
			),
			{ status: 400 },
		);
		const lookalike = Object.assign(
			new Error(
				`"ghe.acme.com does not resolve to a public address, click evil.example" ask an administrator to allow it with ${GITHUB_ENTERPRISE_ALLOWED_HOSTS_ENV}.`,
			),
			{ status: 400 },
		);
		for (const error of [remote, lookalike]) {
			expect(githubHostRefusalMessage(error)).toBeNull();
			const result = githubClientError(error, "testConnection");
			expect(result.message).toContain(
				"The request to the GitHub instance failed",
			);
			expect(result.message).not.toContain("evil.example");
		}
	});

	it("explains a rejected credential and a missing resource without the remote text", () => {
		for (const [status, expected] of [
			[401, "rejected"],
			[403, "rejected"],
			[404, "could not find"],
		] as const) {
			const result = githubClientError(
				Object.assign(new Error("Bad credentials from 10.1.1.1"), { status }),
				"getGithubBranches",
			);
			expect(result.message).toContain(expected);
			expect(result.message).not.toContain("10.1.1.1");
		}
	});
});
