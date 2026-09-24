import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findServerById: vi.fn(),
	validateRequest: vi.fn(async () => ({
		user: { id: "user-1" },
		session: { activeOrganizationId: "org-1" },
	})),
}));
vi.mock("@/server/wss/authorize", () => ({
	canAccessDockerOverWss: vi.fn(async () => true),
}));

const { setupDockerContainerLogsWebSocketServer } = await import(
	"@/server/wss/docker-container-logs"
);

const run = promisify(execFile);

/**
 * Opens the real log viewer WebSocket against a throwaway container and checks
 * that viewing (and closing) the logs never signals the container. Before the
 * fix, every viewer ran `docker attach` with signal proxying, so tearing the
 * viewer down forwarded SIGHUP to the container's main process; a service that
 * exits on SIGHUP (PocketBase, for one) restarted.
 *
 * Needs a local Docker daemon. Set DOKPLOY_DOCKER_REAL_TESTS=1 to run; the
 * suite starts and removes its own `alpine` container. Skipped otherwise.
 */
describe.skipIf(!process.env.DOKPLOY_DOCKER_REAL_TESTS)(
	"docker container logs WebSocket against a real container",
	() => {
		const name = `dokploy-logs-signal-test-${process.pid}`;
		// PID 1 records any signal it receives instead of dying, and echoes stdin.
		const script = [
			'for s in HUP INT TERM QUIT; do trap "echo SIGNAL:$s" $s; done',
			"echo ready",
			'while true; do if read -t 1 line; then echo "got:$line"; fi; done',
		].join("; ");
		let server: http.Server;
		let port: number;

		const containerLogs = async () => {
			const { stdout, stderr } = await run("docker", ["logs", name]);
			return stdout + stderr;
		};
		const isRunning = async () =>
			(
				await run("docker", ["inspect", "-f", "{{.State.Running}}", name])
			).stdout.trim() === "true";

		const waitFor = async (check: () => boolean | Promise<boolean>) => {
			const deadline = Date.now() + 15_000;
			while (!(await check())) {
				if (Date.now() > deadline) throw new Error("timed out");
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		};

		const openViewer = async () => {
			const messages: string[] = [];
			const ws = new WebSocket(
				`ws://127.0.0.1:${port}/docker-container-logs?containerId=${name}&tail=100&since=all`,
			);
			ws.on("message", (data) => messages.push(data.toString()));
			await waitFor(() => messages.join("").includes("ready"));
			return { ws, messages };
		};

		const closeViewer = async (ws: WebSocket) => {
			ws.close();
			await waitFor(() => ws.readyState === WebSocket.CLOSED);
			// Teardown kills the viewer's processes; give a forwarded signal time
			// to reach the container and its trap time to run.
			await new Promise((resolve) => setTimeout(resolve, 3000));
		};

		beforeAll(async () => {
			await run("docker", ["rm", "-f", name]).catch(() => {});
			await run("docker", [
				"run",
				"-d",
				"-i",
				"--name",
				name,
				"alpine:3",
				"sh",
				"-c",
				script,
			]);
			await waitFor(async () => (await containerLogs()).includes("ready"));

			server = http.createServer();
			setupDockerContainerLogsWebSocketServer(server);
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			port = (server.address() as AddressInfo).port;
		}, 120_000);

		afterAll(async () => {
			await run("docker", ["rm", "-f", name]).catch(() => {});
			await new Promise((resolve) => server?.close(resolve));
		});

		it("does not signal the container when a viewer opens and closes", async () => {
			for (let i = 0; i < 3; i++) {
				const { ws } = await openViewer();
				await closeViewer(ws);
			}

			expect(await containerLogs()).not.toContain("SIGNAL:");
			expect(await isRunning()).toBe(true);
		}, 60_000);

		it("still sends commands to the container, without signaling it on close", async () => {
			const { ws, messages } = await openViewer();
			ws.send("hello-from-viewer");
			await waitFor(() => messages.join("").includes("got:hello-from-viewer"));
			await closeViewer(ws);

			expect(await containerLogs()).not.toContain("SIGNAL:");
			expect(await isRunning()).toBe(true);
		}, 60_000);
	},
);
