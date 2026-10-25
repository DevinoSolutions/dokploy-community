import {
	createStepTracker,
	serverSetup,
	setupExitError,
} from "@dokploy/server/setup/server-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for ssh2: the test drives the setup script's channel through
// `ssh.onExec`, so no shell or host is involved.
const ssh = vi.hoisted(() => ({
	clients: [] as any[],
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
			queueMicrotask(() => this.emit("ready"));
			return this;
		}
		exec(command: string, callback: (err: Error | undefined, ch: any) => void) {
			this.command = command;
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
