import {
	serverSetup,
	TRAEFIK_RESTART_MARKER,
	TRAEFIK_RESTORE_MARKER,
} from "@dokploy/server/setup/server-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";

// What serverSetup does about Traefik once the setup script has run: the same
// ssh2 stand-in as the exit status tests, with the Traefik calls recorded.
const ssh = vi.hoisted(() => ({
	onExec: (_channel: any) => {},
	serverType: "deploy",
}));

vi.mock("ssh2", async () => {
	const { EventEmitter } = await import("node:events");

	class FakeChannel extends EventEmitter {
		stderr = new EventEmitter();
	}

	class Client extends EventEmitter {
		connect() {
			queueMicrotask(() => this.emit("ready"));
			return this;
		}
		exec(
			_command: string,
			callback: (err: Error | undefined, ch: any) => void,
		) {
			const channel = new FakeChannel();
			callback(undefined, channel);
			ssh.onExec(channel);
		}
		end() {
			queueMicrotask(() => this.emit("close"));
		}
	}

	return { Client };
});

const traefik = vi.hoisted(() => ({ finish: vi.fn(), backup: vi.fn() }));

vi.mock("@dokploy/server/services/settings", () => ({
	finishTraefikAfterSetup: traefik.finish,
	hasTraefikBackup: traefik.backup,
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createServerDeployment: vi.fn(async () => ({ deploymentId: "dep-1" })),
	updateDeploymentStatus: vi.fn(async () => {}),
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(async () => ({
		serverId: "srv-1",
		name: "worker",
		serverType: ssh.serverType,
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

const run = async () => {
	const logs: string[] = [];
	const outcome = await serverSetup("srv-1", (log) => logs.push(log)).then(
		() => ({ ok: true as const }),
		(error: Error) => ({ ok: false as const, error }),
	);
	return { logs, outcome };
};

// Chunks of output, then the exit status.
const script =
	(...steps: (string | number)[]) =>
	(channel: any) =>
		queueMicrotask(() => {
			for (const step of steps) {
				if (typeof step === "string") {
					channel.emit("data", Buffer.from(step));
				} else {
					channel.emit("close", step, undefined);
				}
			}
		});

beforeEach(() => {
	ssh.serverType = "deploy";
	ssh.onExec = () => {};
	traefik.finish.mockReset();
	traefik.finish.mockResolvedValue(undefined);
	traefik.backup.mockReset();
	traefik.backup.mockResolvedValue(false);
});

describe("serverSetup: Traefik after the script", () => {
	it("restarts Traefik through the queue when the script asked for it", async () => {
		ssh.onExec = script(
			`8. Setting up Traefik\n${TRAEFIK_RESTART_MARKER}\n`,
			0,
		);

		const { logs, outcome } = await run();

		expect(outcome.ok).toBe(true);
		expect(traefik.finish).toHaveBeenCalledWith("srv-1", true);
		expect(logs).toContain("\nTraefik restarted ✅\n");
	});

	it("finds a marker that arrives in two chunks", async () => {
		const half = Math.floor(TRAEFIK_RESTART_MARKER.length / 2);
		ssh.onExec = script(
			`line\n${TRAEFIK_RESTART_MARKER.slice(0, half)}`,
			`${TRAEFIK_RESTART_MARKER.slice(half)}\n`,
			0,
		);

		await run();

		expect(traefik.finish).toHaveBeenCalledWith("srv-1", true);
	});

	it("finds the marker on a line of its own, whatever the line ending", async () => {
		ssh.onExec = script(
			`8. Setting up Traefik\r\n${TRAEFIK_RESTART_MARKER}\r\n`,
			0,
		);

		await run();

		expect(traefik.finish).toHaveBeenCalledWith("srv-1", true);
	});

	it.each([
		["inside another line", `echo: ${TRAEFIK_RESTART_MARKER}\n`],
		["at the start of a longer line", `${TRAEFIK_RESTART_MARKER} later\n`],
		["inside a line split across chunks", `a ${TRAEFIK_RESTART_MARKER}`],
	])("ignores the marker %s", async (_name, output) => {
		ssh.onExec = script(output, "\n", 0);

		await run();

		expect(traefik.finish).not.toHaveBeenCalledWith("srv-1", true);
	});

	it("still restarts Traefik when a later setup step fails", async () => {
		ssh.onExec = script(
			`8. Setting up Traefik\n${TRAEFIK_RESTART_MARKER}\n`,
			"11. Installing Nixpacks\n",
			1,
		);

		const { outcome, logs } = await run();

		expect(outcome.ok).toBe(false);
		expect(traefik.finish).toHaveBeenCalledWith("srv-1", true);
		expect(logs.at(-1)).toContain("Setup Server: ❌");
	});

	it("only restores a left-behind Traefik when the script asked for nothing", async () => {
		ssh.onExec = script(
			"10. Setting up Traefik Instance\n",
			`${TRAEFIK_RESTORE_MARKER}\n`,
			0,
		);

		await run();

		expect(traefik.finish).toHaveBeenCalledWith("srv-1", false);
	});

	it("finds the restore line when it arrives in two chunks", async () => {
		const half = Math.floor(TRAEFIK_RESTORE_MARKER.length / 2);
		ssh.onExec = script(
			TRAEFIK_RESTORE_MARKER.slice(0, half),
			`${TRAEFIK_RESTORE_MARKER.slice(half)}\n`,
			0,
		);

		await run();

		expect(traefik.finish).toHaveBeenCalledWith("srv-1", false);
	});

	it("does not wait on the Traefik queue when there is nothing to restart or restore", async () => {
		ssh.onExec = script("10. Setting up Traefik Instance\n", 0);

		const { outcome } = await run();

		expect(outcome.ok).toBe(true);
		expect(traefik.finish).not.toHaveBeenCalled();
	});

	it("keeps a failed Docker install to its own error", async () => {
		traefik.finish.mockRejectedValue(new Error("docker: command not found"));
		ssh.onExec = script("3. Installing Docker\n", 1);

		const { outcome, logs } = await run();

		expect(outcome.ok).toBe(false);
		expect(traefik.finish).not.toHaveBeenCalled();
		expect(logs.join("")).not.toContain("Could not restart or restore Traefik");
	});

	it("still restores a backup left by an interrupted update when the setup died early", async () => {
		traefik.backup.mockResolvedValue(true);
		ssh.onExec = script("3. Installing Docker\n", 1);

		const { outcome } = await run();

		expect(outcome.ok).toBe(false);
		expect(traefik.backup).toHaveBeenCalledWith("srv-1");
		expect(traefik.finish).toHaveBeenCalledWith("srv-1", false);
	});

	it("restores a left-behind backup after a script that printed nothing about Traefik", async () => {
		traefik.backup.mockResolvedValue(true);
		ssh.onExec = script("10. Setting up Traefik Instance\n", 0);

		await run();

		expect(traefik.finish).toHaveBeenCalledWith("srv-1", false);
	});

	it("leaves a build server's Traefik alone", async () => {
		ssh.serverType = "build";
		ssh.onExec = script(`${TRAEFIK_RESTART_MARKER}\n`, 0);

		await run();

		expect(traefik.finish).not.toHaveBeenCalled();
	});

	it("reports a failed restart without failing the setup", async () => {
		traefik.finish.mockRejectedValue(new Error("docker unreachable"));
		ssh.onExec = script(`${TRAEFIK_RESTART_MARKER}\n`, 0);

		const { outcome, logs } = await run();

		expect(outcome.ok).toBe(true);
		expect(logs.join("")).toContain("docker unreachable");
		expect(logs).not.toContain("\nTraefik restarted ✅\n");
	});
});
