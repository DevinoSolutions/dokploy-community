import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

const mockValidateRequest = vi.hoisted(() => vi.fn());
const mockGetHostSystemStats = vi.hoisted(() => vi.fn());
const mockRecordAdvancedStats = vi.hoisted(() => vi.fn());
const mockListContainers = vi.hoisted(() => vi.fn());
vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	validateRequest: mockValidateRequest,
	getHostSystemStats: mockGetHostSystemStats,
	recordAdvancedStats: mockRecordAdvancedStats,
	getLastAdvancedStatsFile: vi.fn(async () => ({})),
	docker: { listContainers: mockListContainers },
	execAsync: vi.fn(),
}));
const mockCanAccessDockerOverWss = vi.hoisted(() => vi.fn());
const mockFindServiceAppName = vi.hoisted(() => vi.fn());
const mockIsOtherServiceAppName = vi.hoisted(() => vi.fn());
vi.mock("@/server/wss/authorize", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/server/wss/authorize")>()),
	canAccessDockerOverWss: mockCanAccessDockerOverWss,
}));
vi.mock("@/server/wss/container-ownership", () => ({
	findServiceAppName: mockFindServiceAppName,
	isOtherServiceAppName: mockIsOtherServiceAppName,
}));

import { setupDockerStatsMonitoringSocketServer } from "@/server/wss/docker-stats";

const AUTH = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_INTERVAL = 1300;

let server: http.Server;
let url: string;

beforeEach(async () => {
	vi.clearAllMocks();
	mockGetHostSystemStats.mockResolvedValue({});
	mockCanAccessDockerOverWss.mockResolvedValue(true);
	mockListContainers.mockResolvedValue([]);
	mockIsOtherServiceAppName.mockResolvedValue(false);
	server = http.createServer();
	setupDockerStatsMonitoringSocketServer(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	url = `ws://127.0.0.1:${port}/listen-docker-stats-monitoring?appName=dokploy`;
});

afterEach(async () => {
	await new Promise((r) => server.close(r));
});

const connect = async () => {
	const ws = new WebSocket(url);
	await new Promise((r) => ws.once("open", r));
	return ws;
};

const closeClient = async (ws: WebSocket) => {
	ws.close();
	await new Promise((r) => ws.once("close", r));
	await wait(50);
};

describe("docker stats websocket (#5504)", () => {
	it("stops polling when the client disconnects", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		const ws = await connect();
		await wait(POLL_INTERVAL + 200);
		expect(mockRecordAdvancedStats).toHaveBeenCalledTimes(1);

		await closeClient(ws);
		await wait(POLL_INTERVAL + 200);
		expect(mockRecordAdvancedStats).toHaveBeenCalledTimes(1);
	});

	it("does not start polling when the client disconnects during auth", async () => {
		const auth = deferred<typeof AUTH>();
		mockValidateRequest.mockReturnValue(auth.promise);
		const ws = await connect();

		await closeClient(ws);
		auth.resolve(AUTH);
		await wait(POLL_INTERVAL + 200);

		expect(mockRecordAdvancedStats).not.toHaveBeenCalled();
	});

	it("does not start polling when the client disconnects during the permission check", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		const access = deferred<boolean>();
		mockCanAccessDockerOverWss.mockReturnValue(access.promise);
		const ws = await connect();

		await closeClient(ws);
		access.resolve(true);
		await wait(POLL_INTERVAL + 200);

		expect(mockRecordAdvancedStats).not.toHaveBeenCalled();
	});
});

