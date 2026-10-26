import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ isCloud: false }));

const SSH_KEY = "-----BEGIN FAKE KEY-----fake-----END FAKE KEY-----";
const TOKEN = "fake-metrics-token";

const mocks = vi.hoisted(() => ({
	getWebServerSettings: vi.fn(),
	updateWebServerSettings: vi.fn(),
	setupWebMonitoring: vi.fn(async () => undefined),
	isRootOrganization: vi.fn(),
	updateServerTraefik: vi.fn(),
	updateLetsEncryptEmail: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	get IS_CLOUD() {
		return state.isCloud;
	},
	getWebServerSettings: mocks.getWebServerSettings,
	updateWebServerSettings: mocks.updateWebServerSettings,
	setupWebMonitoring: mocks.setupWebMonitoring,
	isRootOrganization: mocks.isRootOrganization,
	updateServerTraefik: mocks.updateServerTraefik,
	updateLetsEncryptEmail: mocks.updateLetsEncryptEmail,
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
const { adminRouter } = await import("@/server/api/routers/admin");

const ROOT_ORG = "org-root";
const OTHER_ORG = "org-other";

const ctxAs = (role: string, organizationId: string) =>
	({
		session: { activeOrganizationId: organizationId },
		user: { id: "user-1", email: "user@example.com", role },
	}) as Parameters<typeof settingsRouter.createCaller>[0];

const settingsAs = (role: string, organizationId: string) =>
	settingsRouter.createCaller(ctxAs(role, organizationId));

const settingsRow = (overrides: Record<string, unknown> = {}) => ({
	id: "settings-1",
	serverIp: "10.0.0.1",
	host: "dokploy.example.com",
	sshPrivateKey: SSH_KEY,
	metricsConfig: {
		server: {
			type: "Dokploy",
			refreshRate: 60,
			port: 4500,
			token: TOKEN,
			urlCallback: "https://dokploy.example.com/callback",
			retentionDays: 2,
			cronJob: "0 0 * * *",
			thresholds: { cpu: 0, memory: 0 },
		},
		containers: {
			refreshRate: 60,
			services: { include: [], exclude: [] },
		},
	},
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	state.isCloud = false;
	mocks.getWebServerSettings.mockResolvedValue(settingsRow());
	mocks.isRootOrganization.mockImplementation(
		async (organizationId: string) => organizationId === ROOT_ORG,
	);
});

describe("settings.getWebServerSettings", () => {
	it.each([
		["a member of the root organization", "member", ROOT_ORG],
		["a member of another organization", "member", OTHER_ORG],
		["an admin of another organization", "admin", OTHER_ORG],
		["an owner of another organization", "owner", OTHER_ORG],
		["a member with a custom role", "support", ROOT_ORG],
	])(
		"never returns the SSH key or the token to %s",
		async (_who, role, org) => {
			const result = await settingsAs(role, org).getWebServerSettings();

			expect(result).not.toHaveProperty("sshPrivateKey");
			expect(result?.metricsConfig.server.token).toBe("");
			expect(JSON.stringify(result)).not.toContain(SSH_KEY);
			expect(JSON.stringify(result)).not.toContain(TOKEN);
		},
	);

	it.each(["owner", "admin"])(
		"gives the token, but never the SSH key, to the root organization's %s",
		async (role) => {
			const result = await settingsAs(role, ROOT_ORG).getWebServerSettings();

			expect(result?.metricsConfig.server.token).toBe(TOKEN);
			expect(result).not.toHaveProperty("sshPrivateKey");
			expect(JSON.stringify(result)).not.toContain(SSH_KEY);
		},
	);

	it("keeps the rest of the row", async () => {
		const result = await settingsAs("member", OTHER_ORG).getWebServerSettings();

		expect(result).toMatchObject({
			id: "settings-1",
			serverIp: "10.0.0.1",
			host: "dokploy.example.com",
		});
		expect(result?.metricsConfig.server).toMatchObject({
			port: 4500,
			refreshRate: 60,
		});
		expect(result?.metricsConfig.containers.refreshRate).toBe(60);
	});

	it("says whether the instance has an SSH key", async () => {
		await expect(
			settingsAs("member", OTHER_ORG).getWebServerSettings(),
		).resolves.toMatchObject({ hasSSHPrivateKey: true });

		mocks.getWebServerSettings.mockResolvedValue(
			settingsRow({ sshPrivateKey: null }),
		);
		await expect(
			settingsAs("member", OTHER_ORG).getWebServerSettings(),
		).resolves.toMatchObject({ hasSSHPrivateKey: false });
	});

	it("does not touch the stored row", async () => {
		const row = settingsRow();
		mocks.getWebServerSettings.mockResolvedValue(row);

		await settingsAs("member", OTHER_ORG).getWebServerSettings();

		expect(row.sshPrivateKey).toBe(SSH_KEY);
		expect(row.metricsConfig.server.token).toBe(TOKEN);
	});

	it("returns null on cloud", async () => {
		state.isCloud = true;

		await expect(
			settingsAs("owner", ROOT_ORG).getWebServerSettings(),
		).resolves.toBeNull();
		expect(mocks.getWebServerSettings).not.toHaveBeenCalled();
	});
});

describe("the routes that change what the host connects to", () => {
	const monitoring = (token: string) => ({
		metricsConfig: {
			server: {
				refreshRate: 30,
				port: 4500,
				token,
				urlCallback: "https://dokploy.example.com/callback",
				retentionDays: 5,
				cronJob: "0 0 * * *",
				thresholds: { cpu: 0, memory: 0 },
			},
			containers: { refreshRate: 30, services: { include: [], exclude: [] } },
		},
	});

	const domain = {
		host: "dokploy.example.com",
		letsEncryptEmail: "ops@example.com",
		certificateType: "letsencrypt" as const,
		https: true,
	};

	const routes: [string, (org: string, role?: string) => Promise<unknown>][] = [
		[
			"settings.updateServerIp",
			(org, role = "admin") =>
				settingsAs(role, org).updateServerIp({ serverIp: "203.0.113.9" }),
		],
		[
			"settings.assignDomainServer",
			(org, role = "admin") => settingsAs(role, org).assignDomainServer(domain),
		],
		[
			"admin.setupMonitoring",
			(org, role = "admin") =>
				adminRouter
					.createCaller(ctxAs(role, org))
					.setupMonitoring(monitoring("a-new-token")),
		],
	];

	beforeEach(() => {
		mocks.updateWebServerSettings.mockResolvedValue(settingsRow());
	});

	it.each(routes)(
		"%s refuses an admin of another organization",
		async (_name, call) => {
			await expect(call(OTHER_ORG)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(call(OTHER_ORG, "owner")).rejects.toMatchObject({
				code: "FORBIDDEN",
			});

			expect(mocks.updateWebServerSettings).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s refuses a member of the root organization",
		async (_name, call) => {
			await expect(call(ROOT_ORG, "member")).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});

			expect(mocks.updateWebServerSettings).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s lets the root organization's admin through, without the SSH key in the answer",
		async (_name, call) => {
			const result = await call(ROOT_ORG);

			expect(mocks.updateWebServerSettings).toHaveBeenCalledTimes(1);
			expect(result).not.toHaveProperty("sshPrivateKey");
			expect(JSON.stringify(result)).not.toContain(SSH_KEY);
		},
	);

	it.each(routes)("%s changes nothing on cloud", async (_name, call) => {
		state.isCloud = true;

		await call(OTHER_ORG).catch(() => undefined);

		expect(mocks.updateWebServerSettings).not.toHaveBeenCalled();
	});

	it("admin.setupMonitoring stores the token the root organization's admin sends", async () => {
		await adminRouter
			.createCaller(ctxAs("admin", ROOT_ORG))
			.setupMonitoring(monitoring("a-new-token"));

		expect(
			mocks.updateWebServerSettings.mock.calls[0]?.[0].metricsConfig.server
				.token,
		).toBe("a-new-token");
	});
});
