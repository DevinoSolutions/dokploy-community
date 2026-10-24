import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The routes of the restricted-compose audit (T-7455): the organization switch,
 * the findings list and the exclusions are for owners and admins, always scoped
 * to the organization of the session; the per-service switch needs the service
 * permission, like the watchdog's. Everything is audited, nothing is enterprise
 * gated.
 */

const mocks = vi.hoisted(() => ({
	checkServicePermissionAndAccess: vi.fn(),
	getComposePolicySettings: vi.fn(),
	setComposePolicyAudit: vi.fn(),
	setComposePolicyExclusion: vi.fn(),
	listComposePolicyFindings: vi.fn(),
	listComposeNamesInOrganization: vi.fn(),
	findComposeById: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("@dokploy/server/services/compose-policy-audit", () => ({
	getComposePolicySettings: mocks.getComposePolicySettings,
	setComposePolicyAudit: mocks.setComposePolicyAudit,
	setComposePolicyExclusion: mocks.setComposePolicyExclusion,
	listComposePolicyFindings: mocks.listComposePolicyFindings,
	listComposeNamesInOrganization: mocks.listComposeNamesInOrganization,
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findComposeById: mocks.findComposeById,
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@/server/utils/deploy", () => ({
	cancelDeployment: vi.fn(),
	deploy: vi.fn(),
}));
vi.mock("@/server/api/utils/cancel-audit", () => ({ auditCancel: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));
vi.mock("@/server/queues/queueSetup", () => ({ myQueue: { add: vi.fn() } }));

const { composePolicyRouter } = await import(
	"@/server/api/routers/compose-policy"
);
const { composeRouter } = await import("@/server/api/routers/compose");

const contextFor = (role: string) => ({
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "user@example.com", role },
});
const policyCaller = (role: string) =>
	composePolicyRouter.createCaller(
		contextFor(role) as unknown as Parameters<
			typeof composePolicyRouter.createCaller
		>[0],
	);
const composeCaller = (role: string) =>
	composeRouter.createCaller(
		contextFor(role) as unknown as Parameters<
			typeof composeRouter.createCaller
		>[0],
	);

const composeIn = (organizationId: string) => ({
	name: "Stack",
	appName: "stack-xyz789",
	environment: { project: { organizationId } },
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.getComposePolicySettings.mockResolvedValue({
		auditEnabled: false,
		exclusions: [],
	});
	mocks.setComposePolicyAudit.mockImplementation(
		async (_org: string, auditEnabled: boolean) => ({ auditEnabled }),
	);
	mocks.setComposePolicyExclusion.mockImplementation(
		async (_org: string, _id: string, excluded: boolean) => ({ excluded }),
	);
	mocks.listComposePolicyFindings.mockResolvedValue([]);
	mocks.listComposeNamesInOrganization.mockResolvedValue([]);
	mocks.findComposeById.mockResolvedValue(composeIn("org-1"));
});

describe("composePolicy.settings", () => {
	it("is off by default and names the excluded composes that still exist", async () => {
		mocks.getComposePolicySettings.mockResolvedValue({
			auditEnabled: false,
			exclusions: [{ id: "c1", reason: "legacy" }, { id: "gone" }],
		});
		mocks.listComposeNamesInOrganization.mockResolvedValue([
			{ composeId: "c1", name: "Billing" },
		]);

		await expect(policyCaller("owner").settings()).resolves.toEqual({
			auditEnabled: false,
			exclusions: [
				{ id: "c1", reason: "legacy", name: "Billing" },
				{ id: "gone", name: null },
			],
		});
		expect(mocks.getComposePolicySettings).toHaveBeenCalledWith("org-1");
		expect(mocks.listComposeNamesInOrganization).toHaveBeenCalledWith("org-1", [
			"c1",
			"gone",
		]);
	});

	it.each(["member", "guest"])("refuses a %s", async (role) => {
		await expect(policyCaller(role).settings()).rejects.toThrow();
		expect(mocks.getComposePolicySettings).not.toHaveBeenCalled();
	});

	it("is open to an admin", async () => {
		await expect(policyCaller("admin").settings()).resolves.toBeDefined();
	});
});

describe("composePolicy.updateSettings", () => {
	it("turns the audit on for the organization of the session, and audits it", async () => {
		await expect(
			policyCaller("owner").updateSettings({ auditEnabled: true }),
		).resolves.toEqual({ auditEnabled: true });

		expect(mocks.setComposePolicyAudit).toHaveBeenCalledWith("org-1", true, {
			userId: "user-1",
		});
		expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), {
			action: "update",
			resourceType: "settings",
			resourceName: "restricted-compose-audit",
			metadata: { auditEnabled: true },
		});
	});

	it("ignores an organization id in the input", async () => {
		await policyCaller("owner").updateSettings({
			auditEnabled: true,
			organizationId: "org-2",
		} as never);

		expect(mocks.setComposePolicyAudit).toHaveBeenCalledWith("org-1", true, {
			userId: "user-1",
		});
	});

	it("refuses a member and writes nothing", async () => {
		await expect(
			policyCaller("member").updateSettings({ auditEnabled: true }),
		).rejects.toThrow();

		expect(mocks.setComposePolicyAudit).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("needs a boolean", async () => {
		await expect(
			policyCaller("owner").updateSettings({} as never),
		).rejects.toThrow();
		expect(mocks.setComposePolicyAudit).not.toHaveBeenCalled();
	});
});

describe("composePolicy.findings", () => {
	it("lists the findings of the organization of the session only", async () => {
		const since = new Date("2026-10-17T00:00:00Z");

		await policyCaller("admin").findings({ since, limit: 50 });

		expect(mocks.listComposePolicyFindings).toHaveBeenCalledWith("org-1", {
			composeId: undefined,
			since,
			limit: 50,
		});
	});

	it("filters by compose of this organization", async () => {
		await policyCaller("owner").findings({ composeId: "c1" });

		expect(mocks.findComposeById).toHaveBeenCalledWith("c1");
		expect(mocks.listComposePolicyFindings).toHaveBeenCalledWith("org-1", {
			composeId: "c1",
			since: undefined,
			limit: 200,
		});
	});

	it("refuses a compose of another organization, and lists nothing", async () => {
		mocks.findComposeById.mockResolvedValue(composeIn("org-2"));

		await expect(
			policyCaller("owner").findings({ composeId: "c-foreign" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.listComposePolicyFindings).not.toHaveBeenCalled();
	});

	it("still lists the findings of a compose that was deleted (they are this organization's)", async () => {
		mocks.findComposeById.mockRejectedValue(
			new TRPCError({ code: "NOT_FOUND", message: "Compose not found" }),
		);

		await policyCaller("owner").findings({ composeId: "deleted" });

		expect(mocks.listComposePolicyFindings).toHaveBeenCalledWith("org-1", {
			composeId: "deleted",
			since: undefined,
			limit: 200,
		});
	});

	it("does not hide another failure of the compose lookup", async () => {
		mocks.findComposeById.mockRejectedValue(new Error("connection refused"));

		await expect(
			policyCaller("owner").findings({ composeId: "c1" }),
		).rejects.toThrow("connection refused");
		expect(mocks.listComposePolicyFindings).not.toHaveBeenCalled();
	});

	it("refuses a member", async () => {
		await expect(policyCaller("member").findings({})).rejects.toThrow();
		expect(mocks.listComposePolicyFindings).not.toHaveBeenCalled();
	});

	it("bounds the page size", async () => {
		await expect(
			policyCaller("owner").findings({ limit: 501 }),
		).rejects.toThrow();
		await expect(
			policyCaller("owner").findings({ limit: 0 }),
		).rejects.toThrow();
		expect(mocks.listComposePolicyFindings).not.toHaveBeenCalled();
	});
});

describe("composePolicy.removeExclusion", () => {
	it("takes the compose off the list of the organization of the session", async () => {
		await policyCaller("owner").removeExclusion({ composeId: "c1" });

		expect(mocks.setComposePolicyExclusion).toHaveBeenCalledWith(
			"org-1",
			"c1",
			false,
			{ userId: "user-1" },
		);
		expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), {
			action: "update",
			resourceType: "settings",
			resourceName: "restricted-compose-audit-exclusion",
			metadata: { removed: true, composeId: "c1" },
		});
	});

	it("refuses a member", async () => {
		await expect(
			policyCaller("member").removeExclusion({ composeId: "c1" }),
		).rejects.toThrow();
		expect(mocks.setComposePolicyExclusion).not.toHaveBeenCalled();
	});
});

describe("the per-service switch on a compose", () => {
	it("is off by default, and says whether the audit is on", async () => {
		await expect(
			composeCaller("member").composePolicyAuditExclusion({ composeId: "c1" }),
		).resolves.toEqual({ excluded: false, auditEnabled: false });
		expect(mocks.getComposePolicySettings).toHaveBeenCalledWith("org-1");
	});

	it("is on for a compose on the list of its own organization", async () => {
		mocks.getComposePolicySettings.mockResolvedValue({
			auditEnabled: true,
			exclusions: [{ id: "c1" }],
		});

		await expect(
			composeCaller("member").composePolicyAuditExclusion({ composeId: "c1" }),
		).resolves.toEqual({ excluded: true, auditEnabled: true });
		await expect(
			composeCaller("member").composePolicyAuditExclusion({ composeId: "c2" }),
		).resolves.toMatchObject({ excluded: false });
	});

	it("reads the list of the organization that owns the compose", async () => {
		mocks.findComposeById.mockResolvedValue(composeIn("org-1"));

		await composeCaller("member").composePolicyAuditExclusion({
			composeId: "c1",
		});

		expect(mocks.getComposePolicySettings).toHaveBeenCalledWith("org-1");
	});

	it("needs read access to read it, and update access to flip it", async () => {
		await composeCaller("member").composePolicyAuditExclusion({
			composeId: "c1",
		});
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenLastCalledWith(
			expect.anything(),
			"c1",
			{ service: ["read"] },
		);

		await composeCaller("admin").setComposePolicyAuditExclusion({
			composeId: "c1",
			excluded: true,
		});
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenLastCalledWith(
			expect.anything(),
			"c1",
			{ service: ["create"] },
		);
	});

	it("excludes a compose and audits it (owner or admin)", async () => {
		await expect(
			composeCaller("owner").setComposePolicyAuditExclusion({
				composeId: "c1",
				excluded: true,
			}),
		).resolves.toEqual({ excluded: true });

		expect(mocks.setComposePolicyExclusion).toHaveBeenCalledWith(
			"org-1",
			"c1",
			true,
			{ userId: "user-1" },
		);
		expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), {
			action: "update",
			resourceType: "compose",
			resourceId: "c1",
			resourceName: "stack-xyz789",
			metadata: { composePolicyAuditExcluded: true },
		});
	});

	it.each(["member", "guest"])(
		"a %s cannot exclude (or put back) a compose, even with access to the service",
		async (role) => {
			for (const excluded of [true, false]) {
				await expect(
					composeCaller(role).setComposePolicyAuditExclusion({
						composeId: "c1",
						excluded,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
			}

			expect(mocks.setComposePolicyExclusion).not.toHaveBeenCalled();
			expect(mocks.audit).not.toHaveBeenCalled();
		},
	);

	it("reading the switch stays open to a member", async () => {
		await expect(
			composeCaller("member").composePolicyAuditExclusion({ composeId: "c1" }),
		).resolves.toMatchObject({ excluded: false });
	});

	it("refuses a service the caller may not touch (another organization included)", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("UNAUTHORIZED"),
		);

		await expect(
			composeCaller("admin").setComposePolicyAuditExclusion({
				composeId: "c-foreign",
				excluded: true,
			}),
		).rejects.toThrow("UNAUTHORIZED");
		await expect(
			composeCaller("member").composePolicyAuditExclusion({
				composeId: "c-foreign",
			}),
		).rejects.toThrow("UNAUTHORIZED");

		expect(mocks.setComposePolicyExclusion).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});
