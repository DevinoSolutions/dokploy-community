import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Organization scoping for the user-owned wildcard domain procedures.
 *
 * Same rule as waves 1-5: `withPermission(...)` / `adminProcedure` only prove
 * the caller holds a role inside their *active* organization, never that the
 * `projectId` they passed belongs to it. Every new procedure that reads or
 * writes generated-domain configuration therefore has to assert the row is in
 * the caller's organization first — and the organization-level procedures must
 * derive the organization from the session, never from input.
 */
const mocks = vi.hoisted(() => ({
	projectFindFirst: vi.fn(),
	organizationFindFirst: vi.fn(),
	serverFindFirst: vi.fn(),
	webServerSettingsFindFirst: vi.fn(),
	updateTable: vi.fn(),
	updateSet: vi.fn(),
	updateWhere: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(() => Promise.resolve()),
}));

vi.mock("@dokploy/server/db", () => {
	const thenable = () => {
		const promise = Promise.resolve([{}]);
		return Object.assign(promise, {
			returning: () => Promise.resolve([{}]),
		});
	};

	return {
		db: {
			execute: vi.fn(() => Promise.resolve([] as unknown[])),
			insert: vi.fn(() => ({
				values: () => ({ returning: () => Promise.resolve([{}]) }),
			})),
			update: vi.fn((table: unknown) => {
				mocks.updateTable(table);
				return {
					set: (values: unknown) => {
						mocks.updateSet(values);
						return {
							where: (condition: unknown) => {
								mocks.updateWhere(condition);
								return thenable();
							},
						};
					},
				};
			}),
			query: {
				projects: { findFirst: mocks.projectFindFirst },
				organization: { findFirst: mocks.organizationFindFirst },
				server: { findFirst: mocks.serverFindFirst },
				webServerSettings: { findFirst: mocks.webServerSettingsFindFirst },
			},
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	return {
		...actual,
		checkPermission: vi.fn(async () => {}),
		findMemberByUserId: vi.fn(async () => ({
			role: "member",
			accessedProjects: [] as string[],
		})),
	};
});

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return {
		...actual,
		generateTraefikMeDomain: vi.fn(async () => generatedDomain),
	};
});

let generatedDomain = {
	domain: "app-1a2b3c.apps.org.example",
	baseDomain: "apps.org.example",
	source: "organization" as const,
};

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");
const { generateTraefikMeDomain } = await import("@dokploy/server");

const createCaller = createCallerFactory(appRouter);

