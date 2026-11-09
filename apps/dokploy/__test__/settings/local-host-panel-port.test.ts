import { beforeEach, describe, expect, it, vi } from "vitest";

// Port 3000 of the Dokploy panel belongs to the Dokploy host, so only the
// organization that owns the instance may read or change it. local-host-root-org
// covers the other host actions; these two procedures read the request host
// and publish or close the port.

const mocks = vi.hoisted(() => ({
	isRootOrganization: vi.fn(),
	getWebServerSettings: vi.fn(),
	isPanelPortPublished: vi.fn(),
	isRequestFromPanelHost: vi.fn(),
	togglePanelPort: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	// enterpriseProcedure asks for a licence.
	hasValidLicense: async () => true,
	PANEL_PORT_RECOVERY_COMMAND: "recover",
	...mocks,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
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

const ROOT = "org-root";
const OTHER = "org-other";

const callerIn = (organizationId: string) =>
	settingsRouter.createCaller({
		session: { activeOrganizationId: organizationId },
		user: { id: "user-1", email: "admin@example.com", role: "admin" },
		req: { headers: { host: "panel.example.com" } },
	} as unknown as Parameters<typeof settingsRouter.createCaller>[0]);

describe("the panel port belongs to the organization that owns the instance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isRootOrganization.mockImplementation(
			async (organizationId: string) => organizationId === ROOT,
		);
		mocks.getWebServerSettings.mockResolvedValue({ host: "panel.example.com" });
		mocks.isPanelPortPublished.mockResolvedValue(true);
		mocks.isRequestFromPanelHost.mockReturnValue(true);
		mocks.togglePanelPort.mockResolvedValue(undefined);
	});

	it("getPanelPortStatus refuses an organization that does not own the instance", async () => {
		await expect(callerIn(OTHER).getPanelPortStatus()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("owns this Dokploy instance"),
		});
		expect(mocks.getWebServerSettings).not.toHaveBeenCalled();
		expect(mocks.isPanelPortPublished).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"togglePanelPort(enable: %s) refuses an organization that does not own the instance",
		async (enable) => {
			await expect(
				callerIn(OTHER).togglePanelPort({ enable }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringContaining("owns this Dokploy instance"),
			});
			expect(mocks.togglePanelPort).not.toHaveBeenCalled();
		},
	);

	it("lets the organization that owns the instance through", async () => {
		await expect(callerIn(ROOT).getPanelPortStatus()).resolves.toMatchObject({
			enabled: true,
			panelHost: "panel.example.com",
		});
		await expect(
			callerIn(ROOT).togglePanelPort({ enable: false }),
		).resolves.toBe(true);
		expect(mocks.togglePanelPort).toHaveBeenCalledWith(false);
	});
});
