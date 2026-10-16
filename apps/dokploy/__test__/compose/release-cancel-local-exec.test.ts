import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	getRollingReplaceScript,
	commandRunsRollingReplace,
} from "@dokploy/server/utils/builders/compose-rolling";
import { getKillRemoteBuildCommand } from "@dokploy/server/utils/builders/remote-build-cancel";
import { execAsyncCancelable } from "@dokploy/server/utils/process/execAsync";
import {
	abortRemoteBuild,
	hasRunningRemoteBuild,
} from "@dokploy/server/utils/process/remote-build-registry";

/**
 * `execAsyncCancelable`: the release step of a build-server compose whose
 * serving host is the Dokploy host. It must register while it runs, run in its
 * own session so the kill script can signal it, and stop waiting when aborted.
 */

const hasSetsid =
	process.platform !== "win32" &&
	spawnSync("sh", ["-c", "command -v setsid && [ -d /proc/self ]"]).status ===
		0;

const root = mkdtempSync(join(tmpdir(), "dokploy-local-cancel-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const targetFor = (name: string) => ({
	pidFile: join(root, `${name}.pid`),
	deploymentId: `${name}.release`,
});

const waitFor = async (check: () => boolean, tries = 80) => {
	for (let i = 0; i < tries && !check(); i++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return check();
};

describe("commandRunsRollingReplace", () => {
	it("is true for a script with the rolling replace and false for a plain up", () => {
		const { definitions, call } = getRollingReplaceScript({
			appName: "my-app",
			invocation: "compose -p my-app -f docker-compose.yml",
			services: ["web"],
			remoteBuild: true,
			pullAlways: false,
			healthTimeoutSeconds: 60,
			drainSeconds: 0,
		});

		expect(commandRunsRollingReplace(`set -e;\n${definitions}\n${call}`)).toBe(
			true,
		);
		expect(commandRunsRollingReplace("set -e; docker compose up -d 2>&1")).toBe(
			false,
		);
	});
});

describe("execAsyncCancelable", () => {
	it("does not start the command when beforeExec refuses, and registers nothing", async () => {
		const target = targetFor("refused");
		const marker = join(root, "refused.ran");

		await expect(
			execAsyncCancelable(`touch ${marker}`, target, {
				beforeExec: () => {
					throw new Error("cancelled");
				},
			}),
		).rejects.toThrow("cancelled");

		expect(existsSync(marker)).toBe(false);
		expect(hasRunningRemoteBuild(target.deploymentId)).toBe(false);
	});

	it.skipIf(!hasSetsid)("runs the command and unregisters afterwards", async () => {
		const target = targetFor("ok");
		const marker = join(root, "ok.ran");

		const pending = execAsyncCancelable(`echo hi && touch ${marker}`, target);
		expect(hasRunningRemoteBuild(target.deploymentId)).toBe(true);
		const result = await pending;

		expect(result.stdout.trim()).toBe("hi");
		expect(existsSync(marker)).toBe(true);
		expect(hasRunningRemoteBuild(target.deploymentId)).toBe(false);
	});

	it.skipIf(!hasSetsid)("a failing command rejects with its exit code", async () => {
		const target = targetFor("fails");

		const error = await execAsyncCancelable("exit 3", target).catch((e) => e);

		expect(error).toMatchObject({ name: "ExecError", exitCode: 3 });
		expect(hasRunningRemoteBuild(target.deploymentId)).toBe(false);
	});

	it.skipIf(!hasSetsid)(
		"the kill script signals the command's own session, so its trap runs",
		{ timeout: 30_000 },
		async () => {
			const target = targetFor("trap");
			const trapped = join(root, "trap.ran");
			const script = join(root, "trap.sh");
			writeFileSync(
				script,
				`trap 'touch ${trapped}; exit 130' TERM\nsleep 30 & wait $!\n`,
			);

			const pending = execAsyncCancelable(`sh ${script}`, target).catch(
				(e) => e,
			);
			expect(await waitFor(() => existsSync(target.pidFile))).toBe(true);

			const kill = spawnSync("sh", ["-c", getKillRemoteBuildCommand(target, 10)], {
				encoding: "utf8",
			});
			expect(kill.stdout.trim()).toBe("KILLED");
			const error = await pending;

			expect(existsSync(trapped)).toBe(true);
			expect(error).toMatchObject({ name: "ExecError" });
			expect(existsSync(target.pidFile)).toBe(false);
		},
	);

	it.skipIf(!hasSetsid)(
		"aborting by the registry key stops the wait right away",
		{ timeout: 30_000 },
		async () => {
			const target = targetFor("abort");
			const script = join(root, "abort.sh");
			writeFileSync(script, "sleep 20\n");

			const pending = execAsyncCancelable(`sh ${script}`, target).catch(
				(e) => e,
			);
			expect(await waitFor(() => existsSync(target.pidFile))).toBe(true);

			expect(abortRemoteBuild(target.deploymentId, "cancelled by user")).toBe(1);
			const error = await pending;

			expect(error.message).toContain("cancelled by user");
			// The command itself is left to the kill script.
			spawnSync("sh", ["-c", getKillRemoteBuildCommand(target, 2)]);
		},
	);
});
