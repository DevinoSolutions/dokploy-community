import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wave 3 of the cross-organization id sweep.
 *
 * `withPermission(...)` / `adminProcedure` / `protectedProcedure` only prove the
 * caller holds a role or permission inside their *active* organization. They say
 * nothing about the `serverId` / `aiId` / `environmentId` the caller passes in,
 * so every procedure that turns one of those ids into a Docker call, an SSH
 * exec, an outbound `fetch`, a credential read or a write has to assert the row
 * belongs to the caller's organization first.
 */
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
		checkServiceAccess: vi.fn(async () => {}),
		addNewService: vi.fn(async () => {}),
	};
});

vi.mock("@dokploy/server/services/ai", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/services/ai")>();
	return {
		...actual,
		getAiSettingById: vi.fn(async () => aiRow),
		deleteAiSettings: vi.fn(async () => ({ aiId: "ai-1" })),
		saveAiSettings: vi.fn(async () => ({ aiId: "ai-1" })),
		suggestVariants: vi.fn(async () => ({ suggestions: [] })),
	};
});

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return {
		...actual,
		findServerById: vi.fn(async () => serverRow),
		getWebServerSettings: vi.fn(async () => ({
			serverIp: "10.0.0.1",
			metricsConfig: { server: { port: 4500, token: "local-token" } },
		})),
		findEnvironmentById: vi.fn(async () => ({
			environmentId: "env-1",
			projectId: "project-1",
		})),
		createNetwork: vi.fn(async () => ({ networkId: "net-1", name: "net" })),
		importDockerNetworks: vi.fn(async () => ({ imported: [], errors: [] })),
		findNetworksToSync: vi.fn(async () => []),
		generateTraefikMeDomain: vi.fn(async () => "app.traefik.me"),
		createComposeByTemplate: vi.fn(async () => ({ composeId: "compose-1" })),
	};
});

vi.mock("@dokploy/server/services/project", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/services/project")>();
	return {
		...actual,
		findProjectById: vi.fn(async () => projectRow),
	};
});

vi.mock("@dokploy/server/services/compose", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/services/compose")>();
	return {
		...actual,
		createComposeByTemplate: vi.fn(async () => ({ composeId: "compose-1" })),
	};
});

let serverRow: Record<string, unknown> = {};
let aiRow: Record<string, unknown> = {};
let projectRow: Record<string, unknown> = {};

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");
const {
	createNetwork,
	findNetworksToSync,
	findServerById,
	generateTraefikMeDomain,
	importDockerNetworks,
} = await import("@dokploy/server");
const { deleteAiSettings, saveAiSettings, suggestVariants } = await import(
	"@dokploy/server/services/ai"
);
const { createComposeByTemplate } = await import(
	"@dokploy/server/services/compose"
);

const createCaller = createCallerFactory(appRouter);

const ownerCtx = {
	user: {
		id: "user-1",
		email: "owner@test.com",
		role: "owner",
		ownerId: "user-1",
	},
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never;

const serverInOrganization = (organizationId: string) => {
	serverRow = {
		serverId: "srv-1",
		name: "srv",
		organizationId,
		ipAddress: "203.0.113.10",
		serverType: "build",
		serverStatus: "active",
		defaultDomain: null,
		metricsConfig: { server: { port: 4500, token: "remote-token" } },
	};
	vi.mocked(findServerById).mockResolvedValue(
		serverRow as Awaited<ReturnType<typeof findServerById>>,
	);
};

const aiInOrganization = (organizationId: string) => {
	aiRow = {
		aiId: "ai-1",
		organizationId,
		isEnabled: true,
		name: "provider",
		apiUrl: "https://api.example.com",
		apiKey: "sk-secret",
		model: "gpt",
	};
};

const projectInOrganization = (organizationId: string) => {
	projectRow = {
		projectId: "project-1",
		name: "project",
		organizationId,
	};
};

const fetchMock = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	serverInOrganization("org-1");
	aiInOrganization("org-1");
	projectInOrganization("org-1");
	fetchMock.mockReset();
	fetchMock.mockResolvedValue({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => [{ cpu: "1", timestamp: "now" }],
	});
	vi.stubGlobal("fetch", fetchMock);
});

const crossOrganization = { code: "UNAUTHORIZED" };

