import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Router-level scoping of the Snapvisor integration.
 *
 * `setApplicationProject`/`setComposeProject`/`previewBuild`/
 * `refreshPreviewBuild` take an arbitrary service/`previewDeploymentId`.
 * Holding a role in the active organization says nothing about that id, so
 * every procedure must prove the underlying application or compose service
 * belongs to the caller's organization
 * BEFORE it touches the org's Snapvisor credentials or calls Snapvisor. The
 * access token must never be returned to the client.
 */

const SECRET_TOKEN = "sv-pat-0000000000000000beef";

const mocks = vi.hoisted(() => ({
	serviceOrganizationId: "org-1" as string | null,
	memberRole: "owner" as string,
	integration: null as Record<string, unknown> | null,
	application: null as Record<string, unknown> | null,
	compose: null as Record<string, unknown> | null,
	previewDeployment: null as Record<string, unknown> | null,
}));

vi.mock("@dokploy/server/db", () => {
	const tableMock = () => ({
		findFirst: vi.fn(async () => undefined),
		findMany: vi.fn(async () => []),
	});
	const chain = (returning: Record<string, unknown>): any => {
		let row = returning;
		const self: any = {
			set: vi.fn((values: Record<string, unknown>) => {
				row = { ...row, ...values };
				return self;
			}),
			where: vi.fn(() => self),
			values: vi.fn((values: Record<string, unknown>) => {
				row = { ...row, ...values };
				return self;
			}),
			returning: vi.fn(async () => [row]),
			// biome-ignore lint/suspicious/noThenProperty: drizzle's query builder is itself a thenable, so the fake standing in for it must be one too
			then: (resolve: (value: unknown) => void) => resolve([]),
		};
		return self;
	};
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
					if (table === "snapvisorIntegration") {
						return {
							findFirst: vi.fn(async () => mocks.integration ?? undefined),
							findMany: vi.fn(async () => []),
						};
					}
					if (table === "applications") {
						return {
							findFirst: vi.fn(async () => mocks.application ?? undefined),
							findMany: vi.fn(async () => []),
						};
					}
					if (table === "compose") {
						return {
							findFirst: vi.fn(async () => mocks.compose ?? undefined),
							findMany: vi.fn(async () => []),
						};
					}
					if (table === "previewDeployments") {
						return {
							findFirst: vi.fn(async () => mocks.previewDeployment ?? undefined),
							findMany: vi.fn(async () => []),
						};
					}
					return tableMock();
				},
			}),
			// Service → organization resolver used by assertServiceInOrganization.
			execute: vi.fn(async () =>
				mocks.serviceOrganizationId
					? [{ organizationId: mocks.serviceOrganizationId }]
					: [],
			),
			select: vi.fn(() => chain({})),
			insert: vi.fn(() => chain(mocks.integration ?? {})),
			// Drizzle tables expose their columns as properties: `composeId`
			// identifies the compose table.
			update: vi.fn((table: Record<string, unknown>) =>
				chain(
					("composeId" in table ? mocks.compose : mocks.application) ??
						mocks.integration ??
						{},
				),
			),
			delete: vi.fn(() => chain(mocks.integration ?? {})),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const fetchSpy = vi.fn(async () => {
	throw new Error("Snapvisor must not be called in this test");
});
vi.stubGlobal("fetch", fetchSpy);

const { snapvisorRouter } = await import("@/server/api/routers/snapvisor");
const { createCallerFactory } = await import("@/server/api/trpc");

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
		snapvisorProjectName: null,
		environment: { project: { organizationId: "org-1" } },
	};
	mocks.compose = {
		composeId: "compose-1",
		name: "stack",
		snapvisorProjectName: null,
		environment: { project: { organizationId: "org-1" } },
	};
	mocks.previewDeployment = {
		previewDeploymentId: "preview-1",
		applicationId: "app-1",
		composeId: null,
		snapvisorBuildId: null,
		snapvisorBuildStatus: null,
	};
});

const useComposePreview = () => {
	mocks.previewDeployment = {
		...mocks.previewDeployment,
		applicationId: null,
		composeId: "compose-1",
	};
};

