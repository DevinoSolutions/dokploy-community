import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The GitHub App flow writes to the organization's providers twice: once when
// GitHub hands back the app created from the manifest (`github_init`) and once
// when it is installed (`github_setup`). Both only run for a state this server
// signed, from the browser and session that started them, and a rejected
// request writes nothing.

const mocks = vi.hoisted(() => ({
	validateRequest: vi.fn(),
	hasPermission: vi.fn(),
	memberFindFirst: vi.fn(),
	githubFindFirst: vi.fn(),
	githubUpdateSet: vi.fn(),
	createGithub: vi.fn(),
	verifyGithubInstallation: vi.fn(),
	findGithubById: vi.fn(),
	octokitRequest: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			member: { findFirst: mocks.memberFindFirst },
			github: { findFirst: mocks.githubFindFirst },
		},
		update: () => ({
			set: (values: unknown) => {
				mocks.githubUpdateSet(values);
				return { where: () => ({ returning: async () => [] }) };
			},
		}),
	},
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(async () => false),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	hasPermission: mocks.hasPermission,
}));

vi.mock("octokit", () => ({
	Octokit: class {
		request = mocks.octokitRequest;
	},
}));

vi.mock("@dokploy/server", async () => {
	const { assertCanUpdateGitProvider } = await vi.importActual<
		typeof import("@dokploy/server/services/git-provider")
	>("@dokploy/server/services/git-provider");
	const { parseGithubBaseUrl, deriveGithubApiUrl } = await vi.importActual<
		typeof import("@dokploy/server/utils/providers/github")
	>("@dokploy/server/utils/providers/github");
	return {
		assertCanUpdateGitProvider,
		parseGithubBaseUrl,
		deriveGithubApiUrl,
		validateRequest: mocks.validateRequest,
		createGithub: mocks.createGithub,
		findGithubById: mocks.findGithubById,
		verifyGithubInstallation: mocks.verifyGithubInstallation,
	};
});

const {
	createGitProviderOAuthState,
	GIT_PROVIDER_OAUTH_STATE_TTL_MS,
	gitProviderOAuthNonceMatches,
	verifyGitProviderOAuthState,
} = await import("@/server/utils/git-provider-oauth");
const { default: setup } = await import("@/pages/api/providers/github/setup");
const { default: authorize } = await import(
	"@/pages/api/providers/github/authorize"
);
const { default: initState } = await import(
	"@/pages/api/providers/github/init-state"
);

const ORG = "org-1";
const OTHER_ORG = "org-2";
const USER = "user-1";
const OTHER_USER = "user-2";
const GITHUB_ID = "github-1";
const GITHUB_URL = "https://github.com";
const NONCE = "browser-nonce-0123456789";
const INIT_COOKIE = `session=1; dokploy_github_init_oauth_nonce=${NONCE}`;
const SETUP_COOKIE = `session=1; dokploy_github_setup_oauth_nonce=${NONCE}`;
const BOTH_COOKIES = `${INIT_COOKIE}; dokploy_github_setup_oauth_nonce=${NONCE}`;

const signedIn = (userId = USER, organizationId = ORG) =>
	mocks.validateRequest.mockResolvedValue({
		user: { id: userId },
		session: { activeOrganizationId: organizationId },
	});

const githubRow = (userId = USER, organizationId = ORG) => ({
	githubId: GITHUB_ID,
	githubAppId: 7,
	githubPrivateKey: "pem",
	githubUrl: GITHUB_URL,
	githubAppName: "https://github.com/apps/dokploy-test",
	gitProvider: { gitProviderId: "gp-1", userId, organizationId },
});

const buildRes = () => {
	const res = {
		statusCode: 0,
		body: undefined as unknown,
		redirectedTo: undefined as string | undefined,
		headers: {} as Record<string, unknown>,
		setHeader(name: string, value: unknown) {
			res.headers[name.toLowerCase()] = value;
			return res;
		},
		getHeader(name: string) {
			return res.headers[name.toLowerCase()];
		},
		get setCookies() {
			return (res.headers["set-cookie"] as string[] | undefined) ?? [];
		},
		status(code: number) {
			res.statusCode = code;
			return res;
		},
		json(payload: unknown) {
			res.body = payload;
			return res;
		},
		redirect(code: number, url: string) {
			res.statusCode = code;
			res.redirectedTo = url;
			return res;
		},
	};
	return res;
};

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

