import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

// The container terminal and the container logs viewer both reach a container
// by a client-supplied name or id. Service access alone must not be enough: the
// handlers resolve the string to ONE full id with its ownership check, with or
// without a serviceId, only after the organization and cloud gates (the check
// runs `docker inspect` on the target host), and run exec, logs and attach on
// that full id, never on the string.

const state = vi.hoisted(() => ({ isCloud: false }));
const mockFindServerById = vi.hoisted(() => vi.fn());
const mockResolve = vi.hoisted(() => vi.fn());
const FULL_ID = "a".repeat(64);
const mockSpawn = vi.hoisted(() => vi.fn());
const mockSpawnPty = vi.hoisted(() => vi.fn());
const mockSshConnect = vi.hoisted(() => vi.fn());
const mockSshExec = vi.hoisted(() => vi.fn());

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
vi.mock("@/server/wss/resolve-container", () => ({
	resolveDockerTarget: mockResolve,
}));
vi.mock("node-pty", () => ({ spawn: mockSpawnPty }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: mockSpawn,
}));
vi.mock("ssh2", () => ({
	Client: class extends EventEmitter {
		connect = mockSshConnect;
		exec = mockSshExec;
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
		// Arguments of the docker command the local branch spawned.
		localArgs: () => (mockSpawnPty.mock.calls[0]?.[1] ?? []) as string[],
	},
	{
		name: "container logs",
		path: "/docker-container-logs",
		setup: setupDockerContainerLogsWebSocketServer,
		started: () => mockSpawn.mock.calls.length,
		localArgs: () => (mockSpawn.mock.calls[0]?.[1] ?? []) as string[],
	},
] as const;

describe.each(handlers)("$name", ({ path, setup, started, localArgs }) => {
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
		mockResolve.mockResolvedValue(FULL_ID);
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

	it("closes 4003 and starts nothing for a container that does not resolve", async () => {
		mockResolve.mockResolvedValue(null);
		const { ws, closed } = await open({
			containerId: "other",
			serviceId: "svc",
		});
		ws.send("input");

		expect(await closed).toBe(4003);
		await wait(100);
		expect(mockResolve).toHaveBeenCalledWith(
			expect.objectContaining({
				reference: "other",
				serviceId: "svc",
				serverId: null,
			}),
		);
		expect(started()).toBe(0);
		expect(mockSpawnPty).not.toHaveBeenCalled();
	});

	it("runs on the full id the check resolved, not on the string sent", async () => {
		await open({ containerId: "mine", serviceId: "svc" });
		await wait(150);

		expect(mockResolve).toHaveBeenCalledWith(
			expect.objectContaining({ reference: "mine", serviceId: "svc" }),
		);
		expect(started()).toBe(1);
		expect(localArgs()).toContain(FULL_ID);
		expect(localArgs()).not.toContain("mine");
	});

	it("resolves and refuses without a service too", async () => {
		mockResolve.mockResolvedValue(null);
		const { closed } = await open({ containerId: "dokploy-postgres" });

		expect(await closed).toBe(4003);
		await wait(100);
		expect(mockResolve).toHaveBeenCalledWith(
			expect.objectContaining({
				reference: "dokploy-postgres",
				serviceId: null,
			}),
		);
		expect(started()).toBe(0);
	});

	it("runs on the full id without a service", async () => {
		await open({ containerId: "any" });
		await wait(150);

		expect(mockResolve).toHaveBeenCalledTimes(1);
		expect(started()).toBe(1);
		expect(localArgs()).toContain(FULL_ID);
		expect(localArgs()).not.toContain("any");
	});

	it("rejects another organization server before any container lookup", async () => {
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
		expect(mockResolve).not.toHaveBeenCalled();
		expect(mockSshConnect).not.toHaveBeenCalled();
	});

	it("resolves against the server and runs the full id over ssh for an own-organization server", async () => {
		mockFindServerById.mockResolvedValue({
			serverId: "srv-1",
			organizationId: "org-1",
			sshKeyId: "key",
		});
		mockSshConnect.mockImplementation(function (this: EventEmitter) {
			queueMicrotask(() => this.emit("ready"));
		});
		await open({ containerId: "c1", serviceId: "svc", serverId: "srv-1" });
		await wait(150);

		expect(mockResolve).toHaveBeenCalledWith(
			expect.objectContaining({
				reference: "c1",
				serviceId: "svc",
				serverId: "srv-1",
			}),
		);
		expect(mockSshConnect).toHaveBeenCalled();
		const command = mockSshExec.mock.calls[0]?.[0] as string;
		expect(command).toContain(FULL_ID);
		expect(command.split(" ")).not.toContain("c1");
	});

	it("does not look up containers locally on the cloud control plane", async () => {
		state.isCloud = true;
		const { closed } = await open({ containerId: "c1", serviceId: "svc" });

		await closed;
		await wait(100);
		expect(mockResolve).not.toHaveBeenCalled();
		expect(started()).toBe(0);
	});
});
