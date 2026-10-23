import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

// The container terminal and the container logs viewer both reach a container
// by a client-supplied id. Service access alone must not be enough: the
// handlers must check the container belongs to the service, and only after the
// organization and cloud gates, because that check runs `docker inspect` on the
// target host.

const state = vi.hoisted(() => ({ isCloud: false }));
const mockFindServerById = vi.hoisted(() => vi.fn());
const mockOwnership = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockSpawnPty = vi.hoisted(() => vi.fn());
const mockSshConnect = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server", () => ({
	get IS_CLOUD() {
		return state.isCloud;
	},
	findServerById: mockFindServerById,
	validateRequest: vi.fn(async () => ({
		user: { id: "user-1" },
		session: { activeOrganizationId: "org-1" },
	})),
	reportUnexpectedError: vi.fn(),
	execAsync: vi.fn(),
	paths: vi.fn(),
}));
vi.mock("@/server/wss/authorize", () => ({
	canAccessDockerOverWss: vi.fn(async () => true),
}));
vi.mock("@/server/wss/container-ownership", () => ({
	containerBelongsToService: mockOwnership,
}));
vi.mock("node-pty", () => ({ spawn: mockSpawnPty }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: mockSpawn,
}));
vi.mock("ssh2", () => ({
	Client: class extends EventEmitter {
		connect = mockSshConnect;
		end = vi.fn();
	},
}));

import { setupDockerContainerLogsWebSocketServer } from "@/server/wss/docker-container-logs";
import { setupDockerContainerTerminalWebSocketServer } from "@/server/wss/docker-container-terminal";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fakePty = () => ({
	onData: vi.fn(),
	onExit: vi.fn(),
	kill: vi.fn(),
	write: vi.fn(),
	resize: vi.fn(),
});

const fakeChild = () => {
	const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	child.exitCode = null;
	child.signalCode = null;
	return child;
};

const handlers = [
	{
		name: "container terminal",
		path: "/docker-container-terminal",
		setup: setupDockerContainerTerminalWebSocketServer,
		// What the handler starts once every gate has passed.
		started: () => mockSpawnPty.mock.calls.length,
	},
	{
		name: "container logs",
		path: "/docker-container-logs",
		setup: setupDockerContainerLogsWebSocketServer,
		started: () => mockSpawn.mock.calls.length,
	},
] as const;

describe.each(handlers)("$name", ({ path, setup, started }) => {
	let server: http.Server;
	let port: number;
	const sockets: WebSocket[] = [];

	const open = async (query: Record<string, string>) => {
		const ws = new WebSocket(
			`ws://127.0.0.1:${port}${path}?${new URLSearchParams(query)}`,
		);
		sockets.push(ws);
		const closed = new Promise<number>((r) =>
			ws.once("close", (code) => r(code)),
		);
		await new Promise((r) => ws.once("open", r));
		return { ws, closed };
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		state.isCloud = false;
		mockOwnership.mockResolvedValue(true);
		mockSpawnPty.mockImplementation(fakePty);
		mockSpawn.mockImplementation(fakeChild);
		server = http.createServer();
		setup(server);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		port = (server.address() as AddressInfo).port;
	});

	afterEach(async () => {
		for (const ws of sockets.splice(0)) ws.terminate();
		await new Promise((r) => server.close(r));
	});

	it("closes 4003 and starts nothing for a container of another service", async () => {
		mockOwnership.mockResolvedValue(false);
		const { ws, closed } = await open({
			containerId: "other",
			serviceId: "svc",
		});
		ws.send("input");

		expect(await closed).toBe(4003);
		await wait(100);
		expect(mockOwnership).toHaveBeenCalledWith("svc", "other", null);
		expect(started()).toBe(0);
		expect(mockSpawnPty).not.toHaveBeenCalled();
	});

	it("starts for a container of the service", async () => {
		await open({ containerId: "mine", serviceId: "svc" });
		await wait(150);

		expect(mockOwnership).toHaveBeenCalledWith("svc", "mine", null);
		expect(started()).toBe(1);
	});

	it("does not check ownership without a service", async () => {
		await open({ containerId: "any" });
		await wait(150);

		expect(mockOwnership).not.toHaveBeenCalled();
		expect(started()).toBe(1);
	});

	it("rejects another organization's server before any container lookup", async () => {
		mockFindServerById.mockResolvedValue({
			serverId: "srv-1",
			organizationId: "org-other",
			sshKeyId: "key",
		});
		const { closed } = await open({
			containerId: "c1",
			serviceId: "svc",
			serverId: "srv-1",
		});

		expect(await closed).toBe(1005);
		await wait(100);
		expect(mockFindServerById).toHaveBeenCalledWith("srv-1");
		expect(mockOwnership).not.toHaveBeenCalled();
		expect(mockSshConnect).not.toHaveBeenCalled();
	});

	it("checks ownership against the server for an own-organization server", async () => {
		mockFindServerById.mockResolvedValue({
			serverId: "srv-1",
			organizationId: "org-1",
			sshKeyId: "key",
		});
		await open({ containerId: "c1", serviceId: "svc", serverId: "srv-1" });
		await wait(150);

		expect(mockOwnership).toHaveBeenCalledWith("svc", "c1", "srv-1");
		expect(mockSshConnect).toHaveBeenCalled();
	});

	it("does not look up containers locally on the cloud control plane", async () => {
		state.isCloud = true;
		const { closed } = await open({ containerId: "c1", serviceId: "svc" });

		await closed;
		await wait(100);
		expect(mockOwnership).not.toHaveBeenCalled();
		expect(started()).toBe(0);
	});
});
