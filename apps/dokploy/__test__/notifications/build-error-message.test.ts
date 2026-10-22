import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsyncRemote: mocks.execAsyncRemote,
}));

const { getDeploymentErrorMessage } = await import(
	"@dokploy/server/services/deployment"
);
const { ExecError } = await import("@dokploy/server/utils/process/ExecError");

// Synthetic key material, not a real key.
const SCRIPT = `set -e; echo "-----BEGIN OPENSSH PRIVATE KEY-----
c3ludGhldGljLXRlc3Qta2V5
-----END OPENSSH PRIVATE KEY-----" > /tmp/id_rsa; nixpacks build /code`;
const FALLBACK = "Error building, check the logs for details.";

// What the build failure throws: its message carries the build script.
const buildFailure = () =>
	new ExecError(`Command execution failed: Command failed: ${SCRIPT}`, {
		command: SCRIPT,
		stdout: "",
		stderr: "",
		exitCode: 1,
	});

const dir = mkdtempSync(path.join(tmpdir(), "dokploy-build-error-"));
const logPath = path.join(dir, "web-abc-2026.log");

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getDeploymentErrorMessage (build failure notification body)", () => {
	it("sends the build log tail, never the build script from the error", async () => {
		writeFileSync(
			logPath,
			[
				"src/index.ts:3:7 - error TS2322: Type 'number' is not assignable to type 'string'.",
				"❌ Nixpacks build failed",
				"",
			].join("\n"),
		);

		// The notification no longer reads error.message, so the script that
		// ExecError carries cannot reach it.
		expect(buildFailure().message).toContain("PRIVATE KEY");
		const message = await getDeploymentErrorMessage({
			logPath,
			serverId: null,
			fallback: FALLBACK,
		});

		expect(message).toContain("error TS2322");
		expect(message).not.toContain("PRIVATE KEY");
		expect(message).not.toContain("c3ludGhldGljLXRlc3Qta2V5");
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("keeps only the last lines of the log", async () => {
		writeFileSync(
			logPath,
			Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n"),
		);

		const message = await getDeploymentErrorMessage({
			logPath,
			serverId: null,
			fallback: FALLBACK,
			maxLines: 3,
		});

		expect(message).toBe("line 78\nline 79\nline 80");
	});

	it("reads the log on the remote server for remote builds", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "build failed\n",
			stderr: "",
		});

		const message = await getDeploymentErrorMessage({
			logPath: "/etc/dokploy/logs/web-abc/web-abc-2026.log",
			serverId: "server-1",
			fallback: FALLBACK,
		});

		expect(message).toBe("build failed");
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"server-1",
			expect.stringContaining("tail -n 50"),
		);
	});

	it("falls back to a generic message when the log cannot be read", async () => {
		const message = await getDeploymentErrorMessage({
			logPath: path.join(dir, "missing.log"),
			serverId: null,
			fallback: FALLBACK,
		});
		expect(message).toBe(FALLBACK);

		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh unreachable"));
		await expect(
			getDeploymentErrorMessage({
				logPath: "/etc/dokploy/logs/web-abc/web-abc-2026.log",
				serverId: "server-1",
				fallback: FALLBACK,
			}),
		).resolves.toBe(FALLBACK);
	});
});
