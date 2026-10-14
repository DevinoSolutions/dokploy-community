import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `beforeExec` is the last look before a command is sent over an open
 * connection: when it throws, the command is never sent.
 */

const ssh = vi.hoisted(() => ({
	clients: [] as any[],
	onExec: (_channel: any) => {},
	// What conn.exec throws, like ssh2 does on a connection that is gone.
	execThrows: null as Error | null,
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
			if (ssh.execThrows) throw ssh.execThrows;
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
	ssh.execThrows = null;
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

	it("rejects once, without an unhandled rejection, when the connection dropped while the check was pending", async () => {
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		ssh.execThrows = new Error("Not connected");
		try {
			await expect(
				execAsyncRemote("server-1", "echo hi", undefined, {
					beforeExec: async () => {
						await new Promise((resolve) => setImmediate(resolve));
					},
				}),
			).rejects.toThrow("Not connected");
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off("unhandledRejection", unhandled);
		}

		expect(unhandled).not.toHaveBeenCalled();
		expect(ssh.clients[0].calls).toEqual(["end"]);
	});

	it("rejects once, destroys the connection and never sends the command when aborted while the check is pending", async () => {
		const controller = new AbortController();
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		let finishCheck: () => void = () => {};
		const pending = new Promise<void>((resolve) => {
			finishCheck = resolve;
		});
		try {
			const call = execAsyncRemote("server-1", "echo hi", undefined, {
				signal: controller.signal,
				beforeExec: () => pending,
			});
			const settled = expect(call).rejects.toThrow("aborted");
			await vi.waitFor(() => expect(ssh.clients).toHaveLength(1));
			await new Promise((resolve) => setImmediate(resolve));

			controller.abort();
			await settled;
			// The check finishes afterwards: nothing more happens.
			finishCheck();
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off("unhandledRejection", unhandled);
		}

		expect(ssh.clients[0].execs).toEqual([]);
		expect(ssh.clients[0].calls).toEqual(["destroy"]);
		expect(unhandled).not.toHaveBeenCalled();
	});

	it("is not involved when it is not given", async () => {
		await execAsyncRemote("server-1", "echo hi");

		expect(ssh.clients[0].execs).toEqual(["echo hi"]);
	});
});
