import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commandRunsRollingReplace,
	getRollingReplaceScript,
} from "@dokploy/server/utils/builders/compose-rolling";
import {
	getKillRemoteBuildCommand,
	getReleaseCancelTarget,
	getRemoteBuildCancelTarget,
	parseKillResult,
	RELEASE_DRAIN_SECONDS,
	wrapCancelableRemoteBuild,
} from "@dokploy/server/utils/builders/remote-build-cancel";
import { execAsyncCancelable } from "@dokploy/server/utils/process/execAsync";
import {
	abortRemoteBuild,
	hasRunningRemoteBuild,
} from "@dokploy/server/utils/process/remote-build-registry";
import { afterAll, describe, expect, it } from "vitest";

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

	it.skipIf(!hasSetsid)(
		"runs the command and unregisters afterwards",
		async () => {
			const target = targetFor("ok");
			const marker = join(root, "ok.ran");

			const pending = execAsyncCancelable(`echo hi && touch ${marker}`, target);
			expect(hasRunningRemoteBuild(target.deploymentId)).toBe(true);
			const result = await pending;

			expect(result.stdout.trim()).toBe("hi");
			expect(existsSync(marker)).toBe(true);
			expect(hasRunningRemoteBuild(target.deploymentId)).toBe(false);
		},
	);

	it.skipIf(!hasSetsid)(
		"a failing command rejects with its exit code",
		async () => {
			const target = targetFor("fails");

			const error = await execAsyncCancelable("exit 3", target).catch((e) => e);

			expect(error).toMatchObject({ name: "ExecError", exitCode: 3 });
			expect(hasRunningRemoteBuild(target.deploymentId)).toBe(false);
		},
	);

	it.skipIf(!hasSetsid)(
		"the kill script signals the command's own session, so its trap runs",
		{ timeout: 30_000 },
		async () => {
			const target = targetFor("trap");
			const trapped = join(root, "trap.ran");
			const ready = join(root, "trap.ready");
			const script = join(root, "trap.sh");
			// The pid file exists before the script runs; the ready file says the
			// trap is installed.
			writeFileSync(
				script,
				`trap 'touch ${trapped}; exit 130' TERM\ntouch ${ready}\nsleep 30 & wait $!\n`,
			);

			const pending = execAsyncCancelable(`sh ${script}`, target).catch(
				(e) => e,
			);
			expect(await waitFor(() => existsSync(ready))).toBe(true);
			expect(existsSync(target.pidFile)).toBe(true);

			const kill = spawnSync(
				"sh",
				["-c", getKillRemoteBuildCommand(target, 10)],
				{
					encoding: "utf8",
				},
			);
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

			expect(abortRemoteBuild(target.deploymentId, "cancelled by user")).toBe(
				1,
			);
			const error = await pending;

			expect(error.message).toContain("cancelled by user");
			// The command itself is left to the kill script.
			spawnSync("sh", ["-c", getKillRemoteBuildCommand(target, 2)]);
		},
	);
});

/** A release target with the drain the real one has, in the temp directory. */
const releaseTargetFor = (name: string) => ({
	...targetFor(name),
	drainSeconds: RELEASE_DRAIN_SECONDS,
});