describe("snapvisor router org scoping", () => {
	it("rejects setApplicationProject for an application in another organization", async () => {
		mocks.serviceOrganizationId = "org-2";
		await expect(
			caller().setApplicationProject({
				applicationId: "app-x",
				projectName: "web",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects setApplicationProject when the application record disagrees with the service scope", async () => {
		// assertServiceInOrganization (execute-based) passes, but the row read
		// back via findApplicationById belongs to a different organization: the
		// second, redundant check must still refuse.
		mocks.application = {
			...mocks.application,
			environment: { project: { organizationId: "org-2" } },
		};
		await expect(
			caller().setApplicationProject({
				applicationId: "app-1",
				projectName: "web",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("rejects previewBuild for a preview of an application in another organization", async () => {
		mocks.serviceOrganizationId = "org-2";
		await expect(
			caller().previewBuild({ previewDeploymentId: "preview-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects refreshPreviewBuild for a preview of an application in another organization", async () => {
		mocks.serviceOrganizationId = "org-2";
		await expect(
			caller().refreshPreviewBuild({ previewDeploymentId: "preview-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects previewBuild for a preview that belongs to no service", async () => {
		mocks.previewDeployment = {
			...mocks.previewDeployment,
			applicationId: null,
			composeId: null,
		};
		await expect(
			caller().previewBuild({ previewDeploymentId: "preview-1" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("allows setApplicationProject for an in-organization application", async () => {
		const result = await caller().setApplicationProject({
			applicationId: "app-1",
			projectName: "web",
		});
		expect(result).toEqual({ projectName: "web" });
	});

	it("serves previewBuild for an in-organization preview with no build yet", async () => {
		const result = await caller().previewBuild({
			previewDeploymentId: "preview-1",
		});
		expect(result).toEqual({
			configured: true,
			buildId: null,
			buildStatus: null,
			reviewUrl: null,
		});
	});
});

describe("snapvisor router compose services", () => {
	it("rejects setComposeProject for a compose service in another organization", async () => {
		mocks.serviceOrganizationId = "org-2";
		await expect(
			caller().setComposeProject({ composeId: "compose-x", projectName: "web" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects setComposeProject when the compose record disagrees with the service scope", async () => {
		mocks.compose = {
			...mocks.compose,
			environment: { project: { organizationId: "org-2" } },
		};
		await expect(
			caller().setComposeProject({
				composeId: "compose-1",
				projectName: "web",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("rejects setComposeProject for a member without access to the service", async () => {
		mocks.memberRole = "member";
		await expect(
			caller("member").setComposeProject({
				composeId: "compose-1",
				projectName: "web",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("allows setComposeProject for an in-organization compose service", async () => {
		const result = await caller().setComposeProject({
			composeId: "compose-1",
			projectName: "web",
		});
		expect(result).toEqual({ projectName: "web" });
	});

	it("turns visual testing off with a null project", async () => {
		const result = await caller().setComposeProject({
			composeId: "compose-1",
			projectName: null,
		});
		expect(result).toEqual({ projectName: null });
	});

	it("rejects a project name that is a URL", async () => {
		await expect(
			caller().setComposeProject({
				composeId: "compose-1",
				projectName: "https://evil.example/x",
			}),
		).rejects.toThrow();
	});

	it("rejects previewBuild for a compose preview in another organization", async () => {
		useComposePreview();
		mocks.serviceOrganizationId = "org-2";
		await expect(
			caller().previewBuild({ previewDeploymentId: "preview-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects refreshPreviewBuild for a compose preview in another organization", async () => {
		useComposePreview();
		mocks.serviceOrganizationId = "org-2";
		await expect(
			caller().refreshPreviewBuild({ previewDeploymentId: "preview-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("serves previewBuild for a compose preview with no build yet", async () => {
		useComposePreview();
		const result = await caller().previewBuild({
			previewDeploymentId: "preview-1",
		});
		expect(result).toEqual({
			configured: true,
			buildId: null,
			buildStatus: null,
			reviewUrl: null,
		});
	});

	it("returns the status and review link of a linked compose preview build", async () => {
		useComposePreview();
		mocks.compose = { ...mocks.compose, snapvisorProjectName: "stack-web" };
		mocks.previewDeployment = {
			...mocks.previewDeployment,
			snapvisorBuildId: "42",
			snapvisorBuildStatus: "changes-detected",
		};
		const result = await caller().previewBuild({
			previewDeploymentId: "preview-1",
		});
		expect(result).toEqual({
			configured: true,
			buildId: "42",
			buildStatus: "changes-detected",
			reviewUrl: "https://app.snapvisor.io/my-team/stack-web/builds/42",
		});
		expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
	});

	it("hides the review link when the compose service has visual testing off", async () => {
		useComposePreview();
		mocks.previewDeployment = {
			...mocks.previewDeployment,
			snapvisorBuildId: "42",
			snapvisorBuildStatus: "no-changes",
		};
		const result = await caller().previewBuild({
			previewDeploymentId: "preview-1",
		});
		expect(result.reviewUrl).toBeNull();
		expect(result.buildStatus).toBe("no-changes");
	});
});

describe("snapvisor router credentials", () => {
	it("masks the access token in one", async () => {
		const result = await caller().one();
		expect(result).not.toHaveProperty("accessToken");
		expect(result?.accessTokenMasked).toBe("••••beef");
		expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
	});

	it("keeps credential procedures admin-only", async () => {
		await expect(caller("member").one()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(caller("member").remove()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(caller("member").projects()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	it("reports null from one when the org has no integration", async () => {
		mocks.integration = null;
		await expect(caller().one()).resolves.toBeNull();
	});
});
