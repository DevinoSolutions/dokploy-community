import { beforeEach, describe, expect, it, vi } from "vitest";

// Installing or removing the Vector agent without a serverId acts on the
// Dokploy host itself, so only the organization that owns the instance may do
// it. A remote server stays with the organization it belongs to (checked by
// applyVectorAgentSelection, which is mocked here).

const mocks = vi.hoisted(() => ({
	isRootOrganization: vi.fn(),
	applyVectorAgentSelection: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	getWebServerSettings: vi.fn(async () => null),
	PINNED_ROOT_ORGANIZATION_MISSING_HOST_MESSAGE: "pinned root missing",
	findServerById: vi.fn(),
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

const { telemetryProviderRouter } = await import(
	"@/server/api/routers/telemetry-provider"
);

const ROOT = "org-root";
const OTHER = "org-other";

const callerIn = (organizationId: string) =>
	telemetryProviderRouter.createCaller({
		session: { userId: "user-1", activeOrganizationId: organizationId },
		user: { id: "user-1", email: "admin@example.com", role: "admin" },
	} as unknown as Parameters<typeof telemetryProviderRouter.createCaller>[0]);

describe("the Vector agent on the Dokploy host belongs to the organization that owns the instance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isRootOrganization.mockImplementation(
			async (organizationId: string) => organizationId === ROOT,
		);
		mocks.applyVectorAgentSelection.mockResolvedValue({
			serverName: "Dokploy Server (local)",
		});
	});

	it.each([undefined, null])(
		"deployOnServer refuses another organization when serverId is %s",
		async (serverId) => {
			await expect(
				callerIn(OTHER).deployOnServer({ serverId, providerIds: ["p1"] }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringContaining("owns this Dokploy instance"),
			});
			expect(mocks.applyVectorAgentSelection).not.toHaveBeenCalled();
		},
	);

	it.each([undefined, null])(
		"removeOnServer refuses another organization when serverId is %s",
		async (serverId) => {
			await expect(
				callerIn(OTHER).removeOnServer({ serverId }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.applyVectorAgentSelection).not.toHaveBeenCalled();
		},
	);

	it("lets the organization that owns the instance manage the local agent", async () => {
		await expect(
			callerIn(ROOT).deployOnServer({ providerIds: ["p1"] }),
		).resolves.toEqual({ installed: true });
		await expect(callerIn(ROOT).removeOnServer({})).resolves.toEqual({
			installed: false,
		});
		expect(mocks.applyVectorAgentSelection).toHaveBeenCalledTimes(2);
	});

	it("leaves a remote server to applyVectorAgentSelection's own organization check", async () => {
		await expect(
			callerIn(OTHER).deployOnServer({
				serverId: "server-a",
				providerIds: ["p1"],
			}),
		).resolves.toEqual({ installed: true });
		await expect(
			callerIn(OTHER).removeOnServer({ serverId: "server-a" }),
		).resolves.toEqual({ installed: false });
		expect(mocks.isRootOrganization).not.toHaveBeenCalled();
		expect(mocks.applyVectorAgentSelection).toHaveBeenCalledTimes(2);
	});
});
