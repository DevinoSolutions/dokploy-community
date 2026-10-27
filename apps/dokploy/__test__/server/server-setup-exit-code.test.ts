import {
	createStepTracker,
	ServerSetupError,
	serverSetup,
	setupExitError,
} from "@dokploy/server/setup/server-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for ssh2: the test drives the setup script's channel through
// `ssh.onExec`, so no shell or host is involved.
const ssh = vi.hoisted(() => ({
	clients: [] as any[],
	execError: null as Error | null,
	connectError: null as Error | null,
	onExec: (_channel: any, _client: any) => {},
}));

vi.mock("ssh2", async () => {
	const { EventEmitter } = await import("node:events");

	class FakeChannel extends EventEmitter {
		stderr = new EventEmitter();
	}

	class Client extends EventEmitter {
		command = "";
		ended = false;
		connect() {
			ssh.clients.push(this);
			if (ssh.connectError) throw ssh.connectError;
			queueMicrotask(() => this.emit("ready"));
			return this;
		}
		exec(command: string, callback: (err: Error | undefined, ch: any) => void) {
			this.command = command;
			if (ssh.execError) {
				callback(ssh.execError, undefined);
				return;
			}
			const channel = new FakeChannel();
			callback(undefined, channel);
			ssh.onExec(channel, this);
		}
		end() {
			if (this.ended) return;
			this.ended = true;
			queueMicrotask(() => this.emit("close"));
		}
	}

	return { Client };
});

const deployment = vi.hoisted(() => ({
	createServerDeployment: vi.fn(async () => ({ deploymentId: "dep-1" })),
	updateDeploymentStatus: vi.fn(async () => {}),
}));

vi.mock("@dokploy/server/services/deployment", () => deployment);

// What serverSetup does about Traefik afterwards is covered by
// server-setup-traefik-followup.test.ts; here it must not open a second
// connection on the fake ssh2.
vi.mock("@dokploy/server/services/settings", () => ({
	finishTraefikAfterSetup: vi.fn(async () => {}),
	hasTraefikBackup: vi.fn(async () => false),
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(async () => ({
		serverId: "srv-1",
		name: "worker",
		serverType: "deploy",
		command: "echo setup",
		sshKeyId: "key-1",
		ipAddress: "10.0.0.2",
		port: 22,
		username: "root",
		sshKey: { privateKey: "PRIVATE KEY" },
		metricsConfig: { server: {}, containers: {} },
	})),
	updateServerById: vi.fn(async () => {}),
}));

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: vi.fn(async () => "https://dokploy.test"),
}));

vi.mock("@dokploy/server/utils/filesystem/directory", () => ({
	recreateDirectory: vi.fn(async () => {}),
}));

vi.mock("@dokploy/server/setup/monitoring-setup", () => ({
	setupMonitoring: vi.fn(async () => {}),
}));

const statuses = () =>
	deployment.updateDeploymentStatus.mock.calls.map((call: any[]) => call[1]);

const runSetup = async () => {
	const logs: string[] = [];
	const result = serverSetup("srv-1", (log) => logs.push(log)).then(
		() => ({ ok: true as const }),
		(error: Error) => ({ ok: false as const, error }),
	);
	return { logs, outcome: await result };
};

beforeEach(() => {
	ssh.clients = [];
	ssh.execError = null;
	ssh.connectError = null;
	ssh.onExec = () => {};
	deployment.createServerDeployment.mockClear();
	deployment.updateDeploymentStatus.mockReset();
	deployment.updateDeploymentStatus.mockImplementation(async () => {});
});

