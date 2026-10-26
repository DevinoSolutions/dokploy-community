import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may know the Dokploy host's address: the organization that owns the
 * instance, and any other organization while the instance lets services run on
 * the host (the rule the create routes apply to a service with no server).
 */
const state = vi.hoisted(() => ({ isCloud: false }));

const HOST_IP = "198.51.100.7";
const PUBLIC_IP = "198.51.100.8";
const OWNER_ORG = "org-owner";
const OTHER_ORG = "org-other";

const mocks = vi.hoisted(() => ({
	getWebServerSettings: vi.fn(),
	isRootOrganization: vi.fn(),
	getPublicIpWithFallback: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(() => Promise.resolve()),
}));

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return {
		...actual,
		get IS_CLOUD() {
			return state.isCloud;
		},
		getWebServerSettings: mocks.getWebServerSettings,
		isRootOrganization: mocks.isRootOrganization,
		getPublicIpWithFallback: mocks.getPublicIpWithFallback,
	};
});

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");
const { canUseLocalHostForServices } = await import(
	"@/server/api/utils/local-host-access"
);

const createCaller = createCallerFactory(appRouter);

const callerIn = (organizationId: string) =>
	createCaller({
		user: {
			id: "user-1",
			email: "user@example.com",
			role: "owner",
			ownerId: "user-1",
		},
		session: { activeOrganizationId: organizationId },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

const instance = (remoteServersOnly: boolean) =>
	mocks.getWebServerSettings.mockResolvedValue({
		id: "settings-1",
		serverIp: HOST_IP,
		remoteServersOnly,
	});

beforeEach(() => {
	vi.clearAllMocks();
	state.isCloud = false;
	instance(false);
	mocks.getPublicIpWithFallback.mockResolvedValue(PUBLIC_IP);
	mocks.isRootOrganization.mockImplementation(
		async (organizationId: string) => organizationId === OWNER_ORG,
	);
});

describe("canUseLocalHostForServices", () => {
	it("is true for the organization that owns the instance, even when it is remote servers only", async () => {
		instance(true);

		await expect(canUseLocalHostForServices(OWNER_ORG)).resolves.toBe(true);
	});

	it("is true for another organization while services may run on the host", async () => {
		await expect(canUseLocalHostForServices(OTHER_ORG)).resolves.toBe(true);
	});

	it("is false for another organization when the instance is remote servers only", async () => {
		instance(true);

		await expect(canUseLocalHostForServices(OTHER_ORG)).resolves.toBe(false);
	});

	it("is false without an organization", async () => {
		await expect(canUseLocalHostForServices(undefined)).resolves.toBe(false);
		await expect(canUseLocalHostForServices(null)).resolves.toBe(false);
	});

	it("is false on cloud, which has no host", async () => {
		state.isCloud = true;

		await expect(canUseLocalHostForServices(OWNER_ORG)).resolves.toBe(false);
	});

	it("does not read the settings for the owner", async () => {
		await canUseLocalHostForServices(OWNER_ORG);

		expect(mocks.getWebServerSettings).not.toHaveBeenCalled();
	});
});

describe("settings.getIp", () => {
	it("gives the owner the address, even when remote servers only", async () => {
		instance(true);

		await expect(callerIn(OWNER_ORG).settings.getIp()).resolves.toBe(HOST_IP);
	});

	it("gives another organization the address while services may run on the host", async () => {
		await expect(callerIn(OTHER_ORG).settings.getIp()).resolves.toBe(HOST_IP);
	});

	it("gives another organization an empty address when remote servers only", async () => {
		instance(true);

		await expect(callerIn(OTHER_ORG).settings.getIp()).resolves.toBe("");
	});

	it("is empty on cloud", async () => {
		state.isCloud = true;

		await expect(callerIn(OTHER_ORG).settings.getIp()).resolves.toBe("");
	});
});

describe("server.publicIp", () => {
	it("gives the owner the address, even when remote servers only", async () => {
		instance(true);

		await expect(callerIn(OWNER_ORG).server.publicIp()).resolves.toBe(
			PUBLIC_IP,
		);
	});

	it("gives another organization the address while services may run on the host", async () => {
		await expect(callerIn(OTHER_ORG).server.publicIp()).resolves.toBe(
			PUBLIC_IP,
		);
	});

	it("gives another organization nothing, and looks nothing up, when remote servers only", async () => {
		instance(true);

		await expect(callerIn(OTHER_ORG).server.publicIp()).resolves.toBeNull();
		expect(mocks.getPublicIpWithFallback).not.toHaveBeenCalled();
	});

	it("is empty on cloud", async () => {
		state.isCloud = true;

		await expect(callerIn(OTHER_ORG).server.publicIp()).resolves.toBe("");
	});
});