describe("network router is organization-scoped", () => {
	it("network.create rejects a serverId from another organization", async () => {
		serverInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.network.create({
				name: "net",
				driver: "overlay",
				serverId: "srv-1",
			} as never),
		).rejects.toMatchObject(crossOrganization);
		expect(createNetwork).not.toHaveBeenCalled();
	});

	it("network.create allows a serverId from the caller's organization", async () => {
		const caller = createCaller(ownerCtx);

		await expect(
			caller.network.create({
				name: "net",
				driver: "overlay",
				serverId: "srv-1",
			} as never),
		).resolves.toMatchObject({ networkId: "net-1" });
		expect(createNetwork).toHaveBeenCalled();
	});

	it("network.import rejects a serverId from another organization", async () => {
		serverInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.network.import({ serverId: "srv-1", names: ["bridge"] }),
		).rejects.toMatchObject(crossOrganization);
		expect(importDockerNetworks).not.toHaveBeenCalled();
	});

	it("network.networksToSync rejects a serverId from another organization", async () => {
		serverInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.network.networksToSync({ serverId: "srv-1" }),
		).rejects.toMatchObject(crossOrganization);
		expect(findNetworksToSync).not.toHaveBeenCalled();
	});

	it("network.networksToSync still works for the local host", async () => {
		const caller = createCaller(ownerCtx);

		await expect(caller.network.networksToSync({})).resolves.toEqual([]);
		expect(findServerById).not.toHaveBeenCalled();
		expect(findNetworksToSync).toHaveBeenCalledWith("org-1", null);
	});
});

describe("domain router is organization-scoped", () => {
	it("domain.generateDomain rejects a serverId from another organization", async () => {
		serverInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.domain.generateDomain({ appName: "app", serverId: "srv-1" }),
		).rejects.toMatchObject(crossOrganization);
		expect(generateTraefikMeDomain).not.toHaveBeenCalled();
	});

	it("domain.generateDomain allows a serverId from the caller's organization", async () => {
		const caller = createCaller(ownerCtx);

		await expect(
			caller.domain.generateDomain({ appName: "app", serverId: "srv-1" }),
		).resolves.toBe("app.traefik.me");
		expect(generateTraefikMeDomain).toHaveBeenCalled();
	});

	it("domain.canGenerateTraefikMeDomains does not leak a foreign server ip", async () => {
		serverInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.domain.canGenerateTraefikMeDomains({ serverId: "srv-1" }),
		).rejects.toMatchObject(crossOrganization);
	});

	it("domain.canGenerateTraefikMeDomains returns the ip for an own server", async () => {
		const caller = createCaller(ownerCtx);

		await expect(
			caller.domain.canGenerateTraefikMeDomains({ serverId: "srv-1" }),
		).resolves.toBe("203.0.113.10");
	});
});

