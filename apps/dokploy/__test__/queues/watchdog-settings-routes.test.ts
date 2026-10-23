import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The watchdog's settings routes: validation of the limits at the API, the
 * admin-only gate, the organization check on an excluded service, and the
 * audit entry each change leaves.
 */

const mocks = vi.hoisted(() => ({
	getWebServerSettings: vi.fn(),
	updateWebServerSettings: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	getWebServerSettings: mocks.getWebServerSettings,
	updateWebServerSettings: mocks.updateWebServerSettings,
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

vi.mock("@/server/api/utils/cancel-audit", () => ({ auditCancel: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
}));

const { settingsRouter } = await import("@/server/api/routers/settings");

const callerFor = (role: string) =>
	settingsRouter.createCaller({
		session: { activeOrganizationId: "org-1" },
		user: { id: "user-1", email: "user@example.com", role },
	} as unknown as Parameters<typeof settingsRouter.createCaller>[0]);

const owner = callerFor("owner");

const serviceIn = (organizationId: string) => ({
	name: "Service",
	environment: { project: { organizationId } },
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getWebServerSettings.mockResolvedValue({
		deploymentWatchdogExclusions: [],
	});
	mocks.updateWebServerSettings.mockResolvedValue({});
	mocks.findApplicationById.mockResolvedValue(serviceIn("org-1"));
	mocks.findComposeById.mockResolvedValue(serviceIn("org-1"));
});

describe("settings.updateDeploymentWatchdog", () => {
	it("stores the switch and both limits on the web server settings", async () => {
		await owner.updateDeploymentWatchdog({
			enabled: false,
			idleMinutes: 30,
			maxMinutes: 120,
		});

		expect(mocks.updateWebServerSettings).toHaveBeenCalledWith({
			deploymentWatchdogEnabled: false,
			deploymentWatchdogIdleMinutes: 30,
			deploymentWatchdogMaxMinutes: 120,
		});
		expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), {
			action: "update",
			resourceType: "settings",
			resourceName: "deployment-watchdog",
		});
	});

	it.each([
		{ enabled: true, idleMinutes: 4, maxMinutes: 90 },
		{ enabled: true, idleMinutes: 20, maxMinutes: 14 },
		{ enabled: true, idleMinutes: 60, maxMinutes: 30 },
		{ enabled: true, idleMinutes: 20.5, maxMinutes: 90 },
	])("refuses %j without storing anything", async (input) => {
		await expect(owner.updateDeploymentWatchdog(input)).rejects.toThrow();

		expect(mocks.updateWebServerSettings).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("is for admins: a member is refused", async () => {
		await expect(
			callerFor("member").updateDeploymentWatchdog({
				enabled: true,
				idleMinutes: 20,
				maxMinutes: 90,
			}),
		).rejects.toThrow();

		expect(mocks.updateWebServerSettings).not.toHaveBeenCalled();
	});
});

describe("settings.addDeploymentWatchdogExclusion", () => {
	it("adds an application of the caller's organization", async () => {
		await owner.addDeploymentWatchdogExclusion({
			type: "application",
			id: "a1",
			reason: "long migrations",
		});

		expect(mocks.findApplicationById).toHaveBeenCalledWith("a1");
		expect(mocks.updateWebServerSettings).toHaveBeenCalledWith({
			deploymentWatchdogExclusions: [
				{ type: "application", id: "a1", reason: "long migrations" },
			],
		});
		expect(mocks.audit).toHaveBeenCalledTimes(1);
	});

	it("adds a compose", async () => {
		await owner.addDeploymentWatchdogExclusion({ type: "compose", id: "c1" });

		expect(mocks.findComposeById).toHaveBeenCalledWith("c1");
		expect(mocks.updateWebServerSettings).toHaveBeenCalledWith({
			deploymentWatchdogExclusions: [{ type: "compose", id: "c1" }],
		});
	});

	it("keeps the others and replaces an entry for the same service", async () => {
		mocks.getWebServerSettings.mockResolvedValue({
			deploymentWatchdogExclusions: [
				{ type: "application", id: "a1", reason: "old" },
				{ type: "compose", id: "c9" },
			],
		});

		await owner.addDeploymentWatchdogExclusion({
			type: "application",
			id: "a1",
			reason: "new",
		});

		expect(mocks.updateWebServerSettings).toHaveBeenCalledWith({
			deploymentWatchdogExclusions: [
				{ type: "compose", id: "c9" },
				{ type: "application", id: "a1", reason: "new" },
			],
		});
	});

	it("refuses a service of another organization", async () => {
		mocks.findApplicationById.mockResolvedValue(serviceIn("org-2"));

		await expect(
			owner.addDeploymentWatchdogExclusion({ type: "application", id: "a1" }),
		).rejects.toThrow("not allowed to exclude");

		expect(mocks.updateWebServerSettings).not.toHaveBeenCalled();
	});

	it("refuses a kind that is not an application or a compose", async () => {
		await expect(
			owner.addDeploymentWatchdogExclusion({
				type: "postgres",
				id: "p1",
			} as never),
		).rejects.toThrow();
	});
});

describe("settings.removeDeploymentWatchdogExclusion", () => {
	it("removes only the named service", async () => {
		mocks.getWebServerSettings.mockResolvedValue({
			deploymentWatchdogExclusions: [
				{ type: "application", id: "a1" },
				{ type: "compose", id: "a1" },
				{ type: "application", id: "a2" },
			],
		});

		await owner.removeDeploymentWatchdogExclusion({
			type: "application",
			id: "a1",
		});

		expect(mocks.updateWebServerSettings).toHaveBeenCalledWith({
			deploymentWatchdogExclusions: [
				{ type: "compose", id: "a1" },
				{ type: "application", id: "a2" },
			],
		});
		expect(mocks.audit).toHaveBeenCalledTimes(1);
	});
});