describe("docker stats websocket scoped to a service", () => {
	const connectTo = async (query: string) => {
		const base = url.split("?")[0];
		const ws = new WebSocket(`${base}?${query}`);
		const closed = new Promise<{ code: number; reason: string }>((r) =>
			ws.once("close", (code, reason) =>
				r({ code, reason: reason.toString() }),
			),
		);
		return { ws, closed };
	};

	it("rejects a service id that matches no service", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		mockFindServiceAppName.mockResolvedValue(null);
		const { closed } = await connectTo("appName=web-abc&serviceId=nope");

		expect((await closed).code).toBe(4003);
		await wait(POLL_INTERVAL + 200);
		expect(mockRecordAdvancedStats).not.toHaveBeenCalled();
	});

	it("rejects another service's container name", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		mockFindServiceAppName.mockResolvedValue("web-abc");
		const { closed } = await connectTo(
			"appName=other-xyz&appType=application&serviceId=svc-1",
		);

		expect((await closed).code).toBe(4003);
		expect(mockListContainers).not.toHaveBeenCalled();
	});

	it("never serves the host stats to a service-scoped socket", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		mockFindServiceAppName.mockResolvedValue("web-abc");
		const { closed } = await connectTo(
			"appName=dokploy&appType=application&serviceId=svc-1",
		);

		expect((await closed).code).toBe(4003);
		await wait(POLL_INTERVAL + 200);
		expect(mockGetHostSystemStats).not.toHaveBeenCalled();
		expect(mockRecordAdvancedStats).not.toHaveBeenCalled();
	});

	it("filters compose containers by the service's project label", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		mockFindServiceAppName.mockResolvedValue("compose-abc");
		const { ws } = await connectTo(
			"appName=custom-name&appType=docker-compose&serviceId=svc-1",
		);
		await wait(POLL_INTERVAL + 200);

		expect(mockListContainers).toHaveBeenCalled();
		const filters = JSON.parse(mockListContainers.mock.calls[0]?.[0].filters);
		expect(filters.label).toEqual(["com.docker.compose.project=compose-abc"]);
		expect(filters.name).toEqual(["^/custom-name$"]);
		ws.close();
	});

	it("matches the compose container name exactly, escaping regex characters", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		mockFindServiceAppName.mockResolvedValue("compose-abc");
		const { ws } = await connectTo(
			"appName=compose-abc-web.1&appType=docker-compose&serviceId=svc-1",
		);
		await wait(POLL_INTERVAL + 200);

		const filters = JSON.parse(mockListContainers.mock.calls[0]?.[0].filters);
		expect(filters.name).toEqual(["^/compose-abc-web\\.1$"]);
		const nameFilter = new RegExp(filters.name[0]);
		expect(nameFilter.test("/compose-abc-web.1")).toBe(true);
		expect(nameFilter.test("/compose-abc-webX1")).toBe(false);
		expect(nameFilter.test("/other-compose-abc-web.1")).toBe(false);
		expect(nameFilter.test("/compose-abc-web.1-x")).toBe(false);
		ws.close();
	});

	it("rejects a compose container name that is another service's appName", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		mockFindServiceAppName.mockResolvedValue("compose-abc");
		mockIsOtherServiceAppName.mockResolvedValue(true);
		const { closed } = await connectTo(
			"appName=app-victim-xyz789&appType=docker-compose&serviceId=svc-1",
		);

		expect((await closed).code).toBe(4003);
		expect(mockIsOtherServiceAppName).toHaveBeenCalledWith(
			"app-victim-xyz789",
			"svc-1",
			undefined,
		);
		await wait(POLL_INTERVAL + 200);
		expect(mockListContainers).not.toHaveBeenCalled();
		expect(mockRecordAdvancedStats).not.toHaveBeenCalled();
	});

	it.each(["compose-abc-web-1", "compose-abc_web_1"])(
		"accepts the compose project container name %s, ignoring only the project's own prefix in the lookup",
		async (appName) => {
			mockValidateRequest.mockResolvedValue(AUTH);
			mockFindServiceAppName.mockResolvedValue("compose-abc");
			const { ws } = await connectTo(
				`appName=${appName}&appType=docker-compose&serviceId=svc-1`,
			);
			await wait(POLL_INTERVAL + 200);

			expect(mockIsOtherServiceAppName).toHaveBeenCalledWith(
				appName,
				"svc-1",
				"compose-abc",
			);
			expect(mockListContainers).toHaveBeenCalled();
			ws.close();
		},
	);

	it("refuses a project-form name that extends another service's appName", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		mockFindServiceAppName.mockResolvedValue("compose-abc");
		mockIsOtherServiceAppName.mockResolvedValue(true);
		const { closed } = await connectTo(
			"appName=compose-abc-web-1&appType=docker-compose&serviceId=svc-1",
		);

		expect((await closed).code).toBe(4003);
		await wait(POLL_INTERVAL + 200);
		expect(mockListContainers).not.toHaveBeenCalled();
		expect(mockRecordAdvancedStats).not.toHaveBeenCalled();
	});

	it("does not treat a lookalike of the project name as the project prefix", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		mockFindServiceAppName.mockResolvedValue("compose-abc");
		mockIsOtherServiceAppName.mockResolvedValue(true);
		const { closed } = await connectTo(
			"appName=compose-abcdef&appType=docker-compose&serviceId=svc-1",
		);

		expect((await closed).code).toBe(4003);
		expect(mockIsOtherServiceAppName).toHaveBeenCalledWith(
			"compose-abcdef",
			"svc-1",
			undefined,
		);
	});

	it.each(["dokploy", "dokploy-Xk3j2h1g0f9e8", "dokploy-"])(
		"never lets a scoped compose socket record into the host bucket %s",
		async (appName) => {
			mockValidateRequest.mockResolvedValue(AUTH);
			mockFindServiceAppName.mockResolvedValue("compose-abc");
			const { closed } = await connectTo(
				`appName=${appName}&appType=docker-compose&serviceId=svc-1`,
			);

			expect((await closed).code).toBe(4003);
			await wait(POLL_INTERVAL + 200);
			expect(mockListContainers).not.toHaveBeenCalled();
			expect(mockRecordAdvancedStats).not.toHaveBeenCalled();
		},
	);

	it("still serves a compose project whose own appName starts with dokploy-", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		mockFindServiceAppName.mockResolvedValue("dokploy-test-abc123");
		const { ws } = await connectTo(
			"appName=dokploy-test-abc123-web-1&appType=docker-compose&serviceId=svc-1",
		);
		await wait(POLL_INTERVAL + 200);

		expect(mockListContainers).toHaveBeenCalled();
		ws.close();
	});

	it.each(["..", ".", "../../etc", "a/b", "a%00b"])(
		"rejects the unsafe appName %j before anything is recorded",
		async (appName) => {
			mockValidateRequest.mockResolvedValue(AUTH);
			mockFindServiceAppName.mockResolvedValue("compose-abc");
			const { closed } = await connectTo(
				`appName=${encodeURIComponent(appName)}&appType=docker-compose&serviceId=svc-1`,
			);

			expect((await closed).code).toBe(4000);
			await wait(POLL_INTERVAL + 200);
			expect(mockListContainers).not.toHaveBeenCalled();
			expect(mockRecordAdvancedStats).not.toHaveBeenCalled();
		},
	);

	it("rejects an unsafe appName without a service too", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		const { closed } = await connectTo("appName=..&appType=application");

		expect((await closed).code).toBe(4000);
		expect(mockCanAccessDockerOverWss).not.toHaveBeenCalled();
	});
});
