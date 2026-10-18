import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who a cancel is written down as: the signed-in user, the user behind an API
 * key (REST or MCP) with the key id, and the read side of the trail, which is
 * admin/owner only and scoped to the caller's organization.
 */

const mocks = vi.hoisted(() => ({
	recordDeploymentCancelAudit: vi.fn(async () => undefined),
	listDeploymentCancelAudit: vi.fn(),
}));

vi.mock("@dokploy/server/services/deployment-cancel-audit", () => ({
	recordDeploymentCancelAudit: mocks.recordDeploymentCancelAudit,
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	listDeploymentCancelAudit: mocks.listDeploymentCancelAudit,
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

const { auditCancel } = await import("@/server/api/utils/cancel-audit");
const { deploymentCancelAuditRouter } = await import(
	"@/server/api/routers/deployment-cancel-audit"
);

const user = { id: "user-1", email: "user@example.com" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listDeploymentCancelAudit.mockResolvedValue({ logs: [], total: 0 });
});

describe("auditCancel actor", () => {
	it("records a signed-in user as a user, in their organization", async () => {
		await auditCancel(
			{ user, session: { activeOrganizationId: "org-1" } },
			{ action: "kill_build", targetType: "application", targetId: "a1" },
		);

		expect(mocks.recordDeploymentCancelAudit).toHaveBeenCalledWith({
			organizationId: "org-1",
			actor: {
				type: "user",
				userId: "user-1",
				email: "user@example.com",
				apiKeyId: undefined,
			},
			action: "kill_build",
			targetType: "application",
			targetId: "a1",
		});
	});

	it("records a request made with an API key as the key's owner plus the key id", async () => {
		await auditCancel(
			{
				user,
				session: { activeOrganizationId: "org-1", apiKeyId: "key-1" },
			},
			{ action: "clean_queue", targetType: "compose", composeId: "c1" },
		);

		expect(mocks.recordDeploymentCancelAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				actor: {
					type: "api_key",
					userId: "user-1",
					email: "user@example.com",
					apiKeyId: "key-1",
				},
				composeId: "c1",
			}),
		);
	});
});

describe("deploymentCancelAudit.all", () => {
	const callerFor = (role: string) =>
		deploymentCancelAuditRouter.createCaller({
			session: { activeOrganizationId: "org-1" },
			user: { ...user, role },
		} as Parameters<typeof deploymentCancelAuditRouter.createCaller>[0]);

	it("lists the entries of the caller's organization only", async () => {
		await callerFor("owner").all({});

		expect(mocks.listDeploymentCancelAudit).toHaveBeenCalledWith({
			organizationId: "org-1",
			targetId: undefined,
			limit: 50,
			offset: 0,
		});
	});

	it("passes the target filter and the page through", async () => {
		await callerFor("admin").all({ targetId: "a1", limit: 10, offset: 20 });

		expect(mocks.listDeploymentCancelAudit).toHaveBeenCalledWith({
			organizationId: "org-1",
			targetId: "a1",
			limit: 10,
			offset: 20,
		});
	});

	it("does not accept an organization id from the input", async () => {
		await callerFor("owner").all({ organizationId: "org-2" } as never);

		expect(mocks.listDeploymentCancelAudit).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-1" }),
		);
	});

	it("is closed to a plain member", async () => {
		await expect(callerFor("member").all({})).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.listDeploymentCancelAudit).not.toHaveBeenCalled();
	});

	it("refuses a page size over 200", async () => {
		await expect(callerFor("owner").all({ limit: 201 })).rejects.toThrow();
	});
});