describe("the release done marker, for real", () => {
	it.skipIf(!hasSetsid)(
		"clears a marker left by an earlier run before the script starts",
		{ timeout: 30_000 },
		async () => {
			const target = releaseTargetFor("stale-start");
			const seen = join(root, "stale-start.seen");
			writeFileSync(`${target.pidFile}.done`, "");

			await execAsyncCancelable(
				`if [ -e "$DOKPLOY_RELEASE_DONE" ]; then echo present > ${seen}; else echo absent > ${seen}; fi`,
				target,
			);

			expect(readFileSync(seen, "utf8").trim()).toBe("absent");
		},
	);

	it.skipIf(!hasSetsid)(
		"a stale marker does not cut the cancel short: the kill waits for the script's own cleanup",
		{ timeout: 30_000 },
		async () => {
			const target = releaseTargetFor("stale-kill");
			const cleaned = join(root, "stale-kill.cleaned");
			const ready = join(root, "stale-kill.ready");
			const script = join(root, "stale-kill.sh");
			// The cleanup takes a second and only then signals that it is done. The
			// ready file says the trap is installed: a TERM before that would end the
			// script without a cleanup (the pid file exists before it runs).
			writeFileSync(
				script,
				`trap 'sleep 1; touch ${cleaned}; : > "$DOKPLOY_RELEASE_DONE"; exit 130' TERM\ntouch ${ready}\nsleep 30 & wait $!\n`,
			);
			// What a SIGKILLed earlier release leaves behind.
			writeFileSync(`${target.pidFile}.done`, "");

			const pending = execAsyncCancelable(`sh ${script}`, target).catch(
				(e) => e,
			);
			expect(await waitFor(() => existsSync(ready))).toBe(true);
			expect(existsSync(target.pidFile)).toBe(true);

			const kill = spawnSync(
				"sh",
				["-c", getKillRemoteBuildCommand(target, 15)],
				{ encoding: "utf8" },
			);
			const error = await pending;

			expect(kill.stdout.trim()).toBe("KILLED");
			// Had the stale marker survived, the kill would have answered before this.
			expect(existsSync(cleaned)).toBe(true);
			expect(error).toMatchObject({ name: "ExecError" });
			// 130 when $SHELL execs the command, 143 when it is a plain sh that
			// dies of the TERM itself.
			expect([130, 143]).toContain(error.exitCode);
		},
	);

	it.skipIf(!hasSetsid)(
		"once the script is done, helpers that ignore TERM are killed too",
		{ timeout: 30_000 },
		async () => {
			const target = releaseTargetFor("helpers");
			// Not the target's pid file (helpers.pid): the helper would overwrite it.
			const helperPid = join(root, "helpers.helper");
			const ready = join(root, "helpers.ready");
			const script = join(root, "helpers.sh");
			// A helper (like `docker events`) that outlives the script's cleanup and
			// ignores TERM, as the group signal cannot remove it. The trap comes first
			// and the ready file last: a TERM before the trap would end the script
			// without the done marker, and the kill would wait out its whole grace.
			writeFileSync(
				script,
				[
					`trap ': > "$DOKPLOY_RELEASE_DONE"; exit 130' TERM`,
					`sh -c 'trap "" TERM; echo $$ > ${helperPid}; sleep 60' &`,
					`while [ ! -s ${helperPid} ]; do sleep 0.1; done`,
					`touch ${ready}`,
					"sleep 60 & wait $!",
					"",
				].join("\n"),
			);

			const pending = execAsyncCancelable(`sh ${script}`, target).catch(
				(e) => e,
			);
			expect(await waitFor(() => existsSync(ready))).toBe(true);
			expect(existsSync(target.pidFile)).toBe(true);
			const pid = Number(readFileSync(helperPid, "utf8").trim());
			expect(Number.isInteger(pid) && pid > 1).toBe(true);

			const kill = spawnSync(
				"sh",
				["-c", getKillRemoteBuildCommand(target, 15)],
				{ encoding: "utf8" },
			);
			await pending;

			expect(kill.stdout.trim()).toBe("KILLED");
			// A killed process nobody reaped yet (no init in a container) is a zombie.
			const gone = await waitFor(() => {
				try {
					const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
					return stat.charAt(stat.lastIndexOf(")") + 2) === "Z";
				} catch {
					return true;
				}
			}, 30);
			expect(gone).toBe(true);
		},
	);
});