const ownerCtx = {
	user: {
		id: "user-1",
		email: "owner@test.com",
		role: "owner",
		ownerId: "user-1",
	},
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never;

const memberCtx = {
	user: {
		id: "user-2",
		email: "member@test.com",
		role: "member",
		ownerId: "user-1",
	},
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never;

const projectInOrganization = (
	organizationId: string,
	overrides: Partial<{
		wildcardDomain: string | null;
		useOrganizationWildcard: boolean;
		organizationWildcardDomain: string | null;
	}> = {},
) => {
	mocks.projectFindFirst.mockResolvedValue({
		projectId: "project-1",
		organizationId,
		wildcardDomain: overrides.wildcardDomain ?? null,
		useOrganizationWildcard: overrides.useOrganizationWildcard ?? true,
		organization: {
			wildcardDomain: overrides.organizationWildcardDomain ?? null,
		},
	});
};

const serverInOrganization = (
	organizationId: string,
	ipAddress = "203.0.113.10",
) => {
	mocks.serverFindFirst.mockResolvedValue({
		serverId: "srv-1",
		name: "srv",
		organizationId,
		ipAddress,
		defaultDomain: null,
	});
};

const restriction = (config: unknown) => {
	mocks.webServerSettingsFindFirst.mockResolvedValue({
		serverIp: "",
		domainRestrictionConfig: config,
	});
};

const crossOrganization = { code: "UNAUTHORIZED" };

beforeEach(() => {
	vi.clearAllMocks();
	generatedDomain = {
		domain: "app-1a2b3c.apps.org.example",
		baseDomain: "apps.org.example",
		source: "organization",
	};
	vi.mocked(generateTraefikMeDomain).mockImplementation(
		async () => generatedDomain as never,
	);
	projectInOrganization("org-1");
	serverInOrganization("org-1");
	mocks.organizationFindFirst.mockResolvedValue({
		wildcardDomain: "apps.org.example",
	});
	restriction({ enabled: false, allowedWildcards: [] });
});

describe("project wildcard-domain procedures are organization-scoped", () => {
	it("getWildcardDomainConfig rejects a projectId from another organization", async () => {
		projectInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.project.getWildcardDomainConfig({ projectId: "project-1" }),
		).rejects.toMatchObject(crossOrganization);
	});

	it("getWildcardDomainConfig returns the resolved base for an own project", async () => {
		projectInOrganization("org-1", {
			organizationWildcardDomain: "apps.org.example",
		});
		const caller = createCaller(ownerCtx);

		await expect(
			caller.project.getWildcardDomainConfig({ projectId: "project-1" }),
		).resolves.toMatchObject({
			wildcardDomain: null,
			useOrganizationWildcard: true,
			organizationWildcardDomain: "apps.org.example",
			effectiveBaseDomain: "apps.org.example",
			effectiveSource: "organization",
		});
	});

	it("updateWildcardDomain rejects a projectId from another organization and writes nothing", async () => {
		projectInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.project.updateWildcardDomain({
				projectId: "project-1",
				wildcardDomain: "*.hijack.example.com",
			}),
		).rejects.toMatchObject(crossOrganization);
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});

	it("updateWildcardDomain stores the bare base domain", async () => {
		const caller = createCaller(ownerCtx);

		await caller.project.updateWildcardDomain({
			projectId: "project-1",
			wildcardDomain: "*.Apps.Example.com",
			useOrganizationWildcard: false,
		});

		expect(mocks.updateSet).toHaveBeenCalledWith({
			wildcardDomain: "apps.example.com",
			useOrganizationWildcard: false,
		});
	});

	it("updateWildcardDomain refuses a prefix wildcard pattern without writing", async () => {
		const caller = createCaller(ownerCtx);

		await expect(
			caller.project.updateWildcardDomain({
				projectId: "project-1",
				wildcardDomain: "*-apps.example.com",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});

	it("updateWildcardDomain refuses a member without project access", async () => {
		const caller = createCaller(memberCtx);

		await expect(
			caller.project.updateWildcardDomain({
				projectId: "project-1",
				wildcardDomain: "*.apps.example.com",
			}),
		).rejects.toMatchObject(crossOrganization);
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});
});

describe("organization wildcard-domain procedures use the session organization", () => {
	it("getWildcardDomain reads the active organization", async () => {
		const caller = createCaller(ownerCtx);

		await expect(caller.organization.getWildcardDomain()).resolves.toEqual({
			wildcardDomain: "apps.org.example",
		});
		expect(mocks.organizationFindFirst).toHaveBeenCalled();
	});

	it("updateWildcardDomain normalizes and stores the bare base", async () => {
		const caller = createCaller(ownerCtx);

		await expect(
			caller.organization.updateWildcardDomain({
				wildcardDomain: "*.apps.example.com",
			}),
		).resolves.toEqual({ wildcardDomain: "apps.example.com" });
		expect(mocks.updateSet).toHaveBeenCalledWith({
			wildcardDomain: "apps.example.com",
		});
	});

	it("updateWildcardDomain clears the base on an empty string", async () => {
		const caller = createCaller(ownerCtx);

		await expect(
			caller.organization.updateWildcardDomain({ wildcardDomain: "" }),
		).resolves.toEqual({ wildcardDomain: null });
		expect(mocks.updateSet).toHaveBeenCalledWith({ wildcardDomain: null });
	});

	it("updateWildcardDomain is closed to plain members", async () => {
		const caller = createCaller(memberCtx);

		await expect(
			caller.organization.updateWildcardDomain({
				wildcardDomain: "*.apps.example.com",
			}),
		).rejects.toMatchObject(crossOrganization);
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});

	it("updateWildcardDomain refuses an invalid base without writing", async () => {
		const caller = createCaller(ownerCtx);

		await expect(
			caller.organization.updateWildcardDomain({
				wildcardDomain: "*.bad_host.example.com",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});
});

describe("domain.generateDomain is organization-scoped on projectId", () => {
	it("rejects a projectId from another organization", async () => {
		projectInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.domain.generateDomain({
				appName: "app",
				serverId: "srv-1",
				projectId: "project-1",
			}),
		).rejects.toMatchObject(crossOrganization);
		expect(generateTraefikMeDomain).not.toHaveBeenCalled();
	});

	it("threads an in-organization projectId through to the generator", async () => {
		const caller = createCaller(ownerCtx);

		await expect(
			caller.domain.generateDomain({
				appName: "app",
				serverId: "srv-1",
				projectId: "project-1",
			}),
		).resolves.toMatchObject({
			domain: "app-1a2b3c.apps.org.example",
			baseDomain: "apps.org.example",
			source: "organization",
		});
		expect(generateTraefikMeDomain).toHaveBeenCalledWith(
			"app",
			"user-1",
			"srv-1",
			"project-1",
		);
	});

	it("refuses to hand back a domain the restriction allow-list would reject", async () => {
		restriction({ enabled: true, allowedWildcards: ["*.allowed.example.com"] });
		const caller = createCaller(ownerCtx);

		await expect(
			caller.domain.generateDomain({ appName: "app", serverId: "srv-1" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("allows a generated domain that matches the allow-list", async () => {
		restriction({ enabled: true, allowedWildcards: ["*.apps.org.example"] });
		const caller = createCaller(ownerCtx);

		await expect(
			caller.domain.generateDomain({ appName: "app", serverId: "srv-1" }),
		).resolves.toMatchObject({ domain: "app-1a2b3c.apps.org.example" });
	});
});

describe("domain.canGenerateTraefikMeDomains", () => {
	it("rejects a projectId from another organization", async () => {
		projectInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.domain.canGenerateTraefikMeDomains({
				serverId: "srv-1",
				projectId: "project-1",
			}),
		).rejects.toMatchObject(crossOrganization);
	});

	it("still returns the server ip when one is set", async () => {
		const caller = createCaller(ownerCtx);

		await expect(
			caller.domain.canGenerateTraefikMeDomains({ serverId: "srv-1" }),
		).resolves.toBe("203.0.113.10");
	});

	it("falls back to the resolved wildcard base when no ip is available", async () => {
		serverInOrganization("org-1", "");
		projectInOrganization("org-1", {
			organizationWildcardDomain: "apps.org.example",
		});
		const caller = createCaller(ownerCtx);

		await expect(
			caller.domain.canGenerateTraefikMeDomains({
				serverId: "srv-1",
				projectId: "project-1",
			}),
		).resolves.toBe("apps.org.example");
	});

	it("returns an empty string when neither an ip nor a base resolves", async () => {
		serverInOrganization("org-1", "");
		projectInOrganization("org-1");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.domain.canGenerateTraefikMeDomains({
				serverId: "srv-1",
				projectId: "project-1",
			}),
		).resolves.toBe("");
	});
});
