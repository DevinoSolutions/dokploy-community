import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `snapvisor.deploymentBuild` / `refreshDeploymentBuild`: the Snapvisor build
 * of the commit a deployment shipped, for the badge on each row of the
 * deployments list.
 *
 * The procedures take a bare `deploymentId`, so each one must prove the
 * deployment's application or compose service is readable by the caller (same
 * `deployment: ["read"]` gate as the list) and belongs to the caller's
 * organization before the organization's Snapvisor token is used. Everything
 * Snapvisor can do wrong (no build yet, bad token, rate limit, down) must come
 * back as a value, never as an error that would break the list.
 */

const SECRET_TOKEN = "sv-pat-0000000000000000beef";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const mocks = vi.hoisted(() => ({
	serviceOrganizationId: "org-1" as string | null,
	memberRole: "owner" as string,
	integration: null as Record<string, unknown> | null,
	application: null as Record<string, unknown> | null,
	compose: null as Record<string, unknown> | null,
	previewDeployment: null as Record<string, unknown> | null,
	deployment: null as Record<string, unknown> | null,
}));

vi.mock("@dokploy/server/db", () => {
	const tableMock = () => ({
		findFirst: vi.fn(async () => undefined),
		findMany: vi.fn(async () => []),
	});
	return {
		db: {
			query: new Proxy({} as Record<string, unknown>, {
				get: (_target, table) => {
					if (table === "member") {
						return {
							findFirst: vi.fn(async () => ({
								id: "member-1",
								userId: "user-1",
								organizationId: "org-1",
								role: mocks.memberRole,
								accessedServices: [],
								accessedProjects: [],
								accessedEnvironments: [],
								user: { id: "user-1" },
							})),
							findMany: vi.fn(async () => []),
						};
					}
					const rows: Record<string, () => unknown> = {
						snapvisorIntegration: () => mocks.integration,
						applications: () => mocks.application,
						compose: () => mocks.compose,
						previewDeployments: () => mocks.previewDeployment,
						deployments: () => mocks.deployment,
					};
					const row = typeof table === "string" ? rows[table] : undefined;
					if (row) {
						return {
							findFirst: vi.fn(async () => row() ?? undefined),
							findMany: vi.fn(async () => []),
						};
					}
					return tableMock();
				},
			}),
			// Service → organization resolver used by assertServiceInOrganization.
			// Integration edits and removals (`updateSnapvisor`, `removeSnapvisor`).
			update: vi.fn(() => ({
				set: () => ({
					where: () => ({ returning: async () => [mocks.integration] }),
				}),
			})),
			delete: vi.fn(() => ({
				where: () => ({ returning: async () => [mocks.integration] }),
			})),
			execute: vi.fn(async () =>
				mocks.serviceOrganizationId
					? [{ organizationId: mocks.serviceOrganizationId }]
					: [],
			),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const build = (overrides: Record<string, unknown> = {}) => ({
	id: "build-id-7",
	number: 7,
	head: { sha: SHA, branch: "main" },
	base: null,
	status: "changes-detected",
	stats: {
		added: 0,
		removed: 0,
		unchanged: 10,
		changed: 3,
		ignored: 0,
		failure: 0,
		retryFailure: 0,
		total: 13,
	},
	url: "https://app.snapvisor.io/ignored",
	...overrides,
});

const jsonResponse = (status: number, body: unknown, headers = {}) =>
	({
		ok: status >= 200 && status < 300,
		status,
		statusText: "",
		headers: { get: (name: string) => (headers as never)[name] ?? null },
		text: async () => JSON.stringify(body),
	}) as unknown as Response;

const listPage = (results: unknown[]) =>
	jsonResponse(200, {
		results,
		pageInfo: { total: results.length, page: 1, perPage: 1 },
	});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { snapvisorRouter } = await import("@/server/api/routers/snapvisor");
const { createCallerFactory } = await import("@/server/api/trpc");
const {
	commitShaFromDescription,
	removeSnapvisor,
	resolveDeploymentSnapvisorBuild,
	snapvisorBuildLookup,
	updateSnapvisor,
} = await import("@dokploy/server/services/snapvisor");

const createCaller = createCallerFactory(snapvisorRouter);
const caller = (role = "owner") =>
	createCaller({
		user: { id: "user-1", email: "owner@test.com", role },
		session: { activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.mockReset();
	snapvisorBuildLookup.clear();
	mocks.serviceOrganizationId = "org-1";
	mocks.memberRole = "owner";
	mocks.integration = {
		snapvisorId: "sv-1",
		organizationId: "org-1",
		name: "Snapvisor",
		accessToken: SECRET_TOKEN,
		accountSlug: "my-team",
		baseUrl: "https://api.snapvisor.io",
		createdAt: new Date(),
	};
	mocks.application = {
		applicationId: "app-1",
		name: "web",
		snapvisorProjectName: "web-app",
		sourceType: "github",
		environment: { project: { organizationId: "org-1" } },
	};
	mocks.compose = {
		composeId: "compose-1",
		name: "stack",
		snapvisorProjectName: "stack-app",
		sourceType: "git",
		environment: { project: { organizationId: "org-1" } },
	};
	mocks.previewDeployment = {
		previewDeploymentId: "preview-1",
		applicationId: "app-1",
		composeId: null,
	};
	mocks.deployment = {
		deploymentId: "dep-1",
		applicationId: "app-1",
		composeId: null,
		previewDeploymentId: null,
		status: "done",
		description: `Commit: ${SHA}`,
		schedule: null,
	};
	fetchMock.mockResolvedValue(listPage([build()]));
});

describe("snapvisor.deploymentBuild access control", () => {
	it("refuses a deployment of an application in another organization", async () => {
		mocks.serviceOrganizationId = "org-2";
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses when the application record disagrees with the service scope", async () => {
		mocks.application = {
			...mocks.application,
			environment: { project: { organizationId: "org-2" } },
		};
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses a compose deployment in another organization", async () => {
		mocks.deployment = {
			...mocks.deployment,
			applicationId: null,
			composeId: "compose-1",
		};
		mocks.serviceOrganizationId = "org-2";
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses a preview deployment of a service in another organization", async () => {
		mocks.deployment = {
			...mocks.deployment,
			applicationId: null,
			previewDeploymentId: "preview-1",
		};
		mocks.serviceOrganizationId = "org-2";
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses a member who may not access the service", async () => {
		mocks.memberRole = "member";
		await expect(
			caller("member").deploymentBuild({ deploymentId: "dep-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses refreshDeploymentBuild for another organization too", async () => {
		mocks.serviceOrganizationId = "org-2";
		await expect(
			caller().refreshDeploymentBuild({ deploymentId: "dep-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("answers 'off' for a deployment that has no service (schedule, backup)", async () => {
		mocks.deployment = {
			...mocks.deployment,
			applicationId: null,
			composeId: null,
			previewDeploymentId: null,
		};
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).resolves.toEqual({ state: "off" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports an unknown deployment as not found", async () => {
		mocks.deployment = null;
		await expect(
			caller().deploymentBuild({ deploymentId: "nope" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("snapvisor.deploymentBuild result", () => {
	it("returns the build for the deployment's commit, with a review link", async () => {
		const result = await caller().deploymentBuild({ deploymentId: "dep-1" });

		expect(result).toEqual({
			state: "ready",
			buildNumber: 7,
			buildStatus: "changes-detected",
			changedSnapshots: 3,
			reviewUrl: "https://app.snapvisor.io/my-team/web-app/builds/7",
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/v2/projects/my-team/web-app/builds");
		expect(url).toContain(`headSha=${SHA}`);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${SECRET_TOKEN}`,
		);
	});

	it("works for a compose service", async () => {
		mocks.deployment = {
			...mocks.deployment,
			applicationId: null,
			composeId: "compose-1",
		};
		const result = await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(result).toMatchObject({ state: "ready", buildNumber: 7 });
		expect(fetchMock.mock.calls[0]?.[0]).toContain("/my-team/stack-app/builds");
	});

	it("works for a preview deployment of the service", async () => {
		mocks.deployment = {
			...mocks.deployment,
			applicationId: null,
			previewDeploymentId: "preview-1",
		};
		const result = await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(result).toMatchObject({ state: "ready" });
	});

	it("never returns the access token", async () => {
		const result = await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
	});

	it("shows nothing when the service is not linked to a Snapvisor project", async () => {
		mocks.application = { ...mocks.application, snapvisorProjectName: null };
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).resolves.toEqual({ state: "off" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("shows nothing when Snapvisor is not connected", async () => {
		mocks.integration = null;
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).resolves.toEqual({ state: "not-connected" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("shows nothing when the deployment has no full commit sha", async () => {
		for (const description of [
			null,
			"",
			"Commit: abc1234",
			"Manual redeploy",
		]) {
			mocks.deployment = { ...mocks.deployment, description };
			await expect(
				caller().deploymentBuild({ deploymentId: "dep-1" }),
			).resolves.toEqual({ state: "no-commit" });
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not trust a commit marker on a service that is not git-sourced", async () => {
		// A Docker-image deploy never writes the marker itself: the description
		// is whatever the deployer typed.
		for (const sourceType of ["docker", "drop"]) {
			mocks.application = { ...mocks.application, sourceType };
			await expect(
				caller().deploymentBuild({ deploymentId: "dep-1" }),
			).resolves.toEqual({ state: "no-commit" });
		}

		mocks.deployment = {
			...mocks.deployment,
			applicationId: null,
			composeId: "compose-1",
		};
		mocks.compose = { ...mocks.compose, sourceType: "raw" };
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).resolves.toEqual({ state: "no-commit" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("looks up a mixed-case marker by the lower-case sha, sharing the cache", async () => {
		mocks.deployment = {
			...mocks.deployment,
			description: `Commit: ${SHA.toUpperCase()}`,
		};
		await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(fetchMock.mock.calls[0]?.[0]).toContain(`headSha=${SHA}`);

		mocks.deployment = { ...mocks.deployment, description: `Commit: ${SHA}` };
		await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("is a quiet 'no-build' while Snapvisor has no build for the commit", async () => {
		fetchMock.mockResolvedValue(listPage([]));
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).resolves.toEqual({ state: "no-build" });
	});

	it("is a quiet 'unavailable' for an expired or invalid token", async () => {
		fetchMock.mockResolvedValue(jsonResponse(401, { message: "bad token" }));
		const result = await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(result).toEqual({ state: "unavailable", reason: "auth" });
		expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
	});

	it("is a quiet 'unavailable' when Snapvisor is rate limiting", async () => {
		fetchMock.mockResolvedValue(jsonResponse(429, {}, { "retry-after": "30" }));
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).resolves.toEqual({ state: "unavailable", reason: "rate-limited" });
	});

	it("is a quiet 'unavailable' when the linked project no longer exists", async () => {
		fetchMock.mockResolvedValue(jsonResponse(404, {}));
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).resolves.toEqual({ state: "unavailable", reason: "project" });
	});

	it("is a quiet 'unavailable' when Snapvisor cannot be reached", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).resolves.toEqual({ state: "unavailable", reason: "unreachable" });
	});

	it("omits the changed count when Snapvisor sent no stats", async () => {
		fetchMock.mockResolvedValue(listPage([build({ stats: null })]));
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).resolves.toMatchObject({ state: "ready", changedSnapshots: null });
	});
});

describe("snapvisor.deploymentBuild throttling", () => {
	it("serves a long list from one Snapvisor call per commit", async () => {
		const results = await Promise.all(
			Array.from({ length: 25 }, () =>
				caller().deploymentBuild({ deploymentId: "dep-1" }),
			),
		);
		expect(results.every((r) => r.state === "ready")).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not share a cached answer across organizations", async () => {
		await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Same project name and sha under another organization's token.
		const other = createCaller({
			user: { id: "user-2", email: "o@test.com", role: "owner" },
			session: { activeOrganizationId: "org-2" },
			req: {} as unknown,
			res: {} as unknown,
		} as never);
		mocks.serviceOrganizationId = "org-2";
		mocks.integration = {
			...mocks.integration,
			organizationId: "org-2",
			accessToken: "other-org-token",
		};
		mocks.application = {
			...mocks.application,
			environment: { project: { organizationId: "org-2" } },
		};
		await other.deploymentBuild({ deploymentId: "dep-1" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("serves a failure from the cache too, instead of retrying per row", async () => {
		fetchMock.mockResolvedValue(jsonResponse(401, {}));
		await caller().deploymentBuild({ deploymentId: "dep-1" });
		await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("refresh skips the cache and leaves the answer fresh for the list", async () => {
		await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Inside the minimum interval a refresh is still served from cache.
		await caller().refreshDeploymentBuild({ deploymentId: "dep-1" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("resolveDeploymentSnapvisorBuild on its own", () => {
	const target = (overrides: Record<string, unknown> = {}) => ({
		serviceId: "app-1",
		name: "web",
		snapvisorProjectName: "web-app",
		organizationId: "org-1",
		sourceType: "github",
		...overrides,
	});

	it("refuses a service of another organization before using any token", async () => {
		// The router checks this too; the service must not rely on it.
		await expect(
			resolveDeploymentSnapvisorBuild({
				deployment: { description: `Commit: ${SHA}` },
				target: target({ organizationId: "org-2" }),
				organizationId: "org-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("answers for a service of the caller's organization", async () => {
		await expect(
			resolveDeploymentSnapvisorBuild({
				deployment: { description: `Commit: ${SHA}` },
				target: target(),
				organizationId: "org-1",
			}),
		).resolves.toMatchObject({ state: "ready", buildNumber: 7 });
	});
});

describe("commitShaFromDescription", () => {
	it("returns the full sha in lower case", () => {
		expect(commitShaFromDescription(`Commit: ${SHA.toUpperCase()}`)).toBe(SHA);
		expect(commitShaFromDescription(`Commit: ${SHA}`)).toBe(SHA);
	});

	it("ignores an abbreviated or missing sha", () => {
		expect(commitShaFromDescription("Commit: abc1234")).toBeNull();
		expect(commitShaFromDescription(null)).toBeNull();
	});
});

describe("the cache and an edited integration", () => {
	it("asks again when the integration points at another account or URL", async () => {
		await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(fetchMock).toHaveBeenCalledTimes(1);

		mocks.integration = { ...mocks.integration, accountSlug: "other-team" };
		await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(fetchMock).toHaveBeenCalledTimes(2);

		mocks.integration = {
			...mocks.integration,
			baseUrl: "https://snapvisor.example.com/api",
		};
		await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("forgets cached answers, failures included, when the integration is updated", async () => {
		fetchMock.mockResolvedValue(jsonResponse(401, {}));
		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).resolves.toEqual({ state: "unavailable", reason: "auth" });

		await updateSnapvisor("org-1", { accessToken: "fresh-token" } as never);
		fetchMock.mockResolvedValue(listPage([build()]));

		await expect(
			caller().deploymentBuild({ deploymentId: "dep-1" }),
		).resolves.toMatchObject({ state: "ready" });
	});

	it("forgets cached answers when the integration is removed", async () => {
		await caller().deploymentBuild({ deploymentId: "dep-1" });
		await removeSnapvisor("org-1");
		await caller().deploymentBuild({ deploymentId: "dep-1" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
