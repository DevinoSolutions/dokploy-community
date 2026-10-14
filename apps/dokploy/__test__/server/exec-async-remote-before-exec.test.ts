import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `beforeExec` is the last look before a command is sent over an open
 * connection: when it throws, the command is never sent.
 */

const ssh = vi.hoisted(() => ({
	clients: [] as any[],
	onExec: (_channel: any) => {},
}));

vi.mock("ssh2", async () => {
	const { EventEmitter } = await import("node:events");

	class FakeChannel extends EventEmitter {
		stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
		setEncoding() {}
	}

	class Client extends EventEmitter {
		execs: string[] = [];
		calls: string[] = [];
		connect() {
			ssh.clients.push(this);
			queueMicrotask(() => this.emit("ready"));
			return this;
		}
		exec(command: string, callback: (err: Error | undefined, ch: any) => void) {
			this.execs.push(command);
			const channel = new FakeChannel();
			callback(undefined, channel);
			ssh.onExec(channel);
		}
		end() {
			this.calls.push("end");
			this.emit("close");
		}
		destroy() {
			this.calls.push("destroy");
			this.emit("close");
		}
	}

	return { Client };
});

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(async () => ({
		sshKeyId: "key-1",
		ipAddress: "10.0.0.2",
		port: 22,
		username: "root",
		sshKey: { privateKey: "PRIVATE KEY" },
	})),
}));

beforeEach(() => {
	ssh.clients = [];
	ssh.onExec = (channel) => queueMicrotask(() => channel.emit("close", 0));
});

describe("execAsyncRemote with a beforeExec check", () => {
	it("sends the command after the check passes, with the connection already up", async () => {
		const order: string[] = [];
		ssh.onExec = (channel) => {
			order.push("exec");
			queueMicrotask(() => channel.emit("close", 0));
		};

		await execAsyncRemote("server-1", "echo hi", undefined, {
			beforeExec: async () => {
				await new Promise((resolve) => setImmediate(resolve));
				order.push("check");
			},
		});

		expect(order).toEqual(["check", "exec"]);
		expect(ssh.clients[0].execs).toEqual(["echo hi"]);
	});

	it("never sends the command when the check throws, and rejects with that error", async () => {
		const stop = new Error("cancelled before start");

		await expect(
			execAsyncRemote("server-1", "echo hi", undefined, {
				beforeExec: async () => {
					throw stop;
				},
			}),
		).rejects.toBe(stop);

		expect(ssh.clients[0].execs).toEqual([]);
		expect(ssh.clients[0].calls).toEqual(["end"]);
	});

	it("also stops on a check that throws synchronously", async () => {
		await expect(
			execAsyncRemote("server-1", "echo hi", undefined, {
				beforeExec: () => {
					throw new Error("no");
				},
			}),
		).rejects.toThrow("no");

		expect(ssh.clients[0].execs).toEqual([]);
	});

	it("is not involved when it is not given", async () => {
		await execAsyncRemote("server-1", "echo hi");

		expect(ssh.clients[0].execs).toEqual(["echo hi"]);
	});
});