describe("serverSetup exit status", () => {
	it("resolves and marks the deployment done when the script exits 0", async () => {
		ssh.onExec = (channel) =>
			queueMicrotask(() => {
				channel.emit("data", Buffer.from("1. Installing required packages\n"));
				channel.emit("close", 0, undefined);
			});

		const { logs, outcome } = await runSetup();

		expect(outcome.ok).toBe(true);
		expect(statuses()).toEqual(["done"]);
		expect(logs).toContain("1. Installing required packages\n");
		expect(logs.at(-1)).toBe("\nSetup Server: ✅\n");
		expect(ssh.clients[0].ended).toBe(true);
	});

	it("rejects with the failing step and marks the deployment error on exit 1", async () => {
		ssh.onExec = (channel) =>
			queueMicrotask(() => {
				channel.emit("data", Buffer.from("5. Setting up Docker Swarm\n"));
				// A header split across two packets is still recognised.
				channel.emit("data", Buffer.from("6. Setting up Net"));
				channel.emit("data", Buffer.from("work\n"));
				channel.stderr.emit(
					"data",
					Buffer.from("Failed to create dokploy-network ❌\n"),
				);
				channel.emit("close", 1, undefined);
			});

		const { logs, outcome } = await runSetup();

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toBeInstanceOf(ServerSetupError);
		expect(outcome.error.message).toBe(
			'Setup failed at step "6. Setting up Network" (exit code 1)',
		);
		expect(statuses()).toEqual(["error"]);
		expect(logs).toContain("Failed to create dokploy-network ❌\n");
		expect(logs.at(-1)).toBe(
			'\nSetup Server: ❌ Setup failed at step "6. Setting up Network" (exit code 1)\n',
		);
		expect(logs).not.toContain("\nSetup Server: ✅\n");
	});

	it("treats a signal as a failure", async () => {
		ssh.onExec = (channel) =>
			queueMicrotask(() => {
				channel.emit("data", Buffer.from("4. Installing Docker. \n"));
				channel.emit("close", null, "KILL");
			});

		const { outcome } = await runSetup();

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.message).toBe(
			'Setup was killed by signal KILL at step "4. Installing Docker"',
		);
		expect(statuses()).toEqual(["error"]);
	});

	it("treats a close without an exit status as a failure", async () => {
		ssh.onExec = (channel) => queueMicrotask(() => channel.emit("close"));

		const { outcome } = await runSetup();

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.message).toBe("Setup ended without an exit status");
		expect(statuses()).toEqual(["error"]);
	});

	it("fails when the output stream errors", async () => {
		ssh.onExec = (channel) =>
			queueMicrotask(() => {
				channel.emit("data", Buffer.from("2. Validating ports. \n"));
				channel.emit("error", new Error("channel reset"));
			});

		const { outcome } = await runSetup();

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.message).toBe(
			'Setup output stream failed at step "2. Validating ports": channel reset',
		);
		expect(statuses()).toEqual(["error"]);
	});

	it("fails when the connection closes before the script reports its end", async () => {
		ssh.onExec = (_channel, client) =>
			queueMicrotask(() => client.emit("close"));

		const { outcome } = await runSetup();

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.message).toBe(
			"SSH connection closed before setup finished",
		);
		expect(statuses()).toEqual(["error"]);
	});

	it("resolves when the connection closes after an exit status of 0", async () => {
		// The channel never closes: the server dropped the connection right
		// after it sent the exit status.
		ssh.onExec = (channel, client) =>
			queueMicrotask(() => {
				channel.emit("exit", 0);
				client.emit("close");
			});

		const { logs, outcome } = await runSetup();

		expect(outcome.ok).toBe(true);
		expect(statuses()).toEqual(["done"]);
		expect(logs.at(-1)).toBe("\nSetup Server: ✅\n");
	});

	it("rejects with the step when the connection closes after a non-zero exit status", async () => {
		ssh.onExec = (channel, client) =>
			queueMicrotask(() => {
				channel.emit("data", Buffer.from("8. Setting up Traefik\n"));
				channel.emit("exit", 1);
				client.emit("close");
			});

		const { outcome } = await runSetup();

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.message).toBe(
			'Setup failed at step "8. Setting up Traefik" (exit code 1)',
		);
	});

	it("ends the connection and fails when the command cannot be started", async () => {
		ssh.execError = new Error("Channel open failure");

		const { logs, outcome } = await runSetup();

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toBeInstanceOf(ServerSetupError);
		expect(outcome.error.message).toBe("Channel open failure");
		expect(outcome.error.cause).toBe(ssh.execError);
		expect(ssh.clients[0].ended).toBe(true);
		expect(statuses()).toEqual(["error"]);
		expect(logs.at(-1)).toBe("\nSetup Server: ❌ Channel open failure\n");
	});

	it("fails with a ServerSetupError when connect throws instead of emitting an error", async () => {
		// ssh2 throws for an invalid username or a private key it cannot parse.
		ssh.connectError = new Error(
			"Cannot parse privateKey: Unsupported key format",
		);

		const { logs, outcome } = await runSetup();

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toBeInstanceOf(ServerSetupError);
		expect(outcome.error.message).toBe(
			"SSH connection error: Cannot parse privateKey: Unsupported key format",
		);
		expect(outcome.error.cause).toBe(ssh.connectError);
		expect(ssh.clients[0].ended).toBe(true);
		expect(statuses()).toEqual(["error"]);
		const friendly = logs.find((line) => line.includes("Technical details"));
		expect(friendly).toContain("❌ Couldn't connect to your server");
		expect(friendly).toContain(
			"Technical details: Cannot parse privateKey: Unsupported key format",
		);
		expect(friendly).toContain("username");
		expect(friendly).not.toContain("IP address");
		expect(friendly).not.toContain("SSH port");
		expect(friendly).toContain("SSH key");
		expect(logs.at(-1)).toBe(
			"\nSetup Server: ❌ SSH connection error: Cannot parse privateKey: Unsupported key format\n",
		);
	});

	it("still rethrows the setup failure when marking the deployment fails", async () => {
		deployment.updateDeploymentStatus.mockImplementation(async () => {
			throw new Error("db down");
		});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		ssh.onExec = (channel) => queueMicrotask(() => channel.emit("close", 2));

		const { outcome } = await runSetup();
		consoleError.mockRestore();

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.message).toBe("Setup failed (exit code 2)");
	});
});

describe("createStepTracker", () => {
	it("skips the Docker install's own check header", () => {
		const steps = createStepTracker();
		steps.push("4. Installing Docker. \n3. Check Docker Installation. \n");
		steps.push(" - Docker is installed.\n");
		expect(steps.lastStep).toBe("4. Installing Docker");
	});

	it("reads a header that has no trailing newline yet", () => {
		const steps = createStepTracker();
		steps.push("1. Installing required packages\n14. Configuring permissions");
		expect(steps.lastStep).toBe("14. Configuring permissions");
	});

	it("has no step before any header", () => {
		const steps = createStepTracker();
		steps.push("Installing requirements for: OS: ubuntu\n");
		expect(steps.lastStep).toBeUndefined();
	});
});

describe("setupExitError", () => {
	it("names the exit code", () => {
		expect(setupExitError(127, undefined, undefined).message).toBe(
			"Setup failed (exit code 127)",
		);
	});
});