const call = async (
	handler: Handler,
	{
		query = {},
		body,
		method = "GET",
		cookie = BOTH_COOKIES,
		headers = {},
	}: {
		query?: Record<string, unknown>;
		body?: unknown;
		method?: string;
		cookie?: string;
		headers?: Record<string, string>;
	} = {},
) => {
	const res = buildRes();
	const req = {
		method,
		query,
		body,
		headers: { cookie, ...headers },
	} as unknown as NextApiRequest;
	await handler(req, res as unknown as NextApiResponse);
	return res;
};

type Provider = "github_init" | "github_setup";
type Overrides = Partial<{
	providerId: string;
	userId: string;
	organizationId: string;
}>;
const stateFor = (
	provider: Provider,
	overrides: Overrides = {},
	options: { secret?: string; now?: number; nonce?: string } = {},
) =>
	createGitProviderOAuthState(
		{
			provider,
			providerId: provider === "github_init" ? GITHUB_URL : GITHUB_ID,
			userId: USER,
			organizationId: ORG,
			...overrides,
		},
		{ nonce: NONCE, ...options },
	);

const tamper = (state: string) => {
	const [version, payload, signature] = state.split(".") as [
		string,
		string,
		string,
	];
	const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
	claims.u = OTHER_USER;
	const forged = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${version}.${forged}.${signature}`;
};

const expired = (provider: Provider) =>
	stateFor(
		provider,
		{},
		{ now: Date.now() - GIT_PROVIDER_OAUTH_STATE_TTL_MS - 1 },
	);

const manifestResponse = {
	data: {
		name: "Dokploy",
		html_url: "https://github.com/apps/dokploy-test",
		id: 7,
		client_id: "cid",
		client_secret: "csecret",
		webhook_secret: "wsecret",
		pem: "key",
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	signedIn();
	mocks.hasPermission.mockResolvedValue(true);
	mocks.memberFindFirst.mockResolvedValue({ role: "member" });
	mocks.githubFindFirst.mockResolvedValue(githubRow());
	mocks.findGithubById.mockImplementation(async () => githubRow());
	mocks.octokitRequest.mockResolvedValue(manifestResponse);
	mocks.createGithub.mockResolvedValue(undefined);
	mocks.verifyGithubInstallation.mockResolvedValue({ ok: true });
});

const expectNothingWritten = () => {
	expect(mocks.octokitRequest).not.toHaveBeenCalled();
	expect(mocks.createGithub).not.toHaveBeenCalled();
	expect(mocks.githubUpdateSet).not.toHaveBeenCalled();
	expect(mocks.verifyGithubInstallation).not.toHaveBeenCalled();
};

describe("GitHub App creation callback (github_init)", () => {
	const query = (state?: unknown, extra: Record<string, unknown> = {}) => ({
		code: "manifest-code",
		...(state === undefined ? {} : { state }),
		...extra,
	});

	it("creates the provider in the session's organization for a signed state", async () => {
		const res = await call(setup, {
			query: query(stateFor("github_init")),
			cookie: INIT_COOKIE,
		});

		expect(res.redirectedTo).toBe("/dashboard/settings/git-providers");
		expect(mocks.createGithub).toHaveBeenCalledWith(
			expect.objectContaining({
				githubAppId: 7,
				githubUrl: GITHUB_URL,
			}),
			ORG,
			USER,
		);
		// Single use: the nonce cookie is cleared.
		expect(res.setCookies).toEqual([
			expect.stringMatching(
				/^dokploy_github_init_oauth_nonce=; Path=\/api\/providers; Max-Age=0; HttpOnly; SameSite=Lax/,
			),
		]);
	});

	it("keeps the GitHub Enterprise host the state was issued for", async () => {
		const res = await call(setup, {
			query: query(
				stateFor("github_init", { providerId: "https://acme.ghe.com" }),
				{ githubUrl: "https://acme.ghe.com" },
			),
			cookie: INIT_COOKIE,
		});

		expect(res.redirectedTo).toBe("/dashboard/settings/git-providers");
		expect(mocks.createGithub).toHaveBeenCalledWith(
			expect.objectContaining({ githubUrl: "https://acme.ghe.com" }),
			ORG,
			USER,
		);
	});

	it.each([
		["missing", () => undefined],
		["unsigned (the old format)", () => `gh_init:${ORG}:${USER}`],
		["tampered", () => tamper(stateFor("github_init"))],
		["expired", () => expired("github_init")],
		[
			"signed with another secret",
			() => stateFor("github_init", {}, { secret: "another-secret" }),
		],
	])("rejects a %s state with 400 and no write", async (_label, state) => {
		const res = await call(setup, {
			query: query(state()),
			cookie: BOTH_COOKIES,
		});

		expect(res.statusCode).toBe(400);
		expect(res.redirectedTo).toBeUndefined();
		expectNothingWritten();
	});

	it("rejects a state issued to another user", async () => {
		const res = await call(setup, {
			query: query(stateFor("github_init", { userId: OTHER_USER })),
			cookie: INIT_COOKIE,
		});

		expect(res.statusCode).toBe(403);
		expectNothingWritten();
	});

	it("rejects a state issued for another organization", async () => {
		const res = await call(setup, {
			query: query(stateFor("github_init", { organizationId: OTHER_ORG })),
			cookie: INIT_COOKIE,
		});

		expect(res.statusCode).toBe(403);
		expectNothingWritten();
	});

	it.each([
		["no cookie at all", "session=1"],
		[
			"another browser's nonce",
			"dokploy_github_init_oauth_nonce=other-nonce-1",
		],
		["only the install step's cookie", SETUP_COOKIE],
		[
			"a duplicated cookie",
			`${INIT_COOKIE}; dokploy_github_init_oauth_nonce=${NONCE}`,
		],
	])("rejects a callback with %s", async (_label, cookie) => {
		const res = await call(setup, {
			query: query(stateFor("github_init")),
			cookie,
		});

		expect(res.statusCode).toBe(403);
		expect(res.redirectedTo).toBeUndefined();
		expectNothingWritten();
	});

	it("rejects a different GitHub host than the one in the state", async () => {
		const res = await call(setup, {
			query: query(stateFor("github_init"), {
				githubUrl: "https://evil.example.com",
			}),
			cookie: INIT_COOKIE,
		});

		expect(res.statusCode).toBe(400);
		expectNothingWritten();
	});

	it.each([
		["http://acme.ghe.com", "plaintext http"],
		["https://metadata", "dotless hostname"],
	])("rejects %s (%s) before any outbound request", async (githubUrl) => {
		const res = await call(setup, {
			query: query(stateFor("github_init", { providerId: githubUrl }), {
				githubUrl,
			}),
			cookie: INIT_COOKIE,
		});

		expect(res.statusCode).toBe(400);
		expectNothingWritten();
	});

	it("throws on a repeated githubUrl parameter instead of picking one", async () => {
		await expect(
			call(setup, {
				query: query(stateFor("github_init"), {
					githubUrl: ["https://github.com", "https://evil.com"],
				}),
				cookie: INIT_COOKIE,
			}),
		).rejects.toThrow();

		expectNothingWritten();
	});

	it("rejects a user without gitProviders:create", async () => {
		mocks.hasPermission.mockResolvedValue(false);
		const res = await call(setup, {
			query: query(stateFor("github_init")),
			cookie: INIT_COOKIE,
		});

		expect(res.statusCode).toBe(403);
		expectNothingWritten();
	});

	it("rejects a request without a session", async () => {
		mocks.validateRequest.mockResolvedValue({ user: null, session: null });
		const res = await call(setup, {
			query: query(stateFor("github_init")),
			cookie: INIT_COOKIE,
		});

		expect(res.statusCode).toBe(401);
		expectNothingWritten();
	});

	it("requires the code", async () => {
		const res = await call(setup, {
			query: { state: stateFor("github_init") },
			cookie: INIT_COOKIE,
		});

		expect(res.statusCode).toBe(400);
		expectNothingWritten();
	});
});

describe("GitHub App installation callback (github_setup)", () => {
	const query = (
		state?: unknown,
		extra: Record<string, unknown> = { installation_id: "42" },
	) => ({
		code: "install-code",
		...(state === undefined ? {} : { state }),
		...extra,
	});

	it("stores the verified installation for the provider's creator", async () => {
		const res = await call(setup, {
			query: query(stateFor("github_setup")),
			cookie: SETUP_COOKIE,
		});

		expect(res.redirectedTo).toBe("/dashboard/settings/git-providers");
		expect(mocks.verifyGithubInstallation).toHaveBeenCalledWith(
			expect.objectContaining({ githubId: GITHUB_ID }),
			"42",
		);
		expect(mocks.githubUpdateSet).toHaveBeenCalledWith({
			githubInstallationId: "42",
		});
		expect(res.setCookies).toEqual([
			expect.stringMatching(
				/^dokploy_github_setup_oauth_nonce=; Path=\/api\/providers; Max-Age=0/,
			),
		]);
	});

	it("stores the installation for an org admin", async () => {
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });
		mocks.githubFindFirst.mockResolvedValue(githubRow(OTHER_USER));
		const res = await call(setup, {
			query: query(stateFor("github_setup")),
			cookie: SETUP_COOKIE,
		});

		expect(res.redirectedTo).toBe("/dashboard/settings/git-providers");
		expect(mocks.githubUpdateSet).toHaveBeenCalledTimes(1);
	});

	it("rejects a member who did not create the provider", async () => {
		mocks.githubFindFirst.mockResolvedValue(githubRow(OTHER_USER));
		const res = await call(setup, {
			query: query(stateFor("github_setup")),
			cookie: SETUP_COOKIE,
		});

		expect(res.statusCode).toBe(403);
		expectNothingWritten();
	});

	it("rejects the old unsigned state a member could plant in a link", async () => {
		// An admin's browser is sent to the callback with a state the member wrote.
		signedIn("admin-1");
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });
		mocks.githubFindFirst.mockResolvedValue(githubRow(OTHER_USER));
		const res = await call(setup, {
			query: query(`gh_setup:${GITHUB_ID}`),
			cookie: SETUP_COOKIE,
		});

		expect(res.statusCode).toBe(400);
		expectNothingWritten();
	});

	it("rejects a signed state that was issued to someone else when an admin's session follows it", async () => {
		// The state names USER, but the signed-in session is the admin.
		signedIn("admin-1");
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });
		const res = await call(setup, {
			query: query(stateFor("github_setup")),
			cookie: SETUP_COOKIE,
		});

		expect(res.statusCode).toBe(403);
		expectNothingWritten();
	});

	it.each([
		["missing", () => undefined],
		["tampered", () => tamper(stateFor("github_setup"))],
		["expired", () => expired("github_setup")],
		[
			"signed with another secret",
			() => stateFor("github_setup", {}, { secret: "another-secret" }),
		],
	])("rejects a %s state with 400 and no write", async (_label, state) => {
		const res = await call(setup, {
			query: query(state()),
			cookie: BOTH_COOKIES,
		});

		expect(res.statusCode).toBe(400);
		expectNothingWritten();
	});

	it("does not take a creation-step state for an installation", async () => {
		const res = await call(setup, {
			query: query(stateFor("github_init")),
			cookie: BOTH_COOKIES,
		});

		// Judged as a creation: no installation id is ever stored from it.
		expect(mocks.githubUpdateSet).not.toHaveBeenCalled();
		expect(mocks.verifyGithubInstallation).not.toHaveBeenCalled();
		expect(res.statusCode).not.toBe(0);
	});

	it("rejects a state issued to another user", async () => {
		const res = await call(setup, {
			query: query(stateFor("github_setup", { userId: OTHER_USER })),
			cookie: SETUP_COOKIE,
		});

		expect(res.statusCode).toBe(403);
		expectNothingWritten();
	});

	it("rejects a state issued for another organization", async () => {
		const res = await call(setup, {
			query: query(stateFor("github_setup", { organizationId: OTHER_ORG })),
			cookie: SETUP_COOKIE,
		});

		expect(res.statusCode).toBe(403);
		expectNothingWritten();
	});

	it("rejects a provider of another organization", async () => {
		mocks.githubFindFirst.mockResolvedValue(githubRow(USER, OTHER_ORG));
		const res = await call(setup, {
			query: query(stateFor("github_setup")),
			cookie: SETUP_COOKIE,
		});

		expect(res.statusCode).toBe(404);
		expectNothingWritten();
	});

	it("rejects an unknown provider", async () => {
		mocks.githubFindFirst.mockResolvedValue(undefined);
		const res = await call(setup, {
			query: query(stateFor("github_setup")),
			cookie: SETUP_COOKIE,
		});

		expect(res.statusCode).toBe(404);
		expectNothingWritten();
	});

	it.each([
		["no cookie at all", "session=1"],
		["another browser's nonce", "dokploy_github_setup_oauth_nonce=other-1"],
		["only the creation step's cookie", INIT_COOKIE],
		[
			"a duplicated cookie",
			`${SETUP_COOKIE}; dokploy_github_setup_oauth_nonce=${NONCE}`,
		],
	])("rejects a callback with %s", async (_label, cookie) => {
		const res = await call(setup, {
			query: query(stateFor("github_setup")),
			cookie,
		});

		expect(res.statusCode).toBe(403);
		expectNothingWritten();
	});

	it("rejects a user without gitProviders:create", async () => {
		mocks.hasPermission.mockResolvedValue(false);
		const res = await call(setup, {
			query: query(stateFor("github_setup")),
			cookie: SETUP_COOKIE,
		});

		expect(res.statusCode).toBe(403);
		expectNothingWritten();
	});

	it("rejects a request without a session", async () => {
		mocks.validateRequest.mockResolvedValue({ user: null, session: null });
		const res = await call(setup, {
			query: query(stateFor("github_setup")),
			cookie: SETUP_COOKIE,
		});

		expect(res.statusCode).toBe(401);
		expectNothingWritten();
	});

	it("rejects a missing installation id without a write", async () => {
		const res = await call(setup, {
			query: query(stateFor("github_setup"), {}),
			cookie: SETUP_COOKIE,
		});

		expect(res.statusCode).toBe(400);
		expect(mocks.githubUpdateSet).not.toHaveBeenCalled();
	});

	it.each([
		["not_found", 400],
		["invalid", 400],
		["unavailable", 502],
	] as const)(
		"does not store an installation GitHub did not confirm (%s)",
		async (reason, status) => {
			mocks.verifyGithubInstallation.mockResolvedValue({ ok: false, reason });
			const res = await call(setup, {
				query: query(stateFor("github_setup")),
				cookie: SETUP_COOKIE,
			});

			expect(res.statusCode).toBe(status);
			expect(mocks.githubUpdateSet).not.toHaveBeenCalled();
		},
	);
});

describe("GitHub state routes", () => {
	it("init-state issues a signed state and a matching nonce cookie", async () => {
		const res = await call(initState, {
			method: "POST",
			body: { githubUrl: "https://acme.ghe.com" },
			cookie: "session=1",
		});

		expect(res.statusCode).toBe(200);
		const { state } = res.body as { state: string };
		const claims = verifyGitProviderOAuthState(state, "github_init");
		expect(claims).toMatchObject({
			providerId: "https://acme.ghe.com",
			userId: USER,
			organizationId: ORG,
		});
		const cookie = res.setCookies[0] ?? "";
		const nonce = /dokploy_github_init_oauth_nonce=([^;]+);/.exec(cookie)?.[1];
		expect(nonce).toBeTruthy();
		expect(
			gitProviderOAuthNonceMatches(nonce ?? null, claims?.nonceHash ?? ""),
		).toBe(true);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(state).not.toContain(nonce as string);
	});

	it("init-state treats an absent URL as github.com", async () => {
		const res = await call(initState, { method: "POST", body: {} });

		const { state } = res.body as { state: string };
		expect(verifyGitProviderOAuthState(state, "github_init")?.providerId).toBe(
			GITHUB_URL,
		);
	});

	it.each([
		["a cross-site request", { "sec-fetch-site": "cross-site" }],
		["a same-site request", { "sec-fetch-site": "same-site" }],
	])("init-state refuses %s", async (_label, headers) => {
		const res = await call(initState, { method: "POST", body: {}, headers });

		expect(res.statusCode).toBe(403);
		expect(res.body).not.toHaveProperty("state");
		expect(res.setCookies).toEqual([]);
	});

	it("init-state accepts a same-origin request", async () => {
		const res = await call(initState, {
			method: "POST",
			body: {},
			headers: { "sec-fetch-site": "same-origin" },
		});

		expect(res.statusCode).toBe(200);
	});

	it.each([
		["http://acme.ghe.com"],
		["https://metadata"],
		[["https://github.com"]],
		[42],
	])("init-state refuses the GitHub URL %j", async (githubUrl) => {
		const res = await call(initState, { method: "POST", body: { githubUrl } });

		expect(res.statusCode).toBe(400);
		expect(res.setCookies).toEqual([]);
	});

	it("init-state refuses a GET", async () => {
		const res = await call(initState, { method: "GET" });

		expect(res.statusCode).toBe(405);
	});

	it("init-state refuses a user without gitProviders:create", async () => {
		mocks.hasPermission.mockResolvedValue(false);
		const res = await call(initState, { method: "POST", body: {} });

		expect(res.statusCode).toBe(403);
		expect(res.setCookies).toEqual([]);
	});

	it("init-state refuses a request without a session", async () => {
		mocks.validateRequest.mockResolvedValue({ user: null, session: null });
		const res = await call(initState, { method: "POST", body: {} });

		expect(res.statusCode).toBe(401);
		expect(res.setCookies).toEqual([]);
	});

	it("authorize sends the provider's creator to the app's install page with a signed state", async () => {
		const res = await call(authorize, {
			query: { githubId: GITHUB_ID },
			cookie: "session=1",
		});

		expect(res.statusCode).toBe(307);
		const url = new URL(res.redirectedTo as string);
		expect(`${url.origin}${url.pathname}`).toBe(
			"https://github.com/apps/dokploy-test/installations/new",
		);
		const claims = verifyGitProviderOAuthState(
			url.searchParams.get("state"),
			"github_setup",
		);
		expect(claims).toMatchObject({
			providerId: GITHUB_ID,
			userId: USER,
			organizationId: ORG,
		});
		expect(res.setCookies[0]).toMatch(
			/^dokploy_github_setup_oauth_nonce=[^;]+; Path=\/api\/providers/,
		);
	});

	it("authorize lets an org admin start the install", async () => {
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });
		mocks.findGithubById.mockResolvedValue(githubRow(OTHER_USER));
		const res = await call(authorize, { query: { githubId: GITHUB_ID } });

		expect(res.statusCode).toBe(307);
	});

	it("authorize refuses a member who did not create the provider", async () => {
		mocks.findGithubById.mockResolvedValue(githubRow(OTHER_USER));
		const res = await call(authorize, { query: { githubId: GITHUB_ID } });

		expect(res.statusCode).toBe(403);
		expect(res.redirectedTo).toBeUndefined();
		expect(res.setCookies).toEqual([]);
	});

	it("authorize refuses a provider of another organization", async () => {
		mocks.findGithubById.mockResolvedValue(githubRow(USER, OTHER_ORG));
		const res = await call(authorize, { query: { githubId: GITHUB_ID } });

		expect(res.statusCode).toBe(404);
		expect(res.redirectedTo).toBeUndefined();
	});

	it("authorize refuses a cross-site request", async () => {
		const res = await call(authorize, {
			query: { githubId: GITHUB_ID },
			headers: { "sec-fetch-site": "cross-site" },
		});

		expect(res.statusCode).toBe(403);
		expect(res.redirectedTo).toBeUndefined();
		expect(res.setCookies).toEqual([]);
	});

	it("authorize refuses a request without a session", async () => {
		mocks.validateRequest.mockResolvedValue({ user: null, session: null });
		const res = await call(authorize, { query: { githubId: GITHUB_ID } });

		expect(res.statusCode).toBe(401);
		expect(res.redirectedTo).toBeUndefined();
	});

	it("authorize refuses a stored app URL that is not http(s)", async () => {
		mocks.findGithubById.mockResolvedValue({
			...githubRow(),
			githubAppName: "javascript:alert(1)",
		});
		const res = await call(authorize, { query: { githubId: GITHUB_ID } });

		expect(res.statusCode).toBe(400);
		expect(res.redirectedTo).toBeUndefined();
	});
});
