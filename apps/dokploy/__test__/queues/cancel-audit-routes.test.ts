import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The instance-wide queue wipe and the audit log listing around the cancel
 * entries: who emptied the queue is on record under the "cancel" action, and
 * the listing can be filtered down to the application and compose entries the
 * cancel routes write.
 */

const mocks = vi.hoisted(() => ({
	cleanAllDeploymentQueue: vi.fn(),
	getAuditLogs: vi.fn(),
	hasValidLicense: vi.fn(),
	audit: vi.fn(),
	auditCancel: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server", () => ({ IS_CLOUD: false }));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

vi.mock("@/server/api/utils/cancel-audit", () => ({
	auditCancel: mocks.auditCancel,
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: mocks.cleanAllDeploymentQueue,
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
}));

vi.mock("@dokploy/server/services/proprietary/audit-log", () => ({
	getAuditLogs: mocks.getAuditLogs,
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: mocks.hasValidLicense,
}));

const ctx = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
};

const { settingsRouter } = await import("@/server/api/routers/settings");
const { auditLogRouter } = await import(
	"@/server/api/routers/proprietary/audit-log"
);

const settingsCaller = settingsRouter.createCaller(
	ctx as Parameters<typeof settingsRouter.createCaller>[0],
);
const auditLogCaller = auditLogRouter.createCaller(
	ctx as Parameters<typeof auditLogRouter.createCaller>[0],
);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.cleanAllDeploymentQueue.mockResolvedValue(4);
	mocks.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
	mocks.hasValidLicense.mockResolvedValue(true);
});

describe("settings.cleanAllDeploymentQueue", () => {
	it("records the caller as a cancel of the whole queue", async () => {
		await settingsCaller.cleanAllDeploymentQueue();

		expect(mocks.cleanAllDeploymentQueue).toHaveBeenCalledTimes(1);
		expect(mocks.audit).toHaveBeenCalledTimes(1);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				user: expect.objectContaining({ id: "user-1" }),
				session: expect.objectContaining({ activeOrganizationId: "org-1" }),
			}),
			{
				action: "cancel",
				resourceType: "settings",
				resourceName: "clean-deployment-queue",
			},
		);
	});
});

describe("settings.cleanAllDeploymentQueue in the fork cancel trail", () => {
	it("records the caller as a wipe of every queue", async () => {
		await settingsCaller.cleanAllDeploymentQueue();

		expect(mocks.auditCancel).toHaveBeenCalledTimes(1);
		expect(mocks.auditCancel).toHaveBeenCalledWith(
			expect.objectContaining({
				user: expect.objectContaining({ id: "user-1" }),
				session: expect.objectContaining({ activeOrganizationId: "org-1" }),
			}),
			{
				action: "clear_all_queues",
				targetType: "queue",
				targetName: "all",
				metadata: { removed: 4, scope: "instance-wide" },
			},
		);
	});
});

describe("auditLog.all filters", () => {
	it.each([
		["action", { action: "cancel" }],
		["application entries", { resourceType: "application" }],
		["compose entries", { resourceType: "compose" }],
		["deployment entries", { resourceType: "deployment" }],
	] as const)("accepts a filter on %s", async (_name, filter) => {
		await auditLogCaller.all(filter);

		expect(mocks.getAuditLogs).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-1", ...filter }),
		);
	});

	it("still needs a valid enterprise license", async () => {
		mocks.hasValidLicense.mockResolvedValue(false);

		await expect(auditLogCaller.all({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.getAuditLogs).not.toHaveBeenCalled();
	});
});
