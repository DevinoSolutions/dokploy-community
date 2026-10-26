import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The same checks as web-server-settings-redact.test.ts, but with the real
 * `isRootOrganization`: only the organization query under it is replaced, so
 * what makes an organization the instance's own is tested too.
 */
const SSH_KEY = "-----BEGIN FAKE KEY-----fake-----END FAKE KEY-----";
const TOKEN = "fake-metrics-token";
const ROOT_ORG = "org-root";
const OTHER_ORG = "org-other";

const mocks = vi.hoisted(() => ({
	getWebServerSettings: vi.fn(),
	updateWebServerSettings: vi.fn(),
	setupWebMonitoring: vi.fn(async () => undefined),
	findUserById: vi.fn(async () => ({ enablePaidFeatures: false })),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(() => Promise.resolve()),
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	return {
		...actual,
		checkPermission: vi.fn(async () => {}),
	};
});

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return {
		...actual,
		IS_CLOUD: false,
		getWebServerSettings: mocks.getWebServerSettings,
		updateWebServerSettings: mocks.updateWebServerSettings,
		setupWebMonitoring: mocks.setupWebMonitoring,
		findUserById: mocks.findUserById,
		updateServerTraefik: vi.fn(),
		updateLetsEncryptEmail: vi.fn(),
	};
});

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");
const { db } = await import("@dokploy/server/db");

const createCaller = createCallerFactory(appRouter);

const callerAs = (role: string, organizationId: string) =>
	createCaller({
		user: { id: "user-1", email: "user@example.com", role, ownerId: "user-1" },
		session: { activeOrganizationId: organizationId },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

const settingsRow = () => ({
	id: "settings-1",
	serverIp: "10.0.0.1",
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
		containers: { refreshRate: 60, services: { include: [], exclude: [] } },
	},
});

const findFirst = vi.spyOn(db.query.organization, "findFirst");

beforeEach(() => {
	vi.clearAllMocks();
	// the oldest organization, which is what the real query asks for
	findFirst.mockResolvedValue({ id: ROOT_ORG } as never);
	mocks.getWebServerSettings.mockResolvedValue(settingsRow());
	mocks.updateWebServerSettings.mockResolvedValue(settingsRow());
});

describe("with the real root organization check", () => {
	it("asks for the first organization created, then the lowest id", async () => {
		await callerAs("admin", ROOT_ORG).settings.getWebServerSettings();

		const [query] = findFirst.mock.calls[0] ?? [];
		const asc = (column: unknown) => ({ asc: column });
		const order = query?.orderBy as unknown as (
			organization: Record<string, string>,
			operators: { asc: typeof asc },
		) => unknown[];
		expect(order({ createdAt: "created", id: "id" }, { asc })).toEqual([
			{ asc: "created" },
			{ asc: "id" },
		]);
	});

	it("settings.getWebServerSettings: the root organization's admin gets the token, nobody gets the key", async () => {
		const result = await callerAs(
			"admin",
			ROOT_ORG,
		).settings.getWebServerSettings();

		expect(result?.metricsConfig.server.token).toBe(TOKEN);
		expect(JSON.stringify(result)).not.toContain(SSH_KEY);
		expect(result).toMatchObject({ hasSSHPrivateKey: true });
	});

	it("settings.getWebServerSettings: another organization's owner gets neither", async () => {
		const result = await callerAs(
			"owner",
			OTHER_ORG,
		).settings.getWebServerSettings();

		expect(JSON.stringify(result)).not.toContain(SSH_KEY);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("settings.getWebServerSettings: no organization at all gets no token", async () => {
		findFirst.mockResolvedValue(undefined as never);

		const result = await callerAs(
			"owner",
			OTHER_ORG,
		).settings.getWebServerSettings();

		expect(result?.metricsConfig.server.token).toBe("");
	});

	it("user.getMetricsToken blanks the token outside the root organization", async () => {
		const result = await callerAs("admin", OTHER_ORG).user.getMetricsToken();

		expect(result.serverIp).toBe("10.0.0.1");
		expect(result.metricsConfig?.server.token).toBe("");
		expect(result.metricsConfig?.server.port).toBe(4500);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("user.getMetricsToken blanks the token for a member of the root organization", async () => {
		const result = await callerAs("member", ROOT_ORG).user.getMetricsToken();

		expect(result.metricsConfig?.server.token).toBe("");
	});

	it("user.getMetricsToken gives the token to the root organization's owner", async () => {
		const result = await callerAs("owner", ROOT_ORG).user.getMetricsToken();

		expect(result.metricsConfig?.server.token).toBe(TOKEN);
	});

	const monitoring = {
		metricsConfig: {
			server: {
				refreshRate: 30,
				port: 4500,
				token: "a-new-token",
				urlCallback: "https://attacker.example.com/hook",
				retentionDays: 5,
				cronJob: "0 0 * * *",
				thresholds: { cpu: 1, memory: 1 },
			},
			containers: { refreshRate: 30, services: { include: [], exclude: [] } },
		},
	};

	const mutations: [string, (org: string) => Promise<unknown>][] = [
		[
			"settings.updateServerIp",
			(org) =>
				callerAs("admin", org).settings.updateServerIp({
					serverIp: "203.0.113.9",
				}),
		],
		[
			"settings.assignDomainServer",
			(org) =>
				callerAs("admin", org).settings.assignDomainServer({
					host: "dokploy.example.com",
					letsEncryptEmail: "ops@example.com",
					certificateType: "letsencrypt",
					https: true,
				}),
		],
		[
			"admin.setupMonitoring",
			(org) => callerAs("admin", org).admin.setupMonitoring(monitoring),
		],
	];

	it.each(mutations)(
		"%s is refused to another organization's admin",
		async (_name, call) => {
			await expect(call(OTHER_ORG)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});

			expect(mocks.updateWebServerSettings).not.toHaveBeenCalled();
			expect(mocks.setupWebMonitoring).not.toHaveBeenCalled();
		},
	);

	it.each(mutations)(
		"%s works for the root organization's admin",
		async (_name, call) => {
			await expect(call(ROOT_ORG)).resolves.not.toHaveProperty("sshPrivateKey");

			expect(mocks.updateWebServerSettings).toHaveBeenCalledTimes(1);
		},
	);
});