describe("the release wrapper", () => {
	it("waits for the script's group after a signal-style exit, and only for the release step", () => {
		const release = wrapCancelableRemoteBuild(
			"true",
			getReleaseCancelTarget("dep-1", true),
		);
		const build = wrapCancelableRemoteBuild(
			"true",
			getRemoteBuildCancelTarget("dep-1"),
		);

		expect(release).toContain('[ "$__rc" -ge 128 ]');
		expect(release).toContain(`-lt ${RELEASE_DRAIN_SECONDS}`);
		expect(release.indexOf("-ge 128")).toBeLessThan(
			release.lastIndexOf(`rm -f "$__f"`),
		);
		expect(build).not.toContain("-ge 128");
	});

	it("exports the done marker to the release script and clears it, only for the release step", () => {
		const release = wrapCancelableRemoteBuild(
			"true",
			getReleaseCancelTarget("dep-1", true),
		);
		const build = wrapCancelableRemoteBuild(
			"true",
			getRemoteBuildCancelTarget("dep-1"),
		);

		expect(release).toContain('DOKPLOY_RELEASE_DONE="$__f.done"');
		expect(release).toContain("export DOKPLOY_RELEASE_DONE");
		expect(release).toContain('[ ! -e "$__f.done" ]');
		expect(release.indexOf('rm -f "$__f.done"')).toBeLessThan(
			release.indexOf("setsid"),
		);
		expect(build).not.toContain("DOKPLOY_RELEASE_DONE");
		expect(build).not.toContain(".done");
	});

	it("the kill script only reports a hard kill when asked, and stops waiting at the done marker", () => {
		const target = getReleaseCancelTarget("dep-1", true);

		expect(getKillRemoteBuildCommand(target, 5)).toContain("echo KILLED");
		expect(getKillRemoteBuildCommand(target, 5)).not.toContain("KILLED_HARD");
		expect(
			getKillRemoteBuildCommand(target, 5, { reportHardKill: true }),
		).toContain("echo KILLED_HARD");
		expect(getKillRemoteBuildCommand(target, 5)).toContain('"$f.done"');
		expect(parseKillResult("KILLED_HARD\n")).toBe("KILLED_HARD");
	});
});

describe("what the rolling script shields from a cancel", () => {
	const script = getRollingReplaceScript({
		appName: "my-app",
		invocation: "compose -p my-app -f docker-compose.yml",
		services: ["web"],
		buildServices: ["web"],
		pullServices: ["web"],
		remoteBuild: false,
		pullAlways: false,
		healthTimeoutSeconds: 60,
		drainSeconds: 0,
	}).definitions;
	const lines = script.split("\n").map((line) => line.trim());

	it("runs the up of the services that are not rolled, the plain up and the final up in a session of their own", () => {
		const shielded = lines.filter((line) =>
			line.includes("dokploy_roll_compose_shielded up"),
		);
		expect(shielded).toHaveLength(3);
		expect(shielded.some((line) => line.includes("--remove-orphans"))).toBe(
			true,
		);
		expect(shielded.some((line) => line.includes("$DR_OTHERS"))).toBe(true);
		expect(shielded.some((line) => line.includes('--no-build "$1"'))).toBe(
			true,
		);
	});

	it("leaves the scale-up, the build and the pull interruptible", () => {
		const plain = lines.filter((line) =>
			line.includes("dokploy_roll_compose "),
		);
		expect(plain.some((line) => line.includes("--scale"))).toBe(true);
		expect(plain.some((line) => line.includes(" build "))).toBe(true);
		expect(plain.some((line) => line.includes(" pull "))).toBe(true);
		expect(
			lines.filter((line) =>
				/dokploy_roll_compose_shielded .*(--scale| build | pull )/.test(line),
			),
		).toHaveLength(0);
	});

	it("marks the rollout inactive before it records the old container as being removed", () => {
		const line = lines.find((l) =>
			l.includes('DOKPLOY_ROLL_PROMOTING="$DR_OLD"'),
		);
		expect(line).toBeDefined();
		expect((line as string).indexOf("DOKPLOY_ROLL_ACTIVE=0")).toBeLessThan(
			(line as string).indexOf("DOKPLOY_ROLL_PROMOTING="),
		);
	});
});
