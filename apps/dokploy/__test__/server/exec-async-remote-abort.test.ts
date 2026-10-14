import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A caller that stops waiting on a remote command (a log probe that timed out)
 * aborts it: the SSH connection is destroyed, not left to end by itself.
 */

const ssh = vi.hoisted(() => ({
	clients: [] as any[],
	// Whether the fake host ever answers the handshake.
	answers: false,
	onExec: (_channel: any) => {},
}));

vi.mock("ssh2", async () => {
	const { EventEmitter } = await import("node:events");

	class FakeChannel extends EventEmitter {
		stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
		setEncoding() {}
	}

	class Client extends EventEmitter {
		calls: string[] = [];
		execs = 0;
		connect() {
			ssh.clients.push(this);
			if (ssh.answers) queueMicrotask(() => this.emit("ready"));
			return this;
		}
		exec(_command: string, callback: (err: Error | undefined, ch: any) => void) {
			this.execs++;
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

const connected = async () => {
	await vi.waitFor(() => expect(ssh.clients).toHaveLength(1));
	return ssh.clients[0];
};

beforeEach(() => {
	ssh.clients = [];
	ssh.answers = false;
	ssh.onExec = () => {};
});

describe("execAsyncRemote with an abort signal", () => {
	it("destroys the connection of a host that never answers, and rejects", async () => {
		const controller = new AbortController();
		const pending = execAsyncRemote("server-1", "test -f /x", undefined, {
			signal: controller.signal,
		});
		const settled = expect(pending).rejects.toThrow("aborted");
		const conn = await connected();

		controller.abort();

		await settled;
		expect(conn.calls).toEqual(["destroy"]);
	});

	it("survives errors the dying connection emits afterwards", async () => {
		const controller = new AbortController();
		const pending = execAsyncRemote("server-1", "test -f /x", undefined, {
			signal: controller.signal,
		});
		const settled = expect(pending).rejects.toThrow("aborted");
		const conn = await connected();

		controller.abort();
		await settled;

		// An unhandled "error" event on an EventEmitter would throw here.
		expect(() => conn.emit("error", new Error("read ECONNRESET"))).not.toThrow();
		expect(conn.execs).toBe(0);
	});

	it("does not run the command when the connection comes up after the abort", async () => {
		const controller = new AbortController();
		const pending = execAsyncRemote("server-1", "test -f /x", undefined, {
			signal: controller.signal,
		});
		const settled = expect(pending).rejects.toThrow("aborted");
		const conn = await connected();

		controller.abort();
		conn.emit("ready");
		await settled;

		expect(conn.execs).toBe(0);
	});

	it("never connects when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			execAsyncRemote("server-1", "test -f /x", undefined, {
				signal: controller.signal,
			}),
		).rejects.toThrow("aborted");
		expect(ssh.clients).toHaveLength(0);
	});

	it("leaves a command that finished alone: a later abort drops nothing", async () => {
		ssh.answers = true;
		ssh.onExec = (channel) => queueMicrotask(() => channel.emit("close", 0));
		const controller = new AbortController();

		await execAsyncRemote("server-1", "test -f /x", undefined, {
			signal: controller.signal,
		});
		controller.abort();

		expect(ssh.clients[0].calls).toEqual(["end"]);
	});
});
