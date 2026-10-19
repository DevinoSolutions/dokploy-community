import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * deploymentCancelAudit.byApplication / byCompose feed the "Cancelled by ..."
 * line on a service's deployments list. They are open to whoever can read that
 * service's deployments, and never return an entry of another organization.
 */

const mocks = vi.hoisted(() => ({
	memberRole: "member" as string,
	licensed: false,
	customRolePermission: "{}",
	accessedServices: [] as string[],
	serviceOrgs: {
		"app-own": "org-1",
		"comp-own": "org-1",
		"app-unassigned": "org-1",
		"app-foreign": "org-2",
		"comp-foreign": "org-2",
	} as Record<string, string>,
	rows: [] as Record<string, unknown>[],
	where: null as unknown,
	limit: null as number | null,
}));

vi.mock("@dokploy/server/db", () => {
	const chain: Record<string, unknown> = {};
	chain.from = () => chain;
	chain.leftJoin = () => chain;
	chain.where = (condition: unknown) => {
		mocks.where = condition;
		return chain;
	};
	chain.orderBy = () => chain;
	chain.limit = async (limit: number) => {
		mocks.limit = limit;
		return mocks.rows;
	};
	return {
		db: {
			select: () => chain,
			query: new Proxy(
				{},
				{
					get: (_target, table) =>
						table === "organizationRole"
							? {
									findMany: vi.fn(async () => [
										{ permission: mocks.customRolePermission },
									]),
								}
							: table === "member"
								? {
										findFirst: vi.fn(async () => ({
											id: "member-1",
											userId: "user-1",
											organizationId: "org-1",
											role: mocks.memberRole,
											accessedServices: mocks.accessedServices,
											accessedProjects: [],
											accessedEnvironments: [],
											user: { id: "user-1" },
										})),
									}
								: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
				},
			),
			// Service -> organization resolver used by assertServiceInOrganization.
			execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
				const id = (query.queryChunks ?? []).find(
					(chunk): chunk is string =>
						typeof chunk === "string" && chunk in mocks.serviceOrgs,
				);
				return id ? [{ organizationId: mocks.serviceOrgs[id] }] : [];
			}),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

// Custom roles only resolve with an enterprise license.
vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(async () => mocks.licensed),
}));

// The native binding is not needed to exercise the router.
vi.mock("bcrypt", () => ({ default: {}, hash: vi.fn(), compare: vi.fn() }));

