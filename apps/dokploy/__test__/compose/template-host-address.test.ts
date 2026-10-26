import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The domains a compose template generates for a service on the Dokploy host
 * carry the host's address (`<name>-<hash>-<ip>.sslip.io`). Only an
 * organization that may run services on the host gets it; any other gets the
 * loopback address.
 */
const HOST_IP = "198.51.100.7";
const OWNER_ORG = "org-owner";
const OTHER_ORG = "org-other";

const mocks = vi.hoisted(() => ({
	getWebServerSettings: vi.fn(),
	isRootOrganization: vi.fn(),
}));

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return {
		...actual,
		IS_CLOUD: false,
		getWebServerSettings: mocks.getWebServerSettings,
		isRootOrganization: mocks.isRootOrganization,
	};
});

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: vi.fn(), holdIdleGroup: () => ({ release: () => {} }) },
	cleanQueuesByApplication: vi.fn(),
	cleanQueuesByCompose: vi.fn(),
	killDockerBuild: vi.fn(),
}));

const { composeRouter } = await import("@/server/api/routers/compose");

const template = Buffer.from(
	JSON.stringify({
		compose: "services:\n  web:\n    image: nginx\n",
		config: [
			"[variables]",
			'main_domain = "${domain}"',
			"",
			"[config]",
			"[[config.domains]]",
			'serviceName = "web"',
			"port = 80",
			'host = "${main_domain}"',
		].join("\n"),
	}),
).toString("base64");

const previewIn = (organizationId: string) =>
	composeRouter
		.createCaller({
			session: { activeOrganizationId: organizationId, userId: "user-1" },
			user: { id: "user-1", email: "user@example.com", role: "owner" },
		} as never)
		.previewTemplate({ base64: template, appName: "stack" });

const instance = (remoteServersOnly: boolean) =>
	mocks.getWebServerSettings.mockResolvedValue({
		serverIp: HOST_IP,
		remoteServersOnly,
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isRootOrganization.mockImplementation(
		async (organizationId: string) => organizationId === OWNER_ORG,
	);
});

describe("compose.previewTemplate on the Dokploy host", () => {
	it("builds the domains from the host's address for the organization that owns the instance", async () => {
		instance(true);

		const { template } = await previewIn(OWNER_ORG);

		expect(JSON.stringify(template.domains)).toContain("198-51-100-7");
	});

	it("builds them from it for another organization that may run services on the host", async () => {
		instance(false);

		const { template } = await previewIn(OTHER_ORG);

		expect(JSON.stringify(template.domains)).toContain("198-51-100-7");
	});

	it("builds them from the loopback address for another organization when remote servers only", async () => {
		instance(true);

		const { template } = await previewIn(OTHER_ORG);

		expect(JSON.stringify(template)).not.toContain("198-51-100-7");
		expect(JSON.stringify(template)).not.toContain(HOST_IP);
		expect(JSON.stringify(template.domains)).toContain("127-0-0-1");
	});
});
