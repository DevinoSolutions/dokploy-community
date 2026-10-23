import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The per-service switch "Exclude from the stuck-deployment watchdog" on
 * applications and composes: anyone who may update the service can flip it (no
 * admin role), it is off by default, and it edits the same instance-wide list
 * the admin card shows.
 */

const mocks = vi.hoisted(() => ({
	checkServicePermissionAndAccess: vi.fn(),
	getWebServerSettings: vi.fn(),
	updateWebServerSettings: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: mocks.getWebServerSettings,
	updateWebServerSettings: mocks.updateWebServerSettings,
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: mocks.findApplicationById,
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

// A plain member: the switch must not need the admin role.
const ctx = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "member@example.com", role: "member" },
};

const { applicationRouter } = await import("@/server/api/routers/application");
const { composeRouter } = await import("@/server/api/routers/compose");

const applicationCaller = applicationRouter.createCaller(
	ctx as Parameters<typeof applicationRouter.createCaller>[0],
);
const composeCaller = composeRouter.createCaller(
	ctx as Parameters<typeof composeRouter.createCaller>[0],
);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.getWebServerSettings.mockResolvedValue({
		deploymentWatchdogEnabled: true,
		deploymentWatchdogExclusions: [],
	});
	mocks.updateWebServerSettings.mockResolvedValue({});
	mocks.findApplicationById.mockResolvedValue({ appName: "app-abc123" });
	mocks.findComposeById.mockResolvedValue({ appName: "stack-xyz789" });
});

describe("reading the switch", () => {
	it("is off by default, and says whether the watchdog is on", async () => {
		await expect(
			applicationCaller.watchdogExclusion({ applicationId: "a1" }),
		).resolves.toEqual({ excluded: false, watchdogEnabled: true });
		await expect(
			composeCaller.watchdogExclusion({ composeId: "c1" }),
		).resolves.toEqual({ excluded: false, watchdogEnabled: true });
	});

	it("is on for a service on the list, matched by kind and id", async () => {
		mocks.getWebServerSettings.mockResolvedValue({
			deploymentWatchdogExclusions: [
				{ type: "application", id: "a1" },
				{ type: "compose", id: "shared" },
			],
		});

		expect(
			(await applicationCaller.watchdogExclusion({ applicationId: "a1" }))
				.excluded,
		).toBe(true);
		expect(
			(await composeCaller.watchdogExclusion({ composeId: "a1" })).excluded,
		).toBe(false);
		expect(
			(await applicationCaller.watchdogExclusion({ applicationId: "shared" }))
				.excluded,
		).toBe(false);
	});

	it("needs read access to the service", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("UNAUTHORIZED"),
		);

		await expect(
			applicationCaller.watchdogExclusion({ applicationId: "a1" }),
		).rejects.toThrow("UNAUTHORIZED");
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"a1",
			{ service: ["read"] },
		);
	});
});

describe("flipping the switch", () => {
	it("excludes an application for a member who may update it, and audits it", async () => {
		await applicationCaller.setWatchdogExclusion({
			applicationId: "a1",
			excluded: true,
		});

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"a1",
			{ service: ["create"] },
		);
		expect(mocks.updateWebServerSettings).toHaveBeenCalledWith({
			deploymentWatchdogExclusions: [{ type: "application", id: "a1" }],
		});
		expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), {
			action: "update",
			resourceType: "application",
			resourceId: "a1",
			resourceName: "app-abc123",
			metadata: { watchdogExcluded: true },
		});
	});

	it("excludes a compose", async () => {
		await composeCaller.setWatchdogExclusion({
			composeId: "c1",
			excluded: true,
		});

		expect(mocks.updateWebServerSettings).toHaveBeenCalledWith({
			deploymentWatchdogExclusions: [{ type: "compose", id: "c1" }],
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				resourceType: "compose",
				resourceName: "stack-xyz789",
			}),
		);
	});

	it("turning it off removes only that service and keeps the others", async () => {
		mocks.getWebServerSettings.mockResolvedValue({
			deploymentWatchdogExclusions: [
				{ type: "application", id: "a1" },
				{ type: "compose", id: "a1" },
				{ type: "application", id: "a2", reason: "long migrations" },
			],
		});

		await applicationCaller.setWatchdogExclusion({
			applicationId: "a1",
			excluded: false,
		});

		expect(mocks.updateWebServerSettings).toHaveBeenCalledWith({
			deploymentWatchdogExclusions: [
				{ type: "compose", id: "a1" },
				{ type: "application", id: "a2", reason: "long migrations" },
			],
		});
	});

	it("turning it on twice does not duplicate the entry or drop its reason", async () => {
		mocks.getWebServerSettings.mockResolvedValue({
			deploymentWatchdogExclusions: [
				{ type: "application", id: "a1", reason: "set by an admin" },
			],
		});

		await applicationCaller.setWatchdogExclusion({
			applicationId: "a1",
			excluded: true,
		});

		expect(mocks.updateWebServerSettings).toHaveBeenCalledWith({
			deploymentWatchdogExclusions: [
				{ type: "application", id: "a1", reason: "set by an admin" },
			],
		});
	});

	it("changes nothing when the permission check refuses", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("UNAUTHORIZED"),
		);

		await expect(
			composeCaller.setWatchdogExclusion({ composeId: "c1", excluded: true }),
		).rejects.toThrow("UNAUTHORIZED");

		expect(mocks.updateWebServerSettings).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});