describe("ai router is organization-scoped", () => {
	it("ai.one hides a provider (and its api key) from another organization", async () => {
		aiInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(caller.ai.one({ aiId: "ai-1" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("ai.delete refuses a provider from another organization", async () => {
		aiInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(caller.ai.delete({ aiId: "ai-1" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(deleteAiSettings).not.toHaveBeenCalled();
	});

	it("ai.update refuses to overwrite a provider from another organization", async () => {
		aiInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.ai.update({ aiId: "ai-1", name: "hijacked" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(saveAiSettings).not.toHaveBeenCalled();
	});

	it("ai.suggest refuses a provider from another organization", async () => {
		aiInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.ai.suggest({ aiId: "ai-1", input: "a wordpress site" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(suggestVariants).not.toHaveBeenCalled();
	});

	it("ai.suggest refuses a serverId from another organization", async () => {
		serverInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.ai.suggest({
				aiId: "ai-1",
				input: "a wordpress site",
				serverId: "srv-1",
			}),
		).rejects.toMatchObject(crossOrganization);
		expect(suggestVariants).not.toHaveBeenCalled();
	});

	it("ai.suggest works with an in-organization provider", async () => {
		const caller = createCaller(ownerCtx);

		await expect(
			caller.ai.suggest({ aiId: "ai-1", input: "a wordpress site" }),
		).resolves.toEqual({ suggestions: [] });
		expect(suggestVariants).toHaveBeenCalled();
	});

	it("ai.deploy refuses an environment from another organization", async () => {
		projectInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.ai.deploy({
				id: "suggestion-1",
				name: "app",
				description: "an app",
				environmentId: "env-1",
				dockerCompose: "services: {}",
				envVariables: "",
				domains: [],
				configFiles: [],
			} as never),
		).rejects.toMatchObject(crossOrganization);
		expect(createComposeByTemplate).not.toHaveBeenCalled();
	});

	it("ai.deploy refuses a serverId from another organization", async () => {
		serverInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.ai.deploy({
				id: "suggestion-1",
				name: "app",
				description: "an app",
				environmentId: "env-1",
				serverId: "srv-1",
				dockerCompose: "services: {}",
				envVariables: "",
				domains: [],
				configFiles: [],
			} as never),
		).rejects.toMatchObject(crossOrganization);
		expect(createComposeByTemplate).not.toHaveBeenCalled();
	});

	it("ai.deploy still works when project and server are in the caller's organization", async () => {
		const caller = createCaller(ownerCtx);

		await expect(
			caller.ai.deploy({
				id: "suggestion-1",
				name: "app",
				description: "an app",
				environmentId: "env-1",
				serverId: "srv-1",
				dockerCompose: "services: {}",
				envVariables: "",
				domains: [],
				configFiles: [],
			} as never),
		).resolves.toBeNull();
		expect(createComposeByTemplate).toHaveBeenCalled();
	});
});

describe("server.getDefaultCommand is organization-scoped", () => {
	it("rejects a serverId from another organization", async () => {
		serverInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.server.getDefaultCommand({ serverId: "srv-1" }),
		).rejects.toMatchObject(crossOrganization);
	});

	it("allows a serverId from the caller's organization", async () => {
		const caller = createCaller(ownerCtx);

		await expect(
			caller.server.getDefaultCommand({ serverId: "srv-1" }),
		).resolves.toEqual(expect.any(String));
	});
});

/**
 * The metrics procedures used to `fetch(input.url)` with `input.token`: an
 * authenticated user could aim the Dokploy host at any internal address and
 * read the response back. The URL and token are now derived from the (scoped)
 * server row.
 */
describe("metrics procedures derive their endpoint from the server row", () => {
	it("server.getServerMetrics rejects a serverId from another organization", async () => {
		serverInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.server.getServerMetrics({ serverId: "srv-1", dataPoints: "50" }),
		).rejects.toMatchObject(crossOrganization);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("server.getServerMetrics fetches the stored endpoint with the stored token", async () => {
		const caller = createCaller(ownerCtx);

		await caller.server.getServerMetrics({
			serverId: "srv-1",
			dataPoints: "50",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"http://203.0.113.10:4500/metrics?limit=50",
			{ headers: { Authorization: "Bearer remote-token" } },
		);
	});

	it("user.getContainerMetrics rejects a serverId from another organization", async () => {
		serverInOrganization("org-2");
		const caller = createCaller(ownerCtx);

		await expect(
			caller.user.getContainerMetrics({
				serverId: "srv-1",
				appName: "app",
				dataPoints: "50",
			}),
		).rejects.toMatchObject(crossOrganization);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("user.getContainerMetrics fetches the stored endpoint with the stored token", async () => {
		const caller = createCaller(ownerCtx);

		await caller.user.getContainerMetrics({
			serverId: "srv-1",
			appName: "app",
			dataPoints: "50",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"http://203.0.113.10:4500/metrics/containers?limit=50&appName=app",
			{ headers: { Authorization: "Bearer remote-token" } },
		);
	});

	it("ignores a caller-supplied url/token entirely (SSRF negative control)", async () => {
		const caller = createCaller(ownerCtx);

		await caller.server.getServerMetrics({
			serverId: "srv-1",
			dataPoints: "50",
			url: "http://169.254.169.254/latest/meta-data/",
			token: "attacker-token",
		} as never);

		expect(fetchMock).toHaveBeenCalledWith(
			"http://203.0.113.10:4500/metrics?limit=50",
			{ headers: { Authorization: "Bearer remote-token" } },
		);
		expect(fetchMock).not.toHaveBeenCalledWith(
			expect.stringContaining("169.254.169.254"),
			expect.anything(),
		);
	});
});
