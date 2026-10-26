import { beforeEach, describe, expect, it, vi } from "vitest";

// On Dokploy Cloud there is no instance-owning organization: the instance-wide
// settings keep answering as they did, whatever the caller's organization.

const mocks = vi.hoisted(() => ({
	isRootOrganization: vi.fn(),
	readMonitoringConfig: vi.fn(),
	readMonitoringStats: vi.fn(),
	updateWebServerSettings: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: true,
	// enterpriseProcedure asks for a licence.
	hasValidLicense: async () => true,
	...mocks,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
}));

const { settingsRouter } = await import("@/server/api/routers/settings");

const caller = settingsRouter.createCaller({
	session: { activeOrganizationId: "org-other" },
	user: { id: "user-1", email: "admin@example.com", role: "admin" },
} as Parameters<typeof settingsRouter.createCaller>[0]);

describe("instance-wide settings on Dokploy Cloud", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isRootOrganization.mockResolvedValue(false);
	});

	it("leaves the SSH key, domain restriction and stats routes as they were", async () => {
		await expect(
			caller.saveSSHPrivateKey({ sshPrivateKey: "key" }),
		).resolves.toBe(true);
		await expect(caller.cleanSSHPrivateKey()).resolves.toBe(true);
		await expect(
			caller.updateDomainRestriction({
				domainRestrictionConfig: { enabled: true, allowedWildcards: [] },
			}),
		).resolves.toBe(true);
		await expect(caller.readStats()).resolves.toEqual([]);
		await expect(caller.readStatsLogs({})).resolves.toEqual({
			data: [],
			totalCount: 0,
		});

		expect(mocks.isRootOrganization).not.toHaveBeenCalled();
		expect(mocks.updateWebServerSettings).not.toHaveBeenCalled();
	});

	it("keeps answering that the self-hosted settings are not available", async () => {
		const notAvailable = { code: "BAD_REQUEST" };
		await expect(
			caller.updateRemoteServersOnly({ remoteServersOnly: true }),
		).rejects.toMatchObject(notAvailable);
		await expect(
			caller.updateBuildsConcurrency({ buildsConcurrency: 2 }),
		).rejects.toMatchObject(notAvailable);
		await expect(
			caller.updateDeploymentWatchdog({
				enabled: true,
				idleMinutes: 30,
				maxMinutes: 60,
			}),
		).rejects.toMatchObject(notAvailable);
		await expect(
			caller.updateEnforceSSO({ enforceSSO: true }),
		).rejects.toMatchObject(notAvailable);

		expect(mocks.isRootOrganization).not.toHaveBeenCalled();
		expect(mocks.updateWebServerSettings).not.toHaveBeenCalled();
	});
});
