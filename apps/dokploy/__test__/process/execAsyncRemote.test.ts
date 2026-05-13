import { beforeEach, describe, expect, it, vi } from "vitest";

const ssh = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;
	const instances: FakeClient[] = [];

	class FakeClient {
		private listeners = new Map<string, Listener[]>();
		public command: string | null = null;
		public ended = false;

		on(event: string, cb: Listener) {
			const next = this.listeners.get(event) ?? [];
			next.push(cb);
			this.listeners.set(event, next);
			return this;
		}

		once(event: string, cb: Listener) {
			const wrapper: Listener = (...args) => {
				this.off(event, wrapper);
				cb(...args);
			};
			return this.on(event, wrapper);
		}

		off(event: string, cb: Listener) {
			this.listeners.set(
				event,
				(this.listeners.get(event) ?? []).filter((listener) => listener !== cb),
			);
			return this;
		}

		emit(event: string, ...args: unknown[]) {
			for (const listener of [...(this.listeners.get(event) ?? [])]) {
				listener(...args);
			}
			return true;
		}

		connect() {
			instances.push(this);
			return this;
		}

		exec(command: string) {
			this.command = command;
		}

		end() {
			this.ended = true;
			this.emit("close");
		}
	}

	return { FakeClient, instances };
});

vi.mock("ssh2", () => ({
	Client: ssh.FakeClient,
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(async () => ({
		serverId: "srv-1",
		ipAddress: "127.0.0.1",
		port: 22,
		username: "root",
		sshKeyId: "ssh-key-1",
		sshKey: { privateKey: "test-key" },
	})),
}));

import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";

describe("execAsyncRemote", () => {
	beforeEach(() => {
		ssh.instances.length = 0;
	});

	it("rejects when the SSH connection closes before the remote command stream closes", async () => {
		const promise = execAsyncRemote("srv-1", "sleep 60");

		await vi.waitFor(() => {
			expect(ssh.instances).toHaveLength(1);
		});

		const client = ssh.instances[0];
		expect(client).toBeDefined();
		if (!client) {
			throw new Error("Expected an SSH client to be created");
		}

		client.emit("ready");
		client.emit("close");

		await expect(promise).rejects.toThrow(
			"SSH connection closed before command completed",
		);
		expect(client.command).toContain("sleep 60");
	});
});