const { deploymentCancelAuditRouter } = await import(
	"@/server/api/routers/deployment-cancel-audit"
);
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = () =>
	createCallerFactory(deploymentCancelAuditRouter)({
		user: { id: "user-1", email: "user@test.com", role: "member" },
		session: { activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

const entry = (deploymentId: string, extra: Record<string, unknown> = {}) => ({
	deploymentId,
	action: "kill_process",
	actorType: "user",
	actorEmail: "alice@example.com",
	apiKeyId: null,
	apiKeyName: null,
	oauthClientId: null,
	oauthClientName: null,
	createdAt: new Date("2026-10-18T10:00:00Z"),
	...extra,
});

beforeEach(() => {
	mocks.memberRole = "member";
	mocks.licensed = false;
	mocks.customRolePermission = "{}";
	mocks.accessedServices = [];
	mocks.rows = [];
	mocks.where = null;
	mocks.limit = null;
});

describe("deploymentCancelAudit.byApplication", () => {
	it("is available to a member with access to the application", async () => {
		mocks.accessedServices = ["app-own"];
		mocks.rows = [entry("dep-1")];

		await expect(
			caller().byApplication({ applicationId: "app-own" }),
		).resolves.toEqual([
			{
				deploymentId: "dep-1",
				action: "kill_process",
				actorType: "user",
				actorEmail: null,
				apiKeyName: null,
				apiKeyShortId: null,
				oauthClientName: null,
				oauthClientShortId: null,
				createdAt: new Date("2026-10-18T10:00:00Z"),
			},
		]);
	});

	it("is available to an admin without an allow-list", async () => {
		mocks.memberRole = "admin";
		await expect(
			caller().byApplication({ applicationId: "app-own" }),
		).resolves.toEqual([]);
	});

	it("is refused to a member without access to the application", async () => {
		mocks.accessedServices = ["app-other"];
		mocks.rows = [entry("dep-1")];

		await expect(
			caller().byApplication({ applicationId: "app-unassigned" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.where).toBeNull();
	});

	it("is refused for an application of another organization", async () => {
		// Even an admin, and even with the foreign id on the access list
		mocks.memberRole = "admin";
		mocks.accessedServices = ["app-foreign"];
		mocks.rows = [entry("dep-1")];

		await expect(
			caller().byApplication({ applicationId: "app-foreign" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.where).toBeNull();
	});

	it("is refused for an application that does not exist", async () => {
		mocks.memberRole = "owner";
		await expect(
			caller().byApplication({ applicationId: "app-missing" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("only reads entries of the session's organization and that application", async () => {
		mocks.memberRole = "owner";
		await caller().byApplication({ applicationId: "app-own" });

		const { sql, params } = new PgDialect().sqlToQuery(mocks.where as never);
		expect(params).toContain("org-1");
		expect(params).toContain("app-own");
		expect(sql).toContain('"organizationId"');
		expect(sql).toContain('"applicationId"');
		expect(sql).toContain('"deploymentId" is not null');
		expect(mocks.limit).toBe(500);
	});

	it("keeps the latest entry of each deployment, newest first, at most 50", async () => {
		mocks.memberRole = "owner";
		// Read newest first: the first entry seen for a deployment wins
		mocks.rows = [
			entry("dep-1", { action: "kill_build", actorEmail: "newer@example.com" }),
			entry("dep-2"),
			entry("dep-1", { actorEmail: "older@example.com" }),
		];

		const result = await caller().byApplication({ applicationId: "app-own" });
		expect(result.map((r) => r.deploymentId)).toEqual(["dep-1", "dep-2"]);
		expect(result[0]).toMatchObject({
			action: "kill_build",
			actorEmail: "newer@example.com",
		});

		mocks.rows = Array.from({ length: 80 }, (_, i) => entry(`dep-${i}`));
		const many = await caller().byApplication({ applicationId: "app-own" });
		expect(many).toHaveLength(50);
	});

	it("names an API key by its name, or by the start of its id", async () => {
		mocks.memberRole = "owner";
		mocks.rows = [
			entry("dep-1", {
				actorType: "api_key",
				apiKeyId: "abcdef123456",
				apiKeyName: " ci-bot ",
			}),
			entry("dep-2", {
				actorType: "api_key",
				apiKeyId: "zyxwvu987654",
				apiKeyName: null,
			}),
			entry("dep-3", { actorType: "system", actorEmail: null }),
		];

		const result = await caller().byApplication({ applicationId: "app-own" });
		expect(result[0]).toMatchObject({
			actorType: "api_key",
			apiKeyName: "ci-bot",
			apiKeyShortId: "abcdef",
		});
		expect(result[1]).toMatchObject({
			apiKeyName: null,
			apiKeyShortId: "zyxwvu",
		});
		expect(result[2]).toMatchObject({ actorType: "system", actorEmail: null });
	});

	it("cleans an untrusted OAuth client name", async () => {
		mocks.memberRole = "owner";
		const nameOf = async (name: string) => {
			mocks.rows = [
				entry("dep-x", {
					actorType: "oauth_client",
					oauthClientId: "abcdef123456",
					oauthClientName: name,
				}),
			];
			const [result] = await caller().byApplication({
				applicationId: "app-own",
			});
			return result?.oauthClientName;
		};

		// Bidi overrides and zero-width characters are dropped
		expect(await nameOf("\u202Egnp.exe\u202C Claude\u200B Code")).toBe(
			"gnp.exe Claude Code",
		);
		// Whitespace and newlines collapse
		expect(await nameOf("  Claude \n\t  Code  ")).toBe("Claude Code");
		// A huge name is capped at 64 characters ending in an ellipsis
		const long = await nameOf("A".repeat(5000));
		expect(long).toBe(`${"A".repeat(63)}\u2026`);
		expect(Array.from(long ?? "")).toHaveLength(64);
		// Nothing printable left: null, so the short id is used
		expect(await nameOf("\u0000\u0007\u202E\u2066\u200F")).toBeNull();
		expect(await nameOf("   ")).toBeNull();
	});

	it("returns display fields only", async () => {
		mocks.memberRole = "owner";
		mocks.rows = [
			entry("dep-1", {
				metadata: '{"secret":1}',
				actorId: "user-9",
				apiKeyId: "key-1",
			}),
		];

		const [result] = await caller().byApplication({
			applicationId: "app-own",
		});
		expect(Object.keys(result as object).sort()).toEqual([
			"action",
			"actorEmail",
			"actorType",
			"apiKeyName",
			"apiKeyShortId",
			"createdAt",
			"deploymentId",
			"oauthClientName",
			"oauthClientShortId",
		]);
	});

	it("names an OAuth client by its name, or by the start of its client id", async () => {
		mocks.memberRole = "owner";
		mocks.rows = [
			entry("dep-1", {
				actorType: "oauth_client",
				oauthClientId: "client-abc123",
				oauthClientName: " Claude Code ",
			}),
			entry("dep-2", {
				actorType: "oauth_client",
				oauthClientId: "zyxwvu987654",
				oauthClientName: null,
			}),
		];

		const result = await caller().byApplication({ applicationId: "app-own" });
		expect(result[0]).toMatchObject({
			actorType: "oauth_client",
			oauthClientName: "Claude Code",
			oauthClientShortId: "client",
			apiKeyName: null,
		});
		expect(result[1]).toMatchObject({
			oauthClientName: null,
			oauthClientShortId: "zyxwvu",
		});
	});
});

describe("deploymentCancelAudit.byCompose", () => {
	it("is available to a member with access, scoped to the compose", async () => {
		mocks.accessedServices = ["comp-own"];
		mocks.rows = [entry("dep-1")];

		const result = await caller().byCompose({ composeId: "comp-own" });
		expect(result).toHaveLength(1);

		const { sql, params } = new PgDialect().sqlToQuery(mocks.where as never);
		expect(params).toContain("org-1");
		expect(params).toContain("comp-own");
		expect(sql).toContain('"composeId"');
	});

	it("is refused to a member without access", async () => {
		await expect(
			caller().byCompose({ composeId: "comp-own" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("is refused for a compose of another organization", async () => {
		mocks.memberRole = "owner";
		await expect(
			caller().byCompose({ composeId: "comp-foreign" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.where).toBeNull();
	});
});

describe("who cancelled is member information", () => {
	const apiKeyEntry = entry("dep-2", {
		actorType: "api_key",
		actorEmail: "bob@example.com",
		apiKeyId: "abcdef123456",
		apiKeyName: "ci-bot",
	});

	const oauthEntry = entry("dep-3", {
		actorType: "oauth_client",
		actorEmail: "carol@example.com",
		oauthClientId: "abcdef123456",
		oauthClientName: "Claude Code",
	});

	it("hides the OAuth client from a member without member:read", async () => {
		mocks.accessedServices = ["app-own", "comp-own"];
		mocks.rows = [oauthEntry];

		for (const result of [
			await caller().byApplication({ applicationId: "app-own" }),
			await caller().byCompose({ composeId: "comp-own" }),
		]) {
			expect(result).toMatchObject([
				{
					deploymentId: "dep-3",
					actorType: "oauth_client",
					actorEmail: null,
					oauthClientName: null,
					oauthClientShortId: null,
				},
			]);
		}
	});

	it("shows the OAuth client to an admin", async () => {
		mocks.memberRole = "admin";
		mocks.rows = [oauthEntry];

		await expect(
			caller().byApplication({ applicationId: "app-own" }),
		).resolves.toMatchObject([
			{
				actorType: "oauth_client",
				actorEmail: "carol@example.com",
				oauthClientName: "Claude Code",
				oauthClientShortId: "abcdef",
			},
		]);
	});

	it("hides the email and the key name from a member without member:read", async () => {
		mocks.accessedServices = ["app-own", "comp-own"];
		mocks.rows = [entry("dep-1"), apiKeyEntry];

		for (const result of [
			await caller().byApplication({ applicationId: "app-own" }),
			await caller().byCompose({ composeId: "comp-own" }),
		]) {
			expect(result).toMatchObject([
				{
					deploymentId: "dep-1",
					actorType: "user",
					actorEmail: null,
					apiKeyName: null,
					apiKeyShortId: null,
				},
				{
					deploymentId: "dep-2",
					actorType: "api_key",
					actorEmail: null,
					apiKeyName: null,
					apiKeyShortId: null,
				},
			]);
		}
	});

	it.each(["owner", "admin"])("shows them to the %s", async (role) => {
		mocks.memberRole = role;
		mocks.rows = [entry("dep-1"), apiKeyEntry];

		const result = await caller().byApplication({ applicationId: "app-own" });
		expect(result).toMatchObject([
			{ actorEmail: "alice@example.com" },
			{
				actorEmail: "bob@example.com",
				apiKeyName: "ci-bot",
				apiKeyShortId: "abcdef",
			},
		]);
	});

	it("shows them to a custom role with member:read", async () => {
		mocks.licensed = true;
		mocks.memberRole = "auditor";
		mocks.customRolePermission = JSON.stringify({
			deployment: ["read"],
			member: ["read"],
		});
		mocks.accessedServices = ["comp-own"];
		mocks.rows = [entry("dep-1")];

		await expect(
			caller().byCompose({ composeId: "comp-own" }),
		).resolves.toMatchObject([{ actorEmail: "alice@example.com" }]);
	});

	it("hides them from a custom role with deployment:read but not member:read", async () => {
		mocks.licensed = true;
		mocks.memberRole = "deployer";
		mocks.customRolePermission = JSON.stringify({ deployment: ["read"] });
		mocks.accessedServices = ["app-own"];
		mocks.rows = [entry("dep-1")];

		await expect(
			caller().byApplication({ applicationId: "app-own" }),
		).resolves.toMatchObject([{ actorEmail: null }]);
	});

	it("refuses a custom role without deployment:read", async () => {
		mocks.licensed = true;
		mocks.memberRole = "viewer";
		mocks.customRolePermission = JSON.stringify({ member: ["read"] });
		mocks.accessedServices = ["app-own", "comp-own"];
		mocks.rows = [entry("dep-1")];

		// checkPermission rejects with UNAUTHORIZED, as for every other denied
		// permission in this codebase
		await expect(
			caller().byApplication({ applicationId: "app-own" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			caller().byCompose({ composeId: "comp-own" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.where).toBeNull();
	});
});
