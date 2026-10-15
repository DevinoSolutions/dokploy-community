import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuildComposeCommand } from "@dokploy/server/utils/builders/compose";
import {
	getDockerEventsStartScript,
	getStallSnapshotStartScript,
} from "@dokploy/server/utils/builders/compose-guardrails";
import { quote } from "shell-quote";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/utils/docker/domain", () => ({
	writeDomainsToCompose: vi.fn().mockResolvedValue(""),
}));

type Compose = Parameters<typeof getBuildComposeCommand>[0];

const baseCompose = {
	appName: "my-app",
	sourceType: "git",
	command: "",
	composePath: "./docker-compose.yml",
	composeType: "docker-compose",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: null,
	env: "",
	mounts: [],
	domains: [],
	environment: { project: { env: "" }, env: "" },
} as unknown as Compose;

const build = (overrides: Record<string, unknown> = {}, remote = false) =>
	getBuildComposeCommand({ ...baseCompose, ...overrides } as Compose, {
		deploymentId: "dep-1",
		...(remote
			? {
					remoteBuild: {
						images: [{ service: "web", image: "registry.example/web:1" }],
						servingHostLabel: "the serving host",
					},
				}
			: {}),
	});

const stall = { afterSeconds: 15, everySeconds: 10, maxSnapshots: 5 };

// `date +%s` has one-second granularity and a cleanup forks a few processes, so a
// loaded runner can report 1 to 3 s for a cleanup that did not wait for anything.
// A cleanup held by the watcher or a stubborn command would wait out its timeout
// and grace, well past this bound.
const cleanupSeconds = (stdout: string) =>
	Number(/CLEANUP-TOOK (\d+)/.exec(stdout)?.[1] ?? Number.NaN);

describe("stall snapshot script generation", () => {
	it("watches compose up and only touches the stall snapshot pieces", async () => {
		const command = await build({
			deployGuardrails: { stallSnapshot: stall },
		});
		const start = command.indexOf("DOKPLOY_STALL_DIR=$(mktemp -d");
		const up = command.indexOf("up -d --build --remove-orphans", start);
		const failureCleanup = command.indexOf("|| { dokploy_stall_cleanup; echo");
		const successCleanup = command.indexOf(
			"\n\t\tdokploy_stall_cleanup;\n",
			failureCleanup,
		);
		expect(start).toBeGreaterThan(-1);
		expect(up).toBeGreaterThan(start);
		// Ended on the failure branch (before the restore runs) and after success.
		expect(failureCleanup).toBeGreaterThan(up);
		expect(successCleanup).toBeGreaterThan(failureCleanup);
		expect(command).toContain(
			`docker ps -a --filter ${quote(["label=com.docker.compose.project=my-app"])} --format ${quote(["{{.Names}}|{{.State}}|{{.Status}}|{{.CreatedAt}}"])}`,
		);
		expect(command).toContain(
			"DOKPLOY_STALL_NEXT=$(( DOKPLOY_STALL_T0 + 15 ))",
		);
		expect(command).toContain('"$DOKPLOY_STALL_N" -lt 5 ]');
		expect(command).toContain("head -n 200");
		expect(command).toContain("mktemp -d");
		expect(command).not.toContain("/tmp/dokploy");
		// Observe only: nothing else was asked for.
		expect(command).not.toContain("docker events");
		expect(command).not.toContain("dokploy_phase");
		expect(command).not.toContain("curl");
		expect(command).not.toContain("docker stack ps");
	});

	it("never asks docker for env, labels, mounts or command lines", async () => {
		const command = await build({
			deployGuardrails: { stallSnapshot: stall },
		});
		for (const forbidden of [
			"docker inspect",
			"docker exec",
			"docker logs",
			".Config",
			".Labels",
			".Mounts",
			".Command",
			"--no-trunc",
		]) {
			expect(command).not.toContain(forbidden);
		}
	});

	it("uses the swarm tasks for a stack", async () => {
		const command = await build({
			composeType: "stack",
			deployGuardrails: { stallSnapshot: stall },
		});
		expect(command).toContain(
			`docker stack ps my-app --format ${quote(["{{.Name}}|{{.CurrentState}}|{{.DesiredState}}|{{.Node}}"])}`,
		);
		expect(command).toContain("docker stack deploy still running");
		expect(command).not.toContain("docker ps -a");
	});

	it("starts after the events capture so the shared EXIT trap covers both", async () => {
		const command = await build({
			deployGuardrails: { dockerEvents: true, stallSnapshot: stall },
		});
		const events = command.indexOf("docker events --since");
		const eventsTrap = command.indexOf("trap 'dokploy_events_cleanup' EXIT;");
		const stallTrap = command.indexOf(
			"trap 'dokploy_stall_cleanup; if command -v dokploy_events_cleanup",
		);
		const up = command.indexOf("up -d --build --remove-orphans", stallTrap);
		expect(events).toBeGreaterThan(-1);
		expect(stallTrap).toBeGreaterThan(eventsTrap);
		expect(up).toBeGreaterThan(stallTrap);
		// Both are ended around up.
		expect(command).toContain(
			"|| { dokploy_stall_cleanup; dokploy_events_flush;",
		);
	});

	it("runs where up runs: after the pull of a build-server deploy", async () => {
		const command = await build(
			{ buildServerId: "build-1", deployGuardrails: { stallSnapshot: stall } },
			true,
		);
		const pull = command.indexOf("docker pull");
		const start = command.indexOf("DOKPLOY_STALL_DIR=$(mktemp -d");
		const up = command.indexOf("--no-build", start);
		expect(pull).toBeGreaterThan(-1);
		expect(start).toBeGreaterThan(pull);
		expect(up).toBeGreaterThan(start);
	});

	it("reaches the shell only through shell-quote", () => {
		const script = getStallSnapshotStartScript(
			"docker-compose",
			"app; rm -rf /",
			{
				...stall,
			},
		);
		expect(script).toContain(
			`--filter ${quote(["label=com.docker.compose.project=app; rm -rf /"])}`,
		);
		expect(script).toContain(`DOKPLOY_STALL_APP=${quote(["app; rm -rf /"])};`);
		const swarm = getStallSnapshotStartScript("stack", "app; rm -rf /", stall);
		expect(swarm).toContain(`docker stack ps ${quote(["app; rm -rf /"])} `);
	});
});

