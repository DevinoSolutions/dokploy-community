import {
	ExecError,
	MAX_EXEC_OUTPUT_TAIL,
} from "@dokploy/server/utils/process/ExecError";
import {
	execAsyncRemote,
	execAsyncStream,
	openRemoteInputSession,
} from "@dokploy/server/utils/process/execAsync";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for ssh2: each Client records what it was asked to do, and the
// test drives its channel's events.
const ssh = vi.hoisted(() => ({
	clients: [] as any[],
	connectError: null as Error | null,
	channelAcceptsWrites: true,
	onExec: (_channel: any) => {},
	onEnd: (_channel: any) => {},
}));

vi.mock("ssh2", async () => {
	const { EventEmitter } = await import("node:events");

	class FakeChannel extends EventEmitter {
		stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
		written: Buffer[] = [];
		ended = false;
		setEncoding() {}
		write(data: Buffer) {
			this.written.push(Buffer.from(data));
			return ssh.channelAcceptsWrites;
		}
		end() {
			this.ended = true;
			ssh.onEnd(this);
		}
	}

	class Client extends EventEmitter {
		config: any;
		command = "";
		channel: FakeChannel | null = null;
		ended = false;
		connect(config: any) {
			this.config = config;
			ssh.clients.push(this);
			queueMicrotask(() => {
				if (ssh.connectError) {
					this.emit("error", ssh.connectError);
					this.emit("close");
				} else {
					this.emit("ready");
				}
			});
			return this;
		}
		exec(command: string, callback: (err: Error | undefined, ch: any) => void) {
			this.command = command;
			this.channel = new FakeChannel();
			callback(undefined, this.channel);
			ssh.onExec(this.channel);
		}
		calls: string[] = [];
		end() {
			this.ended = true;
			this.calls.push("end");
		}
		destroyed = false;
		destroy() {
			this.destroyed = true;
			this.calls.push("destroy");
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

const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
	ssh.clients = [];
	ssh.connectError = null;
	ssh.channelAcceptsWrites = true;
	ssh.onExec = () => {};
	ssh.onEnd = () => {};
});

describe("execAsyncRemote", () => {
	it("keeps a UTF-8 character split across two packets intact", async () => {
		const text = Buffer.from("héllo ✓ 日本\n", "utf8");
		const split = text.indexOf(Buffer.from("✓", "utf8")) + 1;
		ssh.onExec = (channel) => {
			queueMicrotask(() => {
				channel.emit("data", text.subarray(0, split));
				channel.emit("data", text.subarray(split));
				channel.stderr.emit("data", text.subarray(0, split));
				channel.stderr.emit("data", text.subarray(split));
				channel.emit("close", 0);
			});
		};
		const chunks: string[] = [];

		const result = await execAsyncRemote("server-1", "cmd", (chunk) =>
			chunks.push(chunk),
		);

		expect(result).toEqual({
			stdout: "héllo ✓ 日本\n",
			stderr: "héllo ✓ 日本\n",
		});
		expect(chunks.join("")).toBe("héllo ✓ 日本\nhéllo ✓ 日本\n");
		expect(chunks.join("")).not.toContain("�");
	});

	const printOneMiB = () => {
		ssh.onExec = (channel) => {
			queueMicrotask(() => {
				for (let i = 0; i < 1024; i++) {
					channel.emit("data", Buffer.from(`${"z".repeat(1023)}\n`));
				}
				channel.emit("data", Buffer.from("the end\n"));
				channel.emit("close", 0);
			});
		};
	};
	const total = 1024 * 1024 + "the end\n".length;

	it("returns all the output by default", async () => {
		printOneMiB();

		const result = await execAsyncRemote("server-1", "cmd", () => {});

		expect(result.stdout.length).toBe(total);
	});

	it("keeps only the tail of streamed output with streamOnly", async () => {
		printOneMiB();
		let streamed = 0;

		const result = await execAsyncRemote(
			"server-1",
			"cmd",
			(chunk) => {
				streamed += chunk.length;
			},
			{ streamOnly: true },
		);

		expect(streamed).toBe(total);
		expect(result.stdout.length).toBeLessThanOrEqual(2 * MAX_EXEC_OUTPUT_TAIL);
		expect(result.stdout.endsWith("the end\n")).toBe(true);
	});
});

describe("execAsyncStream with streamOnly", () => {
	it("streams more than exec's buffer limit and keeps only a tail", async () => {
		const size = 3 * 1024 * 1024;
		let streamed = 0;

		const result = await execAsyncStream(
			`node -e "process.stdout.write('x'.repeat(${size}))"`,
			(chunk) => {
				streamed += chunk.length;
			},
			{ streamOnly: true },
		);

		expect(streamed).toBe(size);
		expect(result.stdout.length).toBeLessThanOrEqual(2 * MAX_EXEC_OUTPUT_TAIL);
	});

	it("reports the exit code and the end of the output on failure", async () => {
		const failure = execAsyncStream(
			`node -e "console.error('it broke'); process.exit(3)"`,
			() => {},
			{ streamOnly: true },
		);

		await expect(failure).rejects.toBeInstanceOf(ExecError);
		await expect(failure).rejects.toMatchObject({
			exitCode: 3,
			message: expect.stringMatching(/exit code 3: it broke/),
		});
	});
});

describe("openRemoteInputSession", () => {
	it("feeds every write to one command and waits for it to exit", async () => {
		ssh.onEnd = (channel) => queueMicrotask(() => channel.emit("close", 0));

		const session = await openRemoteInputSession("server-1", 'cat >> "/x"');
		await session.write(Buffer.from("one\n"));
		await session.write(Buffer.from("two\n"));
		await session.end();

		expect(ssh.clients).toHaveLength(1);
		const [client] = ssh.clients;
		expect(client.command).toBe('cat >> "/x"');
		expect(Buffer.concat(client.channel.written).toString()).toBe("one\ntwo\n");
		expect(client.channel.ended).toBe(true);
		expect(client.ended).toBe(true);
		// A dead connection is noticed while the session idles.
		expect(client.config.keepaliveInterval).toBeGreaterThan(0);
	});

	it("waits for the channel to drain before taking more", async () => {
		const session = await openRemoteInputSession("server-1", "cat");
		ssh.channelAcceptsWrites = false;
		let done = false;

		const write = session.write(Buffer.from("big")).then(() => {
			done = true;
		});
		await tick();
		expect(done).toBe(false);

		ssh.clients[0].channel.emit("drain");
		await write;
		expect(done).toBe(true);
	});

	it("fails a write that waits on a connection that drops", async () => {
		const session = await openRemoteInputSession("server-1", "cat");
		ssh.channelAcceptsWrites = false;

		const write = session.write(Buffer.from("big"));
		// What ssh2 does when the connection dies: the client closes, then its
		// channels close without an exit status.
		ssh.clients[0].emit("close");
		ssh.clients[0].channel.emit("close", undefined);

		await expect(write).rejects.toThrow(/closed before the command finished/);
		await expect(session.write(Buffer.from("more"))).rejects.toThrow(
			/closed before the command finished/,
		);
		await expect(session.end()).rejects.toThrow(
			/closed before the command finished/,
		);
	});

	it("abort() drops the connection and fails what is still waiting", async () => {
		const session = await openRemoteInputSession("server-1", "cat");
		ssh.channelAcceptsWrites = false;

		const write = session.write(Buffer.from("big"));
		const end = session.end();
		session.abort();

		await expect(write).rejects.toThrow(/aborted/);
		await expect(end).rejects.toThrow(/aborted/);
		expect(ssh.clients[0].destroyed).toBe(true);
		// ssh2 only drops the socket if destroy() comes before end().
		expect(ssh.clients[0].calls[0]).toBe("destroy");
	});

	it("fails writes after a connection error", async () => {
		const session = await openRemoteInputSession("server-1", "cat");

		ssh.clients[0].emit("error", new Error("read ECONNRESET"));

		await expect(session.write(Buffer.from("x"))).rejects.toThrow(
			/SSH connection error: read ECONNRESET/,
		);
	});

	it("rejects end() with the command's own output when it fails", async () => {
		ssh.onEnd = (channel) =>
			queueMicrotask(() => {
				channel.stderr.emit("data", "cat: can't create /x: No such file\n");
				channel.emit("close", 1);
			});

		const session = await openRemoteInputSession("server-1", 'cat >> "/x"');
		await session.write(Buffer.from("data"));

		await expect(session.end()).rejects.toThrow(
			/exit code 1: cat: can't create \/x: No such file/,
		);
	});

	it("rejects when the connection cannot be opened", async () => {
		ssh.connectError = new Error("connect ECONNREFUSED 10.0.0.2:22");

		await expect(openRemoteInputSession("server-1", "cat")).rejects.toThrow(
			/SSH connection error: connect ECONNREFUSED/,
		);
	});
});
