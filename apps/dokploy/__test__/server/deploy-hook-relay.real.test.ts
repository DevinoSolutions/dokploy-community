import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
	HOOK_LOG_RETRY_MARKER,
	runDeployHook,
} from "@dokploy/server/utils/docker/hooks";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The "build server" is a throwaway container running sshd; findServerById
// points at it.
const logHost = vi.hoisted(() => ({
	server: {
		sshKeyId: "relay-test-key",
		ipAddress: "127.0.0.1",
		port: 0,
		username: "root",
		sshKey: { privateKey: "" },
	},
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(async () => logHost.server),
}));

const run = promisify(execFile);
const LOG_HOST_ID = "relay-log-host";

/**
 * Relays deploy hook output to a log on another host through a real SSH
 * server. The hook runs locally, inside the same throwaway container through
 * `docker exec`, and its output goes to a log file in that container over SSH.
 *
 * Needs a local Docker daemon and network access to install openssh in an
 * `alpine` container. Set DOKPLOY_DOCKER_REAL_TESTS=1 to run; the suite
 * starts and removes its own container. Skipped otherwise.
 */
describe.skipIf(!process.env.DOKPLOY_DOCKER_REAL_TESTS)(
	"deploy hook log relay against a real SSH server",
	() => {
		const name = `dokploy-hook-relay-test-${process.pid}`;

		const inContainer = async (script: string) =>
			(
				await run("docker", ["exec", name, "sh", "-c", script], {
					maxBuffer: 64 * 1024 * 1024,
				})
			).stdout;

		const acceptedConnections = async () => {
			const { stdout, stderr } = await run("docker", ["logs", name], {
				maxBuffer: 64 * 1024 * 1024,
			});
			return `${stdout}${stderr}`.split("Accepted publickey").length - 1;
		};

		/** Prints `count` numbered lines of mixed ASCII and multi-byte text. */
		const printLines = (count: number) =>
			`i=0; while [ $i -lt ${count} ]; do echo "line $i héllo ✓ 日本"; i=$((i+1)); done`;
		const expectedLines = (count: number) =>
			Array.from({ length: count }, (_, i) => `line ${i} héllo ✓ 日本\n`).join(
				"",
			);
		const digest = (text: string) => {
			const bytes = Buffer.from(text, "utf8");
			return {
				bytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			};
		};

		beforeAll(async () => {
			const keys = utils.generateKeyPairSync("ed25519");
			logHost.server.sshKey.privateKey = keys.private;

			await run("docker", ["rm", "-f", name]).catch(() => {});
			const setup = [
				"apk add --no-cache openssh-server >/dev/null",
				"ssh-keygen -A >/dev/null",
				// A random password unlocks root for key logins.
				'echo "root:$(head -c 12 /dev/urandom | base64)" | chpasswd',
				'mkdir -p /root/.ssh && echo "$PUB" > /root/.ssh/authorized_keys',
				"chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys",
				"exec /usr/sbin/sshd -D -e",
			].join(" && ");
			await run("docker", [
				"run",
				"-d",
				"--name",
				name,
				"-e",
				`PUB=${keys.public}`,
				"-p",
				"127.0.0.1::22",
				"alpine:3",
				"sh",
				"-c",
				setup,
			]);
			const { stdout } = await run("docker", ["port", name, "22/tcp"]);
			logHost.server.port = Number(stdout.trim().split(":").pop());

			const deadline = Date.now() + 90_000;
			for (;;) {
				try {
					await execAsyncRemote(LOG_HOST_ID, "true");
					break;
				} catch (error) {
					if (Date.now() > deadline) throw error;
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
			}
		}, 120_000);

		afterAll(async () => {
			await run("docker", ["rm", "-f", name]).catch(() => {});
		});

		it("relays a chatty hook's output to the log host over one connection", async () => {
			const logPath = "/tmp/relay-deploy.log";
			const lines = 100_000;
			const command = printLines(lines);
			await inContainer(`printf 'Initializing deployment\\n' > ${logPath}`);
			const before = await acceptedConnections();

			await runDeployHook({
				kind: "post",
				appName: "relay-test",
				serverId: null,
				command,
				logPath,
				logServerId: LOG_HOST_ID,
				containerId: name,
			});

			const log = await inContainer(`cat ${logPath}`);
			expect(digest(log)).toEqual(
				digest(
					"Initializing deployment\n" +
						`===== Running post-deploy hook (length=${command.length} chars) =====\n` +
						expectedLines(lines) +
						"===== post-deploy hook finished =====\n",
				),
			);
			// About 2.7 MB of output, relayed over a single SSH connection.
			expect((await acceptedConnections()) - before).toBe(1);
		}, 120_000);

		it("restarts the session once when the connection drops mid-hook", async () => {
			const logPath = "/tmp/relay-drop.log";
			await inContainer(`: > ${logPath}`);
			const before = await acceptedConnections();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const hook = runDeployHook({
					kind: "post",
					appName: "relay-test",
					serverId: null,
					command:
						'i=0; while [ $i -lt 60 ]; do echo "tick $i"; i=$((i+1)); sleep 0.1; done',
					logPath,
					logServerId: LOG_HOST_ID,
					containerId: name,
				});
				const deadline = Date.now() + 15_000;
				while (!(await inContainer(`cat ${logPath}`)).includes("tick 5\n")) {
					if (Date.now() > deadline) throw new Error("no output relayed");
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				// Kill the relay's SSH session on the log host. The brackets keep
				// the pattern from matching this shell's own command line.
				await inContainer("pkill -f 'root@nott[y]'");

				await expect(hook).resolves.toBeUndefined();

				const log = await inContainer(`cat ${logPath}`);
				expect(log).toContain(HOOK_LOG_RETRY_MARKER);
				expect(
					log.endsWith("tick 59\n===== post-deploy hook finished =====\n"),
				).toBe(true);
				expect((await acceptedConnections()) - before).toBe(2);
				expect(errorSpy).not.toHaveBeenCalled();
			} finally {
				errorSpy.mockRestore();
			}
		}, 60_000);

		it("keeps multi-byte characters intact across SSH packets", async () => {
			const lines = 20_000;
			const chunks: string[] = [];

			await execAsyncRemote(LOG_HOST_ID, printLines(lines), (chunk) =>
				chunks.push(chunk),
			);

			const output = chunks.join("");
			expect(output).not.toContain("�");
			expect(digest(output)).toEqual(digest(expectedLines(lines)));
		}, 60_000);

		it("reports a log the host cannot write without failing the hook", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				await expect(
					runDeployHook({
						kind: "post",
						appName: "relay-test",
						serverId: null,
						command: "echo hello",
						logPath: "/no/such/dir/deploy.log",
						logServerId: LOG_HOST_ID,
						containerId: name,
					}),
				).resolves.toBeUndefined();
				expect(errorSpy).toHaveBeenCalledWith(
					expect.stringContaining("Failed to relay deploy hook output"),
					expect.objectContaining({
						message: expect.stringContaining("/no/such/dir/deploy.log"),
					}),
				);
			} finally {
				errorSpy.mockRestore();
			}
		}, 60_000);
	},
);