// ---------------------------------------------------------------------------
// Executed against a real POSIX shell with fake `docker` and `sleep`-based
// slow commands. Skipped where no usable `sh` exists.
// ---------------------------------------------------------------------------

const toShellPath = (path: string) =>
	process.platform === "win32"
		? path
				.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
				.replace(/\\/g, "/")
		: path;

const scriptDir = mkdtempSync(join(tmpdir(), "dokploy-stall-scripts-"));
let scriptCount = 0;
const writeScript = (script: string) => {
	const path = join(scriptDir, `script-${scriptCount++}.sh`);
	writeFileSync(path, script, { mode: 0o755 });
	return toShellPath(path);
};

const sh = (script: string, env: Record<string, string> = {}) =>
	spawnSync("sh", [writeScript(script)], {
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: 120_000,
	});

const hasSh = (() => {
	try {
		const result = sh("echo ok");
		return result.status === 0 && result.stdout.trim() === "ok";
	} catch {
		return false;
	}
})();

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasSh)("executed in a real shell", () => {
	let dir = "";
	let binDir = "";
	let psArgsFile = "";
	let psPidFile = "";
	let eventsPidFile = "";

	const writeBin = (name: string, body: string) => {
		const path = join(binDir, name);
		writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		chmodSync(path, 0o755);
	};

	// `compose` / `stack` stand in for a slow `up`; `ps` for the state command.
	const installDocker = ({
		upSleep,
		upExit = 0,
		psBody = `printf '%s\\n' "web-1|running|Up 5 seconds|2026-10-14 10:00:00 +0000 UTC" "web-old-1|removing|Removal In Progress|2026-10-14 09:00:00 +0000 UTC"`,
		psExit = 0,
		psHang = false,
	}: {
		upSleep: number;
		upExit?: number;
		psBody?: string;
		psExit?: number;
		psHang?: boolean | "ignore-term";
	}) => {
		writeBin(
			"docker",
			`case "$1" in
  ps|stack)
    if [ "$1" = "stack" ] && [ "$2" != "ps" ]; then sleep ${upSleep}; exit ${upExit}; fi
    printf '%s\\n' "$@" >> ${toShellPath(psArgsFile)}
    printf '%s\\n' ---- >> ${toShellPath(psArgsFile)}
    ${psHang === "ignore-term" ? `trap '' TERM; echo $$ > ${toShellPath(psPidFile)}; while :; do sleep 1; done` : psHang ? `echo $$ > ${toShellPath(psPidFile)}; exec sleep 300` : psBody}
    exit ${psExit} ;;
  events)
    echo $$ > ${toShellPath(eventsPidFile)}
    exec sleep 300 ;;
  compose) sleep ${upSleep}; exit ${upExit} ;;
  *) exit 0 ;;
esac`,
		);
	};

	const env = (extra: Record<string, string> = {}) => ({
		PATH: `${toShellPath(binDir)}:${process.env.PATH ?? ""}`,
		...extra,
	});

	const countBlocks = (stdout: string) =>
		(stdout.match(/----- Stall snapshot \d+\/\d+:/g) ?? []).length;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "dokploy-stall-"));
		binDir = join(dir, "bin");
		mkdirSync(binDir);
		psArgsFile = join(dir, "ps.args");
		psPidFile = join(dir, "ps.pid");
		eventsPidFile = join(dir, "events.pid");
	});

	afterAll(() => {
		rmSync(scriptDir, { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	});

	// The generator takes the numbers as they come; the schema bounds (15 s and
	// up) only apply to stored settings, so a script test can use 1 s steps.
	const fast = { afterSeconds: 1, everySeconds: 1, maxSnapshots: 3 };

	it("prints delimited, timestamped snapshots while up is slow, at most maxSnapshots", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0 });
		rmSync(psArgsFile, { force: true });
		const script = `${getStallSnapshotStartScript("docker-compose", "my-app", fast)}
sleep 9;
dokploy_stall_cleanup;
echo UP-DONE`;
		const result = sh(script, env());
		expect(result.status).toBe(0);
		expect(countBlocks(result.stdout)).toBe(3);
		expect(result.stdout).toMatch(
			/\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] ----- Stall snapshot 1\/3: docker compose up still running after \d+s, state of my-app -----/,
		);
		expect(result.stdout).toContain("----- End of stall snapshot 3/3 -----");
		expect(result.stdout).not.toContain("Stall snapshot 4/");
		expect(result.stdout).toContain("NAME|STATE|STATUS|CREATED");
		expect(result.stdout).toContain(
			"web-old-1|removing|Removal In Progress|2026-10-14 09:00:00 +0000 UTC",
		);
		expect(result.stdout).toContain("UP-DONE");
		// Exactly what the brief asks docker for.
		const calls = readFileSync(psArgsFile, "utf8").split("----\n");
		expect(calls[0]?.split("\n").filter(Boolean)).toEqual([
			"ps",
			"-a",
			"--filter",
			"label=com.docker.compose.project=my-app",
			"--format",
			"{{.Names}}|{{.State}}|{{.Status}}|{{.CreatedAt}}",
		]);
	});

	it("stops as soon as up returns: no snapshot when up is fast, none after it", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0 });
		const quick = sh(
			`${getStallSnapshotStartScript("docker-compose", "my-app", {
				afterSeconds: 5,
				everySeconds: 1,
				maxSnapshots: 3,
			})}
sleep 1;
dokploy_stall_cleanup;
sleep 8;
echo UP-DONE`,
			env(),
		);
		expect(quick.status).toBe(0);
		expect(countBlocks(quick.stdout)).toBe(0);
		expect(quick.stdout).toContain("UP-DONE");

		// Up returns after the first snapshot: the rest never appear.
		const slow = sh(
			`${getStallSnapshotStartScript("docker-compose", "my-app", {
				afterSeconds: 1,
				everySeconds: 4,
				maxSnapshots: 5,
			})}
sleep 3;
dokploy_stall_cleanup;
sleep 8;
echo UP-DONE`,
			env(),
		);
		expect(slow.status).toBe(0);
		expect(countBlocks(slow.stdout)).toBe(1);
	});

	it("through the real deploy script: snapshots while up runs, none once it returned", {
		timeout: 90_000,
	}, async () => {
		installDocker({ upSleep: 20 });
		const command = await build({
			deployGuardrails: {
				stallSnapshot: { afterSeconds: 15, everySeconds: 10, maxSnapshots: 5 },
			},
		});
		const runnable = command.replace(
			/cd "[^"]*";/,
			`cd "${toShellPath(dir)}";`,
		);
		const result = sh(`set -e;${runnable}`, env());
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Docker Compose Deployed: ✅");
		// up took 20 s, the first snapshot is due at 15 s, the second at 25 s.
		expect(countBlocks(result.stdout)).toBe(1);
		expect(result.stdout).toContain("Stall snapshot 1/5");
		// The block comes before the success line, never after the deploy ended.
		expect(result.stdout.indexOf("End of stall snapshot 1/5")).toBeLessThan(
			result.stdout.indexOf("Docker Compose Deployed"),
		);
	});

	it("is silent about a fast up and leaves nothing behind when up fails", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0, upExit: 1 });
		const command = await build({
			deployGuardrails: { stallSnapshot: stall },
		});
		const runnable = command.replace(
			/cd "[^"]*";/,
			`cd "${toShellPath(dir)}";`,
		);
		const result = sh(`set -e;${runnable}`, env());
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Error: ❌ Docker command failed");
		expect(countBlocks(result.stdout)).toBe(0);
	});

	it("uses docker stack ps for a swarm stack", {
		timeout: 60_000,
	}, async () => {
		installDocker({
			upSleep: 0,
			psBody: `printf '%s\\n' "my-app_web.1|Running 3 seconds ago|Running|node-1"`,
		});
		rmSync(psArgsFile, { force: true });
		const result = sh(
			`${getStallSnapshotStartScript("stack", "my-app", fast)}
sleep 3;
dokploy_stall_cleanup`,
			env(),
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("docker stack deploy still running");
		expect(result.stdout).toContain("TASK|CURRENT STATE|DESIRED STATE|NODE");
		expect(result.stdout).toContain(
			"my-app_web.1|Running 3 seconds ago|Running|node-1",
		);
		const first = readFileSync(psArgsFile, "utf8").split("----\n")[0];
		expect(first?.split("\n").filter(Boolean).slice(0, 3)).toEqual([
			"stack",
			"ps",
			"my-app",
		]);
	});

	it("caps each snapshot and says so", {
		timeout: 60_000,
	}, async () => {
		installDocker({
			upSleep: 0,
			psBody: `i=0; while [ $i -lt 12 ]; do echo "c$i|running|Up|t"; i=$((i + 1)); done`,
		});
		const result = sh(
			`${getStallSnapshotStartScript(
				"docker-compose",
				"my-app",
				{ afterSeconds: 1, everySeconds: 10, maxSnapshots: 1 },
				{ maxLines: 5 },
			)}
sleep 4;
dokploy_stall_cleanup`,
			env(),
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("c4|running|Up|t");
		expect(result.stdout).not.toContain("c5|running|Up|t");
		expect(result.stdout).toContain(
			"(truncated: showing the first 5 of 12 lines)",
		);
	});

	it("reports an empty, failing or hanging state command without failing the deploy", {
		timeout: 60_000,
	}, async () => {
		const one = { afterSeconds: 1, everySeconds: 10, maxSnapshots: 1 };
		installDocker({ upSleep: 0, psBody: "true" });
		const empty = sh(
			`${getStallSnapshotStartScript("docker-compose", "my-app", one)}
sleep 4;
dokploy_stall_cleanup`,
			env(),
		);
		expect(empty.status).toBe(0);
		expect(empty.stdout).toContain(
			"(no containers or tasks were listed for this project)",
		);

		installDocker({ upSleep: 0, psBody: "echo SECRET-STDERR >&2", psExit: 3 });
		const failing = sh(
			`${getStallSnapshotStartScript("docker-compose", "my-app", one)}
sleep 4;
dokploy_stall_cleanup`,
			env(),
		);
		expect(failing.status).toBe(0);
		expect(failing.stdout).toContain(
			"(the state command failed with exit code 3)",
		);
		// docker's own stderr is dropped, only the exit code is reported.
		expect(failing.stdout + failing.stderr).not.toContain("SECRET-STDERR");

		installDocker({ upSleep: 0, psHang: true });
		const script = getStallSnapshotStartScript("docker-compose", "my-app", one)
			.replace("-lt 20 ]", "-lt 2 ]")
			.replace("-ge 20 ]", "-ge 2 ]");
		const hanging = sh(
			`${script}
sleep 7;
dokploy_stall_cleanup`,
			env(),
		);
		expect(hanging.status).toBe(0);
		expect(hanging.stdout).toContain(
			"(the state command did not return within 20s and was stopped)",
		);
		const hungPid = readFileSync(psPidFile, "utf8").trim();
		expect(sh(`kill -0 ${hungPid} 2>/dev/null`).status).not.toBe(0);
	});

	it("does not print the environment, whatever the process has set", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0 });
		rmSync(psArgsFile, { force: true });
		const result = sh(
			// Waits for the first state command instead of a fixed sleep: under a loaded
			// CI runner the first snapshot can take longer than a few seconds to fire.
			`${getStallSnapshotStartScript("docker-compose", "my-app", fast)}
i=0; while [ "$i" -lt 30 ] && ! grep -q -- ---- ${toShellPath(psArgsFile)} 2>/dev/null; do sleep 1; i=$((i + 1)); done;
sleep 2;
dokploy_stall_cleanup`,
			env({
				DB_PASSWORD: "hunter2-super-secret",
				REGISTRY_TOKEN: "ghp_notforthelog",
			}),
		);
		expect(result.status).toBe(0);
		expect(countBlocks(result.stdout)).toBeGreaterThan(0);
		const output = result.stdout + result.stderr;
		expect(output).not.toContain("hunter2-super-secret");
		expect(output).not.toContain("ghp_notforthelog");
		expect(output).not.toMatch(/\bDB_PASSWORD\b|\bREGISTRY_TOKEN\b/);
		// And docker was only ever given the name/filter/format arguments.
		const args = readFileSync(psArgsFile, "utf8");
		expect(args).not.toMatch(/hunter2|ghp_|inspect|exec|logs/);
	});

	it("skips the snapshots instead of using a predictable path when mktemp fails", {
		timeout: 30_000,
	}, async () => {
		installDocker({ upSleep: 0 });
		rmSync(psArgsFile, { force: true });
		writeBin("mktemp", "exit 1");
		try {
			const result = sh(
				`${getStallSnapshotStartScript("docker-compose", "my-app", fast)}
sleep 3;
dokploy_stall_cleanup;
echo UP-DONE`,
				env(),
			);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				"Stall snapshots skipped: could not create a private temporary directory",
			);
			expect(result.stdout).toContain("UP-DONE");
			expect(existsSync(psArgsFile)).toBe(false);
		} finally {
			rmSync(join(binDir, "mktemp"), { force: true });
		}
	});

	it("removes the private directory and the watcher on a normal exit without the explicit cleanup", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0 });
		const dirFile = join(dir, "exit-dir.txt");
		const wdFile = join(dir, "exit-wd.txt");
		const result = sh(
			`${getStallSnapshotStartScript("docker-compose", "my-app", fast)}
echo "$DOKPLOY_STALL_DIR" > ${toShellPath(dirFile)}
echo "$DOKPLOY_STALL_WD_PID" > ${toShellPath(wdFile)}
sleep 2;
exit 1`,
			env(),
		);
		expect(result.status).toBe(1);
		const stallDir = readFileSync(dirFile, "utf8").trim();
		const wd = readFileSync(wdFile, "utf8").trim();
		expect(stallDir).not.toBe("");
		// The shell only asks the watcher to stop (it does not wait for it).
		for (
			let i = 0;
			i < 50 && sh(`kill -0 ${wd} 2>/dev/null`).status === 0;
			i++
		) {
			await sleepMs(100);
		}
		expect(sh(`test -d ${quote([stallDir])}`).status).not.toBe(0);
		expect(sh(`kill -0 ${wd} 2>/dev/null`).status).not.toBe(0);
	});

	it.each([
		["hangs", true],
		["ignores SIGTERM", "ignore-term"],
	] as const)(
		"leaves no watcher, state command or directory when the deploy shell is killed with SIGKILL and the state command %s",
		{
			timeout: 60_000,
		},
		async (_name, psHang) => {
			installDocker({ upSleep: 0, psHang });
			const parentFile = join(dir, "kill-parent.pid");
			const dirFile = join(dir, "kill-dir.txt");
			const wdFile = join(dir, "kill-wd.txt");
			for (const f of [parentFile, dirFile, wdFile, psPidFile]) {
				rmSync(f, { force: true });
			}
			const child = spawn(
				"sh",
				[
					writeScript(
						`echo $$ > ${toShellPath(parentFile)}; ${getStallSnapshotStartScript("docker-compose", "my-app", fast)}
echo "$DOKPLOY_STALL_DIR" > ${toShellPath(dirFile)}
echo "$DOKPLOY_STALL_WD_PID" > ${toShellPath(wdFile)}
sleep 60`,
					),
				],
				{ env: { ...process.env, ...env() }, stdio: "ignore" },
			);
			try {
				// Wait for the watcher to be inside a hanging state command.
				for (let i = 0; i < 100 && !existsSync(psPidFile); i++)
					await sleepMs(100);
				expect(existsSync(psPidFile)).toBe(true);
				const stallDir = readFileSync(dirFile, "utf8").trim();
				const wd = readFileSync(wdFile, "utf8").trim();
				const psPid = readFileSync(psPidFile, "utf8").trim();
				const parent = readFileSync(parentFile, "utf8").trim();
				expect(sh(`test -d ${quote([stallDir])}`).status).toBe(0);
				expect(sh(`kill -0 ${wd} 2>/dev/null`).status).toBe(0);
				expect(sh(`kill -9 ${parent}`).status).toBe(0);
				const gone = async (check: string) => {
					for (let i = 0; i < 100; i++) {
						await sleepMs(100);
						if (sh(check).status !== 0) return true;
					}
					return false;
				};
				expect(await gone(`kill -0 ${wd} 2>/dev/null`)).toBe(true);
				expect(await gone(`kill -0 ${psPid} 2>/dev/null`)).toBe(true);
				expect(await gone(`test -d ${quote([stallDir])}`)).toBe(true);
			} finally {
				child.kill();
			}
		},
	);

	it("sends SIGKILL to a state command that ignores SIGTERM, and the deploy shell is not held", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0, psHang: "ignore-term" });
		rmSync(psPidFile, { force: true });
		const script = getStallSnapshotStartScript("docker-compose", "my-app", {
			afterSeconds: 1,
			everySeconds: 30,
			maxSnapshots: 1,
		})
			.replace("-lt 20 ]", "-lt 2 ]")
			.replace("-ge 20 ]", "-ge 2 ]");
		const started = Date.now();
		// Timeout 2 s + grace 2 s after the command starts at ~1 s. Instead of a fixed
		// sleep, wait for the state command to start, then poll (up to 40 s) for it to
		// be reaped, so a loaded runner only makes the test slower, not wrong. Cleanup
		// runs after, so it cannot be what reaped it; a command that ignores SIGTERM
		// and never gets SIGKILL stays alive and the test reports STILL-ALIVE.
		const result = sh(
			`${script}
i=0; while [ "$i" -lt 100 ] && [ ! -s ${toShellPath(psPidFile)} ]; do sleep 0.2; i=$((i + 1)); done;
PSPID=$(cat ${toShellPath(psPidFile)});
i=0; while [ "$i" -lt 80 ] && kill -0 "$PSPID" 2>/dev/null; do sleep 0.5; i=$((i + 1)); done;
if kill -0 "$PSPID" 2>/dev/null; then echo STILL-ALIVE; else echo REAPED; fi
T0=$(date +%s);
dokploy_stall_cleanup;
echo "CLEANUP-TOOK $(( $(date +%s) - T0 ))"`,
			env(),
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("REAPED");
		expect(result.stdout).not.toContain("STILL-ALIVE");
		expect(result.stdout).toContain(
			"(the state command did not return within 20s and was stopped)",
		);
		// The shell's cleanup does not wait for the watcher.
		expect(cleanupSeconds(result.stdout)).toBeLessThanOrEqual(5);
		expect(Date.now() - started).toBeLessThan(30_000);
	});

	it("does not leave the state command behind when TERM lands before its pid is recorded", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0, psHang: true });
		rmSync(psPidFile, { force: true });
		const dirFile = join(dir, "race-dir.txt");
		const wdFile = join(dir, "race-wd.txt");
		// Deterministic race: the watcher TERMs itself right after starting the
		// command and before `$!` is recorded, which is where a trap that only
		// looks at the pid would see nothing to kill.
		const raced = getStallSnapshotStartScript(
			"docker-compose",
			"my-app",
			fast,
		).replace(
			"DOKPLOY_STALL_CMD_PID=$!;",
			`sh -c 'echo $PPID' > "$DOKPLOY_STALL_DIR/self"; sleep 1; kill -TERM "$(cat "$DOKPLOY_STALL_DIR/self")"; DOKPLOY_STALL_CMD_PID=$!;`,
		);
		expect(raced).toContain('kill -TERM "$(cat');
		const result = sh(
			`${raced}
echo "$DOKPLOY_STALL_DIR" > ${toShellPath(dirFile)}
echo "$DOKPLOY_STALL_WD_PID" > ${toShellPath(wdFile)}
sleep 5;
echo SHELL-DONE`,
			env(),
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("SHELL-DONE");
		expect(countBlocks(result.stdout)).toBe(0);
		expect(existsSync(psPidFile)).toBe(true);
		const psPid = readFileSync(psPidFile, "utf8").trim();
		const wd = readFileSync(wdFile, "utf8").trim();
		const stallDir = readFileSync(dirFile, "utf8").trim();
		// The state command was started, then put down by the watcher itself
		// (the shell had not asked for anything yet).
		expect(sh(`kill -0 ${psPid} 2>/dev/null`).status).not.toBe(0);
		expect(sh(`kill -0 ${wd} 2>/dev/null`).status).not.toBe(0);
		expect(sh(`test -d ${quote([stallDir])}`).status).not.toBe(0);
	});

	it("does not signal a watcher that hit its lifetime bound with the shell alive", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0 });
		const logFile = join(dir, "done-kill.log");
		rmSync(logFile, { force: true });
		// Shorten the lifetime bound so the test does not wait for the real one.
		const script = getStallSnapshotStartScript("docker-compose", "my-app", {
			afterSeconds: 1,
			everySeconds: 10,
			maxSnapshots: 1,
		}).replace(
			/(DOKPLOY_STALL_END=\$\(\( DOKPLOY_STALL_T0 \+ )\d+/,
			(_m, head: string) => `${head}4`,
		);
		const result = sh(
			`${script}
sleep 8;
if [ -e "$DOKPLOY_STALL_DIR/done" ]; then echo DONE-MARKER; fi
kill() { echo "KILL $*" >> ${toShellPath(logFile)}; command kill "$@"; }
dokploy_stall_cleanup;
echo "DIR-AFTER:$DOKPLOY_STALL_DIR:"`,
			env(),
		);
		expect(result.status).toBe(0);
		expect(countBlocks(result.stdout)).toBe(1);
		expect(result.stdout).toContain("DONE-MARKER");
		// Nothing was signalled, and the directory is gone.
		expect(existsSync(logFile)).toBe(false);
		expect(result.stdout).toContain("DIR-AFTER::");
	});

	it("stays alive after the last snapshot, and the shell's cleanup just signals it", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0 });
		const wdFile = join(dir, "idle-wd.txt");
		const dirFile = join(dir, "idle-dir.txt");
		const result = sh(
			`${getStallSnapshotStartScript("docker-compose", "my-app", {
				afterSeconds: 1,
				everySeconds: 10,
				maxSnapshots: 1,
			})}
echo "$DOKPLOY_STALL_WD_PID" > ${toShellPath(wdFile)}
echo "$DOKPLOY_STALL_DIR" > ${toShellPath(dirFile)}
sleep 5;
if kill -0 "$DOKPLOY_STALL_WD_PID" 2>/dev/null; then echo IDLE-ALIVE; fi
if [ -d "$DOKPLOY_STALL_DIR" ] && [ ! -e "$DOKPLOY_STALL_DIR/done" ]; then echo DIR-KEPT; fi
T0=$(date +%s);
dokploy_stall_cleanup;
echo "CLEANUP-TOOK $(( $(date +%s) - T0 ))"
sleep 3;
if kill -0 "$(cat ${toShellPath(wdFile)})" 2>/dev/null; then echo WATCHER-LEFT; else echo WATCHER-GONE; fi`,
			env(),
		);
		expect(result.status).toBe(0);
		expect(countBlocks(result.stdout)).toBe(1);
		expect(result.stdout).toContain("IDLE-ALIVE");
		expect(result.stdout).toContain("DIR-KEPT");
		expect(cleanupSeconds(result.stdout)).toBeLessThanOrEqual(5);
		expect(result.stdout).toContain("WATCHER-GONE");
		const stallDir = readFileSync(dirFile, "utf8").trim();
		expect(sh(`test -d ${quote([stallDir])}`).status).not.toBe(0);
	});

	it("removes the directory when the shell is killed with SIGKILL after the last snapshot", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0 });
		const parentFile = join(dir, "late-parent.pid");
		const dirFile = join(dir, "late-dir.txt");
		const wdFile = join(dir, "late-wd.txt");
		for (const f of [parentFile, dirFile, wdFile, psArgsFile]) {
			rmSync(f, { force: true });
		}
		const child = spawn(
			"sh",
			[
				writeScript(
					`echo $$ > ${toShellPath(parentFile)}; ${getStallSnapshotStartScript(
						"docker-compose",
						"my-app",
						{
							afterSeconds: 1,
							everySeconds: 10,
							maxSnapshots: 1,
						},
					)}
echo "$DOKPLOY_STALL_DIR" > ${toShellPath(dirFile)}
echo "$DOKPLOY_STALL_WD_PID" > ${toShellPath(wdFile)}
sleep 60`,
				),
			],
			{ env: { ...process.env, ...env() }, stdio: "ignore" },
		);
		try {
			// The only snapshot has been taken once docker ps ran; give it time to finish.
			for (let i = 0; i < 100 && !existsSync(psArgsFile); i++)
				await sleepMs(100);
			expect(existsSync(psArgsFile)).toBe(true);
			await sleepMs(1500);
			const stallDir = readFileSync(dirFile, "utf8").trim();
			const wd = readFileSync(wdFile, "utf8").trim();
			expect(sh(`kill -0 ${wd} 2>/dev/null`).status).toBe(0);
			expect(sh(`test -d ${quote([stallDir])}`).status).toBe(0);
			expect(
				sh(`kill -9 ${readFileSync(parentFile, "utf8").trim()}`).status,
			).toBe(0);
			let gone = false;
			for (let i = 0; i < 100 && !gone; i++) {
				await sleepMs(100);
				gone = sh(`test -d ${quote([stallDir])}`).status !== 0;
			}
			expect(gone).toBe(true);
			expect(sh(`kill -0 ${wd} 2>/dev/null`).status).not.toBe(0);
		} finally {
			child.kill();
		}
	});

	it("ends a stubborn command after the grace when TERM lands just before the watcher waits for it", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0, psHang: "ignore-term" });
		rmSync(psPidFile, { force: true });
		// TERM arrives after the flag check and before `wait` starts: it cannot
		// interrupt the wait, so the killer has to notice the stop file.
		const raced = getStallSnapshotStartScript("docker-compose", "my-app", {
			afterSeconds: 1,
			everySeconds: 30,
			maxSnapshots: 1,
		}).replace(
			'wait "$DOKPLOY_STALL_CMD_PID" 2>/dev/null; DOKPLOY_STALL_RC=$?;',
			`sleep 1; sh -c 'echo $PPID' > "$DOKPLOY_STALL_DIR/self"; kill -TERM "$(cat "$DOKPLOY_STALL_DIR/self")"; wait "$DOKPLOY_STALL_CMD_PID" 2>/dev/null; DOKPLOY_STALL_RC=$?;`,
		);
		expect(raced).toContain('kill -TERM "$(cat');
		// Command starts at ~1 s, the TERM is at ~2 s, the killer notices within 1 s,
		// then 2 s grace: gone by ~5 s. Without the stop file it would live to ~21 s.
		const result = sh(
			`${raced}
sleep 8;
if kill -0 "$(cat ${toShellPath(psPidFile)})" 2>/dev/null; then echo STILL-ALIVE; else echo REAPED; fi`,
			env(),
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("REAPED");
		expect(result.stdout).not.toContain("STILL-ALIVE");
		expect(countBlocks(result.stdout)).toBe(0);
	});

	it("returns from the shell's cleanup at once while a stubborn command is still active, and puts the command down after the grace", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0, psHang: "ignore-term" });
		rmSync(psPidFile, { force: true });
		const result = sh(
			`${getStallSnapshotStartScript("docker-compose", "my-app", {
				afterSeconds: 1,
				everySeconds: 30,
				maxSnapshots: 1,
			})}
sleep 3;
PSPID=$(cat ${toShellPath(psPidFile)});
T0=$(date +%s);
dokploy_stall_cleanup;
echo "CLEANUP-TOOK $(( $(date +%s) - T0 ))"
if kill -0 "$PSPID" 2>/dev/null; then echo ALIVE-IN-GRACE; fi
sleep 5;
if kill -0 "$PSPID" 2>/dev/null; then echo STILL-ALIVE; else echo REAPED; fi`,
			env(),
		);
		expect(result.status).toBe(0);
		expect(cleanupSeconds(result.stdout)).toBeLessThanOrEqual(5);
		expect(result.stdout).toContain("ALIVE-IN-GRACE");
		expect(result.stdout).toContain("REAPED");
		expect(result.stdout).not.toContain("STILL-ALIVE");
		expect(countBlocks(result.stdout)).toBe(0);
	});

	it("never runs snapshots back to back when the state command is slower than the interval", {
		timeout: 60_000,
	}, async () => {
		const timesFile = join(dir, "burst.times");
		rmSync(timesFile, { force: true });
		installDocker({
			upSleep: 0,
			psBody: `echo "S $(date +%s)" >> ${toShellPath(timesFile)}; sleep 3; echo "E $(date +%s)" >> ${toShellPath(timesFile)}; echo 'c|running|Up|t'`,
		});
		const result = sh(
			`${getStallSnapshotStartScript("docker-compose", "my-app", {
				afterSeconds: 1,
				everySeconds: 3,
				maxSnapshots: 3,
			})}
i=0; while [ "$i" -lt 160 ] && [ "$(grep -c '^E ' ${toShellPath(timesFile)} 2>/dev/null)" != 3 ]; do sleep 0.25; i=$((i + 1)); done;
sleep 3;
dokploy_stall_cleanup`,
			env(),
		);
		expect(result.status).toBe(0);
		// Capped at maxSnapshots: the trailing sleep leaves room for a 4th to start.
		expect(countBlocks(result.stdout)).toBe(3);
		const lines = readFileSync(timesFile, "utf8").trim().split("\n");
		const at = (tag: string) =>
			lines
				.filter((l) => l.startsWith(`${tag} `))
				.map((l) => Number(l.split(" ")[1]));
		const starts = at("S");
		const ends = at("E");
		expect(starts).toHaveLength(3);
		// The pause after each snapshot is the interval (+-1 s for the clock).
		for (let i = 1; i < starts.length; i++) {
			expect(
				(starts[i] as number) - (ends[i - 1] as number),
			).toBeGreaterThanOrEqual(2);
		}
	});

	it("schedules from the previous deadline: a slow state command does not stretch the interval", {
		timeout: 60_000,
	}, async () => {
		rmSync(psArgsFile, { force: true });
		installDocker({ upSleep: 0, psBody: "sleep 2; echo 'c|running|Up|t'" });
		const result = sh(
			`${getStallSnapshotStartScript("docker-compose", "my-app", {
				afterSeconds: 1,
				everySeconds: 4,
				maxSnapshots: 3,
			})}
i=0; while [ "$i" -lt 160 ] && [ "$(grep -c '^----$' ${toShellPath(psArgsFile)} 2>/dev/null)" != 3 ]; do sleep 0.25; i=$((i + 1)); done;
sleep 4;
dokploy_stall_cleanup`,
			env(),
		);
		expect(result.status).toBe(0);
		const elapsed = [
			...result.stdout.matchAll(/Stall snapshot \d\/3: .* after (\d+)s,/g),
		].map((m) => Number(m[1]));
		expect(elapsed).toHaveLength(3);
		// Commands start at 1, 5 and 9 s and take 2 s: 3, 7, 11. Rescheduling from
		// "now + every" would give 3, 9, 15 (gaps of 6). Gaps, not absolute times, so
		// a slow start on a loaded runner does not matter; +-1 s covers the clock.
		const gaps = [elapsed[1]! - elapsed[0]!, elapsed[2]! - elapsed[1]!];
		for (const gap of gaps) {
			expect(gap).toBeGreaterThanOrEqual(3);
			expect(gap).toBeLessThanOrEqual(5);
		}
	});

	it("cleans up both the stall watcher and the events capture, whichever is killed with the shell", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0, psHang: false });
		const parentFile = join(dir, "both-parent.pid");
		const stallDirFile = join(dir, "both-stall-dir.txt");
		const stallWdFile = join(dir, "both-stall-wd.txt");
		const eventsDirFile = join(dir, "both-events-dir.txt");
		for (const f of [parentFile, stallDirFile, stallWdFile, eventsDirFile]) {
			rmSync(f, { force: true });
		}
		rmSync(eventsPidFile, { force: true });
		const child = spawn(
			"sh",
			[
				writeScript(
					`echo $$ > ${toShellPath(parentFile)}; ${getDockerEventsStartScript("docker-compose", "my-app")}
${getStallSnapshotStartScript("docker-compose", "my-app", fast)}
echo "$DOKPLOY_STALL_DIR" > ${toShellPath(stallDirFile)}
echo "$DOKPLOY_STALL_WD_PID" > ${toShellPath(stallWdFile)}
echo "$DOKPLOY_EVENTS_DIR" > ${toShellPath(eventsDirFile)}
sleep 60`,
				),
			],
			{ env: { ...process.env, ...env() }, stdio: "ignore" },
		);
		try {
			for (let i = 0; i < 100 && !existsSync(eventsDirFile); i++)
				await sleepMs(100);
			for (let i = 0; i < 100 && !existsSync(eventsPidFile); i++)
				await sleepMs(100);
			const stallDir = readFileSync(stallDirFile, "utf8").trim();
			const wd = readFileSync(stallWdFile, "utf8").trim();
			const eventsDir = readFileSync(eventsDirFile, "utf8").trim();
			const eventsPid = readFileSync(eventsPidFile, "utf8").trim();
			expect(stallDir).not.toBe("");
			expect(eventsDir).not.toBe("");
			expect(eventsDir).not.toBe(stallDir);
			sh(`kill -9 ${readFileSync(parentFile, "utf8").trim()}`);
			const gone = async (check: string) => {
				for (let i = 0; i < 100; i++) {
					await sleepMs(100);
					if (sh(check).status !== 0) return true;
				}
				return false;
			};
			expect(await gone(`kill -0 ${wd} 2>/dev/null`)).toBe(true);
			expect(await gone(`kill -0 ${eventsPid} 2>/dev/null`)).toBe(true);
			expect(await gone(`test -d ${quote([stallDir])}`)).toBe(true);
			expect(await gone(`test -d ${quote([eventsDir])}`)).toBe(true);
		} finally {
			child.kill();
		}
	});

	it("an exit trap ends both when the shell exits normally with both guardrails on", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upSleep: 0 });
		const stallDirFile = join(dir, "norm-stall-dir.txt");
		const eventsDirFile = join(dir, "norm-events-dir.txt");
		rmSync(eventsPidFile, { force: true });
		const result = sh(
			`${getDockerEventsStartScript("docker-compose", "my-app")}
${getStallSnapshotStartScript("docker-compose", "my-app", fast)}
echo "$DOKPLOY_STALL_DIR" > ${toShellPath(stallDirFile)}
echo "$DOKPLOY_EVENTS_DIR" > ${toShellPath(eventsDirFile)}
sleep 2;
exit 0`,
			env(),
		);
		expect(result.status).toBe(0);
		await sleepMs(500);
		for (const file of [stallDirFile, eventsDirFile]) {
			const d = readFileSync(file, "utf8").trim();
			expect(d).not.toBe("");
			expect(sh(`test -d ${quote([d])}`).status).not.toBe(0);
		}
		const eventsPid = readFileSync(eventsPidFile, "utf8").trim();
		expect(sh(`kill -0 ${eventsPid} 2>/dev/null`).status).not.toBe(0);
	});
});
