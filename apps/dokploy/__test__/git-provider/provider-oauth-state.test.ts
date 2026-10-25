import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The GitLab and Gitea callbacks write OAuth tokens to a provider row. They
// only do so for a state this server signed for that provider, from the
// session that started the flow, when that user may update the provider.

const mocks = vi.hoisted(() => ({
	validateRequest: vi.fn(),
	findGitlabById: vi.fn(),
	updateGitlab: vi.fn(),
	findGiteaById: vi.fn(),
	updateGitea: vi.fn(),
	hasPermission: vi.fn(),
	memberFindFirst: vi.fn(),
	githubFindFirst: vi.fn(),
	githubUpdateSet: vi.fn(),
	fetch: vi.fn(),
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

vi.mock("@dokploy/server", async () => {
	const { assertCanUpdateGitProvider } = await vi.importActual<
		typeof import("@dokploy/server/services/git-provider")
	>("@dokploy/server/services/git-provider");
	return {
		assertCanUpdateGitProvider,
		validateRequest: mocks.validateRequest,
		findGitlabById: mocks.findGitlabById,
		updateGitlab: mocks.updateGitlab,
		findGiteaById: mocks.findGiteaById,
		updateGitea: mocks.updateGitea,
		createGithub: vi.fn(),
		deriveGithubApiUrl: vi.fn(),
		parseGithubBaseUrl: vi.fn(),
	};
});

const {
	createGitProviderOAuthState,
	GIT_PROVIDER_OAUTH_STATE_TTL_MS,
	verifyGitProviderOAuthState,
} = await import("@/server/utils/git-provider-oauth");
const { default: gitlabCallback } = await import(
	"@/pages/api/providers/gitlab/callback"
);
const { default: gitlabAuthorize } = await import(
	"@/pages/api/providers/gitlab/authorize"
);
const { default: giteaCallback } = await import(
	"@/pages/api/providers/gitea/callback"
);
const { default: giteaAuthorize } = await import(
	"@/pages/api/providers/gitea/authorize"
);
const { default: githubSetup } = await import(
	"@/pages/api/providers/github/setup"
);

const ORG = "org-1";
const OTHER_ORG = "org-2";
const USER = "user-1";
const OTHER_USER = "user-2";
const GITLAB_ID = "gitlab-1";
const GITEA_ID = "gitea-1";

const gitlabRow = (overrides: Record<string, unknown> = {}) => ({
	gitlabId: GITLAB_ID,
	gitlabUrl: "https://gitlab.example.com",
	gitlabInternalUrl: null,
	applicationId: "app-id",
	secret: "app-secret",
	redirectUri: "https://dokploy.example.com/api/providers/gitlab/callback",
	gitProvider: { gitProviderId: "gp-1", userId: USER, organizationId: ORG },
	...overrides,
});

const giteaRow = (overrides: Record<string, unknown> = {}) => ({
	giteaId: GITEA_ID,
	giteaUrl: "https://gitea.example.com",
	giteaInternalUrl: null,
	clientId: "client-id",
	clientSecret: "client-secret",
	redirectUri: "https://dokploy.example.com/api/providers/gitea/callback",
	gitProvider: { gitProviderId: "gp-2", userId: USER, organizationId: ORG },
	...overrides,
});

const signedIn = (userId = USER, organizationId = ORG) =>
	mocks.validateRequest.mockResolvedValue({
		user: { id: userId },
		session: { activeOrganizationId: organizationId },
	});

const buildRes = () => {
	const res = {
		statusCode: 0,
		body: undefined as unknown,
		redirectedTo: undefined as string | undefined,
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

const call = async (handler: Handler, query: Record<string, unknown>) => {
	const res = buildRes();
	const req = {
		method: "GET",
		query,
		headers: { cookie: "session=1" },
	} as unknown as NextApiRequest;
	await handler(req, res as unknown as NextApiResponse);
	return res;
};

const stateFor = (
	provider: "gitlab" | "gitea",
	overrides: Partial<{
		providerId: string;
		userId: string;
		organizationId: string;
	}> = {},
	options: { secret?: string; now?: number } = {},
) =>
	createGitProviderOAuthState(
		{
			provider,
			providerId: provider === "gitlab" ? GITLAB_ID : GITEA_ID,
			userId: USER,
			organizationId: ORG,
			...overrides,
		},
		options,
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

beforeEach(() => {
	vi.clearAllMocks();
	signedIn();
	mocks.hasPermission.mockResolvedValue(true);
	mocks.memberFindFirst.mockResolvedValue({ role: "member" });
	mocks.findGitlabById.mockResolvedValue(gitlabRow());
	mocks.findGiteaById.mockResolvedValue(giteaRow());
	mocks.fetch.mockResolvedValue({
		ok: true,
		json: async () => ({
			access_token: "access",
			refresh_token: "refresh",
			expires_in: 7200,
		}),
		text: async () =>
			JSON.stringify({
				access_token: "access",
				refresh_token: "refresh",
				expires_in: 7200,
			}),
	});
	vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("git provider OAuth state", () => {
	it("round-trips the provider, user and organization", () => {
		expect(verifyGitProviderOAuthState(stateFor("gitlab"), "gitlab")).toEqual({
			provider: "gitlab",
			providerId: GITLAB_ID,
			userId: USER,
			organizationId: ORG,
		});
	});

	it("rejects a modified payload", () => {
		expect(
			verifyGitProviderOAuthState(tamper(stateFor("gitlab")), "gitlab"),
		).toBeNull();
	});

	it("rejects a state signed with another secret", () => {
		const state = stateFor("gitlab", {}, { secret: "another-secret" });
		expect(verifyGitProviderOAuthState(state, "gitlab")).toBeNull();
	});

	it("rejects an expired state", () => {
		const state = stateFor("gitlab", {}, { now: Date.now() - 1 });
		expect(
			verifyGitProviderOAuthState(state, "gitlab", {
				now: Date.now() + GIT_PROVIDER_OAUTH_STATE_TTL_MS,
			}),
		).toBeNull();
	});

	it("rejects a state issued for the other provider type", () => {
		expect(verifyGitProviderOAuthState(stateFor("gitea"), "gitlab")).toBeNull();
	});

	it.each([
		["missing", undefined],
		["an array", ["a", "b"]],
		["a bare provider id", GITEA_ID],
		["a JSON provider id", JSON.stringify({ giteaId: GITEA_ID })],
		["a truncated signature", "v1.e30.abc"],
	])("rejects a state that is %s", (_label, state) => {
		expect(verifyGitProviderOAuthState(state, "gitea")).toBeNull();
	});
});

describe("GitLab OAuth callback", () => {
	const query = (state?: unknown) => ({
		code: "auth-code",
		gitlabId: GITLAB_ID,
		...(state === undefined ? {} : { state }),
	});

	it("stores the tokens for a valid state from the same session", async () => {
		const res = await call(gitlabCallback, query(stateFor("gitlab")));

		expect(res.redirectedTo).toBe("/dashboard/settings/git-providers");
		expect(mocks.updateGitlab).toHaveBeenCalledWith(
			GITLAB_ID,
			expect.objectContaining({
				accessToken: "access",
				refreshToken: "refresh",
			}),
		);
		// The redirect_uri sent with the exchange is unchanged.
		const body = mocks.fetch.mock.calls[0]?.[1]?.body as URLSearchParams;
		expect(body.get("redirect_uri")).toBe(
			`${gitlabRow().redirectUri}?gitlabId=${GITLAB_ID}`,
		);
	});

	it.each([
		["missing", () => undefined],
		["tampered", () => tamper(stateFor("gitlab"))],
		[
			"expired",
			() =>
				stateFor(
					"gitlab",
					{},
					{ now: Date.now() - GIT_PROVIDER_OAUTH_STATE_TTL_MS - 1 },
				),
		],
		[
			"issued for another GitLab provider",
			() => stateFor("gitlab", { providerId: "gitlab-2" }),
		],
		["issued for Gitea", () => stateFor("gitea", { providerId: GITLAB_ID })],
	])("rejects a %s state with 400", async (_label, state) => {
		const res = await call(gitlabCallback, query(state()));

		expect(res.statusCode).toBe(400);
		expect(mocks.findGitlabById).not.toHaveBeenCalled();
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.updateGitlab).not.toHaveBeenCalled();
	});

	it("rejects a state issued to another user", async () => {
		signedIn(OTHER_USER);
		const res = await call(gitlabCallback, query(stateFor("gitlab")));

		expect(res.statusCode).toBe(403);
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.updateGitlab).not.toHaveBeenCalled();
	});

	it("rejects a request without a session", async () => {
		mocks.validateRequest.mockResolvedValue({ user: null, session: null });
		const res = await call(gitlabCallback, query(stateFor("gitlab")));

		expect(res.statusCode).toBe(401);
		expect(mocks.updateGitlab).not.toHaveBeenCalled();
	});

	it("rejects a state issued for another organization", async () => {
		const res = await call(
			gitlabCallback,
			query(stateFor("gitlab", { organizationId: OTHER_ORG })),
		);

		expect(res.statusCode).toBe(403);
		expect(mocks.updateGitlab).not.toHaveBeenCalled();
	});

	it("rejects a provider row outside the session's organization", async () => {
		mocks.findGitlabById.mockResolvedValue(
			gitlabRow({
				gitProvider: {
					gitProviderId: "gp-1",
					userId: USER,
					organizationId: OTHER_ORG,
				},
			}),
		);
		const res = await call(gitlabCallback, query(stateFor("gitlab")));

		expect(res.statusCode).toBe(404);
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.updateGitlab).not.toHaveBeenCalled();
	});

	it("rejects a member who did not create the provider", async () => {
		mocks.findGitlabById.mockResolvedValue(
			gitlabRow({
				gitProvider: {
					gitProviderId: "gp-1",
					userId: OTHER_USER,
					organizationId: ORG,
				},
			}),
		);
		const res = await call(gitlabCallback, query(stateFor("gitlab")));

		expect(res.statusCode).toBe(403);
		expect(mocks.updateGitlab).not.toHaveBeenCalled();
	});

	it("rejects a user without the git provider permission", async () => {
		mocks.hasPermission.mockResolvedValue(false);
		const res = await call(gitlabCallback, query(stateFor("gitlab")));

		expect(res.statusCode).toBe(403);
		expect(mocks.updateGitlab).not.toHaveBeenCalled();
	});

	it("lets an org admin connect a provider somebody else created", async () => {
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });
		mocks.findGitlabById.mockResolvedValue(
			gitlabRow({
				gitProvider: {
					gitProviderId: "gp-1",
					userId: OTHER_USER,
					organizationId: ORG,
				},
			}),
		);
		await call(gitlabCallback, query(stateFor("gitlab")));

		expect(mocks.updateGitlab).toHaveBeenCalledTimes(1);
	});
});

describe("Gitea OAuth callback", () => {
	const query = (state?: unknown) => ({
		code: "auth-code",
		...(state === undefined ? {} : { state }),
	});

	it("stores the tokens for a valid state from the same session", async () => {
		const res = await call(giteaCallback, query(stateFor("gitea")));

		expect(res.redirectedTo).toBe(
			"/dashboard/settings/git-providers?connected=true",
		);
		expect(mocks.findGiteaById).toHaveBeenCalledWith(GITEA_ID);
		expect(mocks.updateGitea).toHaveBeenCalledWith(
			GITEA_ID,
			expect.objectContaining({ accessToken: "access" }),
		);
	});

	it("does not write for a missing state", async () => {
		const res = await call(giteaCallback, query());

		expect(res.statusCode).toBe(307);
		expect(res.redirectedTo).toContain("error=");
		expect(mocks.updateGitea).not.toHaveBeenCalled();
	});

	it.each([
		["a bare provider id", () => GITEA_ID],
		["a JSON provider id", () => JSON.stringify({ giteaId: GITEA_ID })],
		["tampered", () => tamper(stateFor("gitea"))],
		[
			"expired",
			() =>
				stateFor(
					"gitea",
					{},
					{ now: Date.now() - GIT_PROVIDER_OAUTH_STATE_TTL_MS - 1 },
				),
		],
		["issued for GitLab", () => stateFor("gitlab", { providerId: GITEA_ID })],
	])("rejects a state that is %s with 400", async (_label, state) => {
		const res = await call(giteaCallback, query(state()));

		expect(res.statusCode).toBe(400);
		expect(mocks.findGiteaById).not.toHaveBeenCalled();
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.updateGitea).not.toHaveBeenCalled();
	});

	it("rejects a state issued to another user", async () => {
		signedIn(OTHER_USER);
		const res = await call(giteaCallback, query(stateFor("gitea")));

		expect(res.statusCode).toBe(403);
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.updateGitea).not.toHaveBeenCalled();
	});

	it("rejects a provider row outside the session's organization", async () => {
		mocks.findGiteaById.mockResolvedValue(
			giteaRow({
				gitProvider: {
					gitProviderId: "gp-2",
					userId: USER,
					organizationId: OTHER_ORG,
				},
			}),
		);
		const res = await call(giteaCallback, query(stateFor("gitea")));

		expect(res.statusCode).toBe(404);
		expect(mocks.updateGitea).not.toHaveBeenCalled();
	});

	it("rejects a member who did not create the provider", async () => {
		mocks.findGiteaById.mockResolvedValue(
			giteaRow({
				gitProvider: {
					gitProviderId: "gp-2",
					userId: OTHER_USER,
					organizationId: ORG,
				},
			}),
		);
		const res = await call(giteaCallback, query(stateFor("gitea")));

		expect(res.statusCode).toBe(403);
		expect(mocks.updateGitea).not.toHaveBeenCalled();
	});
});

describe("OAuth authorize routes", () => {
	it("redirects to GitLab with a state bound to the session", async () => {
		const res = await call(gitlabAuthorize, { gitlabId: GITLAB_ID });

		expect(res.statusCode).toBe(307);
		const url = new URL(res.redirectedTo ?? "");
		expect(`${url.origin}${url.pathname}`).toBe(
			"https://gitlab.example.com/oauth/authorize",
		);
		expect(url.searchParams.get("client_id")).toBe("app-id");
		expect(url.searchParams.get("redirect_uri")).toBe(
			`${gitlabRow().redirectUri}?gitlabId=${GITLAB_ID}`,
		);
		expect(
			verifyGitProviderOAuthState(url.searchParams.get("state"), "gitlab"),
		).toEqual({
			provider: "gitlab",
			providerId: GITLAB_ID,
			userId: USER,
			organizationId: ORG,
		});
	});

	it("keeps a self-hosted GitLab base path", async () => {
		mocks.findGitlabById.mockResolvedValue(
			gitlabRow({ gitlabUrl: "https://git.example.com/gitlab" }),
		);
		const res = await call(gitlabAuthorize, { gitlabId: GITLAB_ID });

		expect(res.redirectedTo).toMatch(
			/^https:\/\/git\.example\.com\/gitlab\/oauth\/authorize\?/,
		);
	});

	it("redirects to Gitea with a state bound to the session", async () => {
		const res = await call(giteaAuthorize, { giteaId: GITEA_ID });

		expect(res.statusCode).toBe(307);
		const url = new URL(res.redirectedTo ?? "");
		expect(`${url.origin}${url.pathname}`).toBe(
			"https://gitea.example.com/login/oauth/authorize",
		);
		expect(url.searchParams.get("redirect_uri")).toBe(giteaRow().redirectUri);
		expect(
			verifyGitProviderOAuthState(url.searchParams.get("state"), "gitea"),
		).toEqual({
			provider: "gitea",
			providerId: GITEA_ID,
			userId: USER,
			organizationId: ORG,
		});
	});

	it.each([
		["GitLab", gitlabAuthorize, { gitlabId: GITLAB_ID }],
		["Gitea", giteaAuthorize, { giteaId: GITEA_ID }],
	])(
		"%s: refuses to start the flow without a session",
		async (_l, handler, q) => {
			mocks.validateRequest.mockResolvedValue({ user: null, session: null });
			const res = await call(handler as Handler, q);

			expect(res.statusCode).toBe(401);
			expect(res.redirectedTo).toBeUndefined();
		},
	);

	it.each([
		["GitLab", gitlabAuthorize, { gitlabId: GITLAB_ID }],
		["Gitea", giteaAuthorize, { giteaId: GITEA_ID }],
	])(
		"%s: refuses a provider of another organization",
		async (_l, handler, q) => {
			signedIn(USER, OTHER_ORG);
			const res = await call(handler as Handler, q);

			expect(res.statusCode).toBe(404);
			expect(res.redirectedTo).toBeUndefined();
		},
	);
});

describe("GitHub app install callback", () => {
	const githubRow = (userId: string) => ({
		githubId: "github-1",
		gitProvider: { gitProviderId: "gp-3", userId, organizationId: ORG },
	});
	const query = {
		code: "install-code",
		state: "gh_setup:github-1",
		installation_id: "42",
	};

	it("stores the installation for the provider's creator", async () => {
		mocks.githubFindFirst.mockResolvedValue(githubRow(USER));
		const res = await call(githubSetup, query);

		expect(res.redirectedTo).toBe("/dashboard/settings/git-providers");
		expect(mocks.githubUpdateSet).toHaveBeenCalledWith({
			githubInstallationId: "42",
		});
	});

	it("stores the installation for an org admin", async () => {
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });
		mocks.githubFindFirst.mockResolvedValue(githubRow(OTHER_USER));
		await call(githubSetup, query);

		expect(mocks.githubUpdateSet).toHaveBeenCalledTimes(1);
	});

	it("rejects a member who did not create the provider", async () => {
		mocks.githubFindFirst.mockResolvedValue(githubRow(OTHER_USER));
		const res = await call(githubSetup, query);

		expect(res.statusCode).toBe(403);
		expect(mocks.githubUpdateSet).not.toHaveBeenCalled();
	});
});
