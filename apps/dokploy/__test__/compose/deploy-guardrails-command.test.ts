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
	getHealthCheckScript,
	getPhaseLogLine,
} from "@dokploy/server/utils/builders/compose-guardrails";
import { quote } from "shell-quote";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Same isolation as build-compose-command.test.ts: we only care about the
// docker invocation, not the compose-file I/O of writeDomainsToCompose.
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

const remoteOverrides = { buildServerId: "build-1" };

const GUARDRAIL_MARKERS = [
	"dokploy_phase",
	"dokploy_events",
	"docker events",
	"DOKPLOY_EVENTS",
	"curl",
	"Health check",
	"dokploy_stall",
	"DOKPLOY_STALL",
	"Stall snapshot",
];

describe("guardrails off: the deploy script is untouched", () => {
	const offValues: Array<[string, unknown]> = [
		["undefined", undefined],
		["null", null],
		["an empty object", {}],
		[
			"every flag false",
			{ phaseTimestamps: false, dockerEvents: false, healthCheck: null },
		],
		["stallSnapshot null", { stallSnapshot: null }],
		["a malformed stallSnapshot", { stallSnapshot: { afterSeconds: 1 } }],
		["a malformed value", { healthCheck: { url: "ftp://nope" } }],
	];

	it.each(offValues)(
		"%s produces the same script as no setting",
		async (_name, value) => {
			for (const [overrides, remote] of [
				[{}, false],
				[{ composeType: "stack" }, false],
				[{ isolatedDeployment: true }, false],
				[remoteOverrides, true],
			] as Array<[Record<string, unknown>, boolean]>) {
				const reference = await build(overrides, remote);
				const withValue = await build(
					{ ...overrides, deployGuardrails: value },
					remote,
				);
				expect(withValue).toBe(reference);
				for (const marker of GUARDRAIL_MARKERS) {
					expect(withValue).not.toContain(marker);
				}
			}
		},
	);

	it("keeps the docker line and its failure branch exactly as before", async () => {
		const command = await build();
		expect(command).toContain(
			'env -i PATH="$PATH" HOME="$HOME"  docker compose -p my-app',
		);
		expect(command).toContain('|| { echo "Error: ❌ Docker command failed"; ');
		expect(command).not.toContain("trap");
	});
});

describe("phase timestamps", () => {
	it("brackets compose up with UTC-stamped phase lines", async () => {
		const command = await build({
			deployGuardrails: { phaseTimestamps: true },
		});
		expect(command).toContain("dokploy_phase_start() {");
		expect(command).toContain("date -u +%Y-%m-%dT%H:%M:%SZ");
		const start = command.indexOf(
			"dokploy_phase_start 'Build and start containers (compose up)';",
		);
		const up = command.indexOf("up -d --build --remove-orphans", start);
		const failed = command.indexOf("dokploy_phase_end failed;");
		const finished = command.indexOf("dokploy_phase_end finished;");
		expect(start).toBeGreaterThan(-1);
		expect(up).toBeGreaterThan(start);
		expect(failed).toBeGreaterThan(up);
		expect(finished).toBeGreaterThan(failed);
		// Only the timestamps were asked for.
		expect(command).not.toContain("docker events");
		expect(command).not.toContain("curl");
	});

	it("labels a stack deploy as such", async () => {
		const command = await build({
			composeType: "stack",
			deployGuardrails: { phaseTimestamps: true },
		});
		expect(command).toContain(
			"dokploy_phase_start 'Deploy stack (docker stack deploy)';",
		);
	});

	it("also stamps the image pull of a build-server deploy", async () => {
		const command = await build(
			{ ...remoteOverrides, deployGuardrails: { phaseTimestamps: true } },
			true,
		);
		const pullStart = command.indexOf("dokploy_phase_start 'Pull images';");
		const pull = command.indexOf("docker pull");
		const pullEnd = command.indexOf(
			'if [ "$PULL_OK" = "1" ]; then dokploy_phase_end finished; else dokploy_phase_end failed; fi',
		);
		const upStart = command.indexOf(
			"dokploy_phase_start 'Start containers (compose up)';",
		);
		expect(pullStart).toBeGreaterThan(-1);
		expect(pull).toBeGreaterThan(pullStart);
		expect(pullEnd).toBeGreaterThan(pull);
		expect(upStart).toBeGreaterThan(pullEnd);
	});

	it("writes the Dokploy-side phase lines with the host clock", () => {
		expect(getPhaseLogLine("Fetch source: started")).toBe(
			`echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)]" 'Fetch source: started'`,
		);
	});
});

describe("docker events capture", () => {
	it("starts a project-scoped background process right before up and flushes it after", async () => {
		const command = await build({ deployGuardrails: { dockerEvents: true } });
		const start = command.indexOf("docker events --since");
		const up = command.indexOf("up -d --build --remove-orphans", start);
		const failureFlush = command.indexOf("|| { dokploy_events_flush; echo");
		const successFlush = command.indexOf(
			"\n\t\tdokploy_events_flush;\n",
			failureFlush,
		);
		expect(start).toBeGreaterThan(-1);
		expect(command).toContain(
			`--filter ${quote(["label=com.docker.compose.project=my-app"])}`,
		);
		expect(command).toContain(
			`--format ${quote(["{{.TimeNano}}|{{.Type}}|{{.Action}}|{{.Actor.Attributes.name}}"])}`,
		);
		expect(up).toBeGreaterThan(start);
		// Flushed (and the process stopped) on the failure branch, before the
		// restore runs, and again right after a successful up.
		expect(failureFlush).toBeGreaterThan(up);
		expect(successFlush).toBeGreaterThan(failureFlush);
		// Capped, and says so.
		expect(command).toContain("tail -n 500");
		expect(command).toContain("(truncated: showing the last 500 of");
	});

	it("only records an allow-list of container events, never exec_*", async () => {
		const command = await build({ deployGuardrails: { dockerEvents: true } });
		expect(command).toContain(`--filter ${quote(["type=container"])}`);
		for (const action of [
			"create",
			"start",
			"die",
			"kill",
			"stop",
			"destroy",
			"health_status",
			"oom",
		]) {
			expect(command).toContain(`--filter ${quote([`event=${action}`])}`);
		}
		expect(command).not.toContain("exec_");
	});

	it("has a trap, a parent watchdog and a hard timeout as safety nets", async () => {
		const command = await build({ deployGuardrails: { dockerEvents: true } });
		expect(command).toContain(`trap 'dokploy_events_cleanup' EXIT;`);
		expect(command).toContain("timeout 3600 docker events");
		expect(command).toContain('while kill -0 "$DOKPLOY_SHELL_PID"');
		// The capture is started by the watchdog, in a private mktemp -d dir.
		expect(command).toContain("mktemp -d");
		expect(command).not.toContain("/tmp/dokploy");
		expect(command).toContain("DOKPLOY_WD_END");
		// Also without `timeout` installed.
		expect(command).toMatch(/else\s+docker events --since/);
	});

	it("builds the empty-events message entirely through quote()", () => {
		const script = getDockerEventsStartScript("docker-compose", 'a"b$(x)');
		expect(script).toContain(
			`echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)]" ${quote(['No docker events were recorded for a"b$(x) during the compose up window'])};`,
		);
	});

	it("scopes a swarm stack on its namespace label", async () => {
		const command = await build({
			composeType: "stack",
			deployGuardrails: { dockerEvents: true },
		});
		expect(command).toContain(
			`--filter ${quote(["label=com.docker.stack.namespace=my-app"])}`,
		);
		expect(command).not.toContain("com.docker.compose.project");
	});

	it("runs where up runs: inside the same script for a build-server deploy", async () => {
		const command = await build(
			{ ...remoteOverrides, deployGuardrails: { dockerEvents: true } },
			true,
		);
		const pull = command.indexOf("docker pull");
		const events = command.indexOf("docker events --since");
		const up = command.indexOf("--no-build", events);
		expect(pull).toBeGreaterThan(-1);
		// The pull is not part of the capture window; `up` is.
		expect(events).toBeGreaterThan(pull);
		expect(up).toBeGreaterThan(events);
	});

	it("quotes the app name used in the filter", () => {
		const script = getDockerEventsStartScript(
			"docker-compose",
			"app; rm -rf /",
		);
		expect(script).toContain(
			`--filter ${quote(["label=com.docker.compose.project=app; rm -rf /"])}`,
		);
	});
});

describe("health check script generation", () => {
	const healthCheck = {
		url: "http://localhost:3000/health",
		timeoutSeconds: 60,
	};

	it("polls with curl after up, before the deploy is marked successful", async () => {
		const command = await build({ deployGuardrails: { healthCheck } });
		const up = command.indexOf("up -d --build --remove-orphans");
		const check = command.indexOf("curl -s -L");
		const lastGood = command.indexOf(
			"Could not refresh the last-good snapshot",
		);
		const deployed = command.indexOf('echo "Docker Compose Deployed: ✅"');
		expect(check).toBeGreaterThan(up);
		expect(lastGood).toBeGreaterThan(check);
		expect(deployed).toBeGreaterThan(lastGood);
		expect(command).toContain(quote([healthCheck.url]));
		// 2 s between attempts, any 2xx by default, no rollback on failure.
		expect(command).toContain("HC_SLEEP=2;");
		expect(command).toContain("2??) HC_OK=1");
		expect(command).not.toContain("dokploy_events");
	});

	it("matches an exact status when one is configured", async () => {
		const command = await build({
			deployGuardrails: {
				healthCheck: { ...healthCheck, expectedStatus: 204 },
			},
		});
		expect(command).toContain("204) HC_OK=1");
		expect(command).toContain("to answer 204");
	});

	it("does not roll back when the check fails", async () => {
		const command = await build({ deployGuardrails: { healthCheck } });
		const failure = command.slice(command.indexOf("Health check failed"));
		expect(failure).toContain("exit 1;");
		expect(failure.slice(0, failure.indexOf("exit 1;"))).not.toContain(
			"Restoring previous working deployment",
		);
	});

	it("hardens curl: globoff, bounded redirects, http(s) only, exit status checked", async () => {
		const command = await build({ deployGuardrails: { healthCheck } });
		expect(command).toContain(
			"curl -s -L --globoff --max-redirs 5 --proto =http,https --proto-redir =http,https",
		);
		expect(command).toContain("if HC_CODE=$(curl -s -L --globoff");
		expect(command).toContain(
			'if [ "$HC_RC" = "0" ] && [ "$HC_NOW" -lt "$HC_DEADLINE" ]',
		);
	});

	it("caps every request and sleep to the time that is left", async () => {
		const command = await build({ deployGuardrails: { healthCheck } });
		expect(command).toContain('--max-time "$HC_MAX"');
		expect(command).toContain("HC_REMAIN=$(( HC_DEADLINE - HC_NOW ))");
		expect(command).toContain('sleep "$HC_SLEEP"');
	});

	it("prints a heartbeat while polling", async () => {
		const command = await build({ deployGuardrails: { healthCheck } });
		expect(command).toContain("-ge 30 ]");
		expect(command).toContain("Health check: still waiting");
	});

	it("never prints the query string or fragment of the URL", async () => {
		const command = await build({
			deployGuardrails: {
				healthCheck: {
					url: "https://example.com:8443/up?token=SECRET123#frag",
					timeoutSeconds: 10,
				},
			},
		});
		// Only the curl argument itself carries the query.
		const lines = command.split("\n").filter((l) => l.includes("SECRET123"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("curl ");
		expect(command).toContain("https://example.com:8443/…");
		expect(command).not.toContain("#frag'");
	});

	it("logs scheme and host only: a token in the path never reaches the log", async () => {
		const command = await build({
			deployGuardrails: {
				healthCheck: {
					url: "https://example.com/hook/PATHTOKEN",
					timeoutSeconds: 10,
				},
			},
		});
		const lines = command
			.split(String.fromCharCode(10))
			.filter((l) => l.includes("PATHTOKEN"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("curl ");
		expect(command).toContain("waiting up to 10s for https://example.com/…");
	});

	it("rejects a success in the last second of the deadline (strict comparison)", async () => {
		const command = await build({ deployGuardrails: { healthCheck } });
		expect(command).toContain('[ "$HC_NOW" -lt "$HC_DEADLINE" ]');
		expect(command).toContain("Wall clock (date +%s)");
	});

	it("says the release was left running when the check fails", async () => {
		const command = await build({ deployGuardrails: { healthCheck } });
		expect(command).toContain(
			"The new release was left running; no automatic rollback was performed.",
		);
	});

	it("is skipped with a log line for a swarm stack", async () => {
		const command = await build({
			composeType: "stack",
			deployGuardrails: { healthCheck },
		});
		expect(command).toContain(
			"Health check skipped: docker stack deploy returns",
		);
		expect(command).not.toContain("curl");
		expect(command).not.toContain("HC_DEADLINE");
	});

	it("falls back to the default timeout when parsed from a minimal object", async () => {
		const command = await build({
			deployGuardrails: { healthCheck: { url: "http://localhost/h" } },
		});
		expect(command).toContain("HC_START + 60 ))");
	});
});

// ---------------------------------------------------------------------------
// Executed against a real POSIX shell with fake `docker` and `curl` binaries.
// Skipped where no usable `sh` exists.
// ---------------------------------------------------------------------------

// The shell sees MSYS paths on Windows; keep scripts in a path both agree on.
const toShellPath = (path: string) =>
	process.platform === "win32"
		? path
				.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
				.replace(/\\/g, "/")
		: path;

// Windows' argv quoting mangles quotes and backslashes in a long `sh -c`
// string, so scripts are run from a file instead (as the real thing is run
// through a shell too, not through argv).
const scriptDir = mkdtempSync(join(tmpdir(), "dokploy-guardrails-scripts-"));
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
		timeout: 60_000,
	});

const hasSh = (() => {
	try {
		const result = sh("echo ok");
		return result.status === 0 && result.stdout.trim() === "ok";
	} catch {
		return false;
	}
})();

describe.skipIf(!hasSh)("executed in a real shell", () => {
	let dir = "";
	let binDir = "";
	let pidFile = "";
	let argsFile = "";
	let eventsArgsFile = "";
	let eventsReadyFile = "";
	let pwnedFile = "";

	const writeBin = (name: string, body: string) => {
		const path = join(binDir, name);
		writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		chmodSync(path, 0o755);
	};

	const installDocker = ({
		upExit,
		upSleep = 1,
		events = 3,
		extraEvents = "",
		awaitEvents = false,
	}: {
		upExit: number;
		upSleep?: number;
		events?: number;
		extraEvents?: string;
		// Makes `up` wait until the backgrounded events stub has written its lines,
		// so a loaded runner cannot stop the capture before they exist.
		awaitEvents?: boolean;
	}) => {
		rmSync(eventsReadyFile, { force: true });
		writeBin(
			"docker",
			`case "$1" in
  events)
    echo $$ > ${toShellPath(pidFile)}
    printf '%s\\n' "$@" > ${toShellPath(eventsArgsFile)}
    i=0
    while [ $i -lt ${events} ]; do echo "17000000$((10 + i))123456789|container|start|web$i"; i=$((i + 1)); done
    ${extraEvents}
    : > ${toShellPath(eventsReadyFile)}
    exec sleep 300 ;;
  stack|compose)
    ${awaitEvents ? `i=0; while [ ! -e ${toShellPath(eventsReadyFile)} ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done` : ":"}
    sleep ${upSleep}; exit ${upExit} ;;
  *) exit 0 ;;
esac`,
		);
	};

	const installCurl = (
		status: string,
		{ exit = 0, delay = 0 }: { exit?: number; delay?: number } = {},
	) => {
		writeBin(
			"curl",
			`printf '%s\\n' "$@" >> ${toShellPath(argsFile)}\n${delay ? `sleep ${delay}\n` : ""}printf '${status}'\nexit ${exit}`,
		);
	};

	const runStackDeploy = async (
		deployGuardrails: unknown,
		overrides: Record<string, unknown> = {},
	) => {
		rmSync(argsFile, { force: true });
		const command = await build({
			composeType: "docker-compose",
			deployGuardrails,
			...overrides,
		});
		// The script `cd`s into the project directory, which does not exist here.
		const runnable = command.replace(
			/cd "[^"]*";/,
			`cd "${toShellPath(dir)}";`,
		);
		const out = sh(`set -e;${runnable}`, {
			PATH: `${toShellPath(binDir)}:${process.env.PATH ?? ""}`,
		});
		if (process.env.GR_DEBUG) console.log(out.stdout, out.stderr);
		return out;
	};

	const hasPid = () =>
		existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "";

	const processIsGone = async () => {
		const pid = readFileSync(pidFile, "utf8").trim();
		for (let i = 0; i < 100; i++) {
			if (sh(`kill -0 ${pid} 2>/dev/null`).status !== 0) return true;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return false;
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "dokploy-guardrails-"));
		binDir = join(dir, "bin");
		mkdirSync(binDir);
		pidFile = join(dir, "events.pid");
		argsFile = join(dir, "curl.args");
		eventsArgsFile = join(dir, "events.args");
		eventsReadyFile = join(dir, "events.ready");
		pwnedFile = join(dir, "pwned");
	});

	afterAll(() => {
		rmSync(scriptDir, { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	});

	it("appends readable, capped docker events and stops the process after a successful up", async () => {
		installDocker({ upExit: 0, events: 3, awaitEvents: true });
		const result = await runStackDeploy({ dockerEvents: true });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Docker Compose Deployed: ✅");
		expect(result.stdout).toContain(
			"Docker events for my-app during the compose up window (UTC)",
		);
		// TimeNano is turned into an ISO time with milliseconds.
		expect(result.stdout).toMatch(
			/2023-11-14T22:13:30\.123Z container start web0\n/,
		);
		expect(result.stdout).not.toContain("truncated");
		expect(await processIsGone()).toBe(true);
	});

	it("passes docker an allow-list filter and never prints an exec command line", async () => {
		installDocker({
			upExit: 0,
			events: 1,
			awaitEvents: true,
			// Defence in depth: even if an exec event slipped through, only the
			// part before the first ':' is printed; the health status survives.
			extraEvents: [
				`echo "1700000099123456789|container|exec_start: sh -c 'psql postgres://u:SECRETPW@db/x'|web0"`,
				`echo "1700000100123456789|container|health_status: unhealthy|web0"`,
				`echo "1700000101123456789|container|health_status: rm -rf SECRETPW|web0"`,
			].join("\n"),
		});
		const result = await runStackDeploy({ dockerEvents: true });
		expect(result.status).toBe(0);
		expect(result.stdout).not.toContain("SECRETPW");
		expect(result.stdout).not.toContain("psql");
		expect(result.stdout).toContain("container exec_start web0");
		expect(result.stdout).toContain("container health_status: unhealthy web0");
		expect(result.stdout).toContain("container health_status web0");
		const args = readFileSync(eventsArgsFile, "utf8").split("\n");
		expect(args).toContain("type=container");
		expect(args).toContain("event=die");
		expect(args).toContain("event=health_status");
		expect(args.some((arg) => arg.startsWith("event=exec"))).toBe(false);
		expect(args).toContain("label=com.docker.compose.project=my-app");
		expect(await processIsGone()).toBe(true);
	});

	it("ends the events process when the deploy shell is killed with SIGKILL", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upExit: 0, events: 1 });
		const parentFile = join(dir, "parent.pid");
		const dirFile = join(dir, "events-dir.txt");
		rmSync(dirFile, { force: true });
		rmSync(pidFile, { force: true });
		const child = spawn(
			"sh",
			[
				writeScript(
					`echo $$ > ${toShellPath(parentFile)}; ${getDockerEventsStartScript("docker-compose", "my-app")}
echo "$DOKPLOY_EVENTS_DIR" > ${toShellPath(dirFile)}
sleep 20`,
				),
			],
			{
				env: {
					...process.env,
					PATH: `${toShellPath(binDir)}:${process.env.PATH ?? ""}`,
				},
				stdio: "ignore",
			},
		);
		try {
			for (let i = 0; i < 100 && !(hasPid() && existsSync(dirFile)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(hasPid()).toBe(true);
			const eventsDir = readFileSync(dirFile, "utf8").trim();
			expect(eventsDir).not.toBe("");
			expect(sh(`test -d ${quote([eventsDir])}`).status).toBe(0);
			// Killed the moment the capture exists: no trap runs for SIGKILL and the
			// rest of the startup never happens, only the watchdog can stop it.
			const eventsPid = readFileSync(pidFile, "utf8").trim();
			const parentPid = readFileSync(parentFile, "utf8").trim();
			expect(sh(`kill -9 ${parentPid}`).status).toBe(0);
			let gone = false;
			for (let i = 0; i < 100 && !gone; i++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				gone = sh(`kill -0 ${eventsPid} 2>/dev/null`).status !== 0;
			}
			expect(gone).toBe(true);
			// The watchdog also removes the private directory (events file, shell.pid).
			let dirGone = false;
			for (let i = 0; i < 100 && !dirGone; i++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				dirGone = sh(`test -d ${quote([eventsDir])}`).status !== 0;
			}
			expect(dirGone).toBe(true);
		} finally {
			child.kill();
		}
	});

	it("still works without `timeout` on the PATH (watchdog only)", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upExit: 0, events: 1 });
		const parentFile = join(dir, "parent2.pid");
		rmSync(pidFile, { force: true });
		const script = getDockerEventsStartScript(
			"docker-compose",
			"my-app",
		).replace("command -v timeout", "command -v no-such-timeout");
		const child = spawn(
			"sh",
			[
				writeScript(
					`echo $$ > ${toShellPath(parentFile)}; ${script}
sleep 20`,
				),
			],
			{
				env: {
					...process.env,
					PATH: `${toShellPath(binDir)}:${process.env.PATH ?? ""}`,
				},
				stdio: "ignore",
			},
		);
		try {
			for (let i = 0; i < 100 && !hasPid(); i++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const eventsPid = readFileSync(pidFile, "utf8").trim();
			sh(`kill -9 ${readFileSync(parentFile, "utf8").trim()}`);
			let gone = false;
			for (let i = 0; i < 100 && !gone; i++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				gone = sh(`kill -0 ${eventsPid} 2>/dev/null`).status !== 0;
			}
			expect(gone).toBe(true);
		} finally {
			child.kill();
		}
	});

	it("caps the appended events and says so", async () => {
		installDocker({ upExit: 0, events: 8 });
		// No `up` here, so wait for the events stub's ready marker in the script.
		const script = `${getDockerEventsStartScript("stack", "my-app", { maxLines: 3 })}
i=0; while [ ! -e ${toShellPath(eventsReadyFile)} ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done;
sleep 1;
dokploy_events_flush;`;
		const result = sh(script, {
			PATH: `${toShellPath(binDir)}:${process.env.PATH ?? ""}`,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"(truncated: showing the last 3 of 8 events)",
		);
		expect(result.stdout.match(/container start web/g)).toHaveLength(3);
		expect(result.stdout).toContain("container start web7");
		expect(result.stdout).not.toContain("container start web4");
		expect(await processIsGone()).toBe(true);
	});

	it("skips the capture instead of using a predictable path when mktemp fails", {
		timeout: 30_000,
	}, async () => {
		installDocker({ upExit: 0, events: 1 });
		rmSync(pidFile, { force: true });
		writeBin("mktemp", "exit 1");
		try {
			const result = await runStackDeploy({ dockerEvents: true });
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				"Docker events capture skipped: could not create a private temporary directory",
			);
			expect(result.stdout).toContain("Docker Compose Deployed: ✅");
			// docker events was never started.
			expect(existsSync(pidFile)).toBe(false);
		} finally {
			rmSync(join(binDir, "mktemp"), { force: true });
		}
	});

	it("stops the events process when up fails too, and still fails the deploy", async () => {
		installDocker({ upExit: 1, awaitEvents: true });
		const result = await runStackDeploy({ dockerEvents: true });
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Error: ❌ Docker command failed");
		expect(result.stdout).toContain("Docker events for my-app");
		expect(await processIsGone()).toBe(true);
	});

	it("stops the events process when the health check aborts the script", {
		timeout: 30_000,
	}, async () => {
		installDocker({ upExit: 0 });
		installCurl("503");
		const result = await runStackDeploy({
			dockerEvents: true,
			healthCheck: { url: "http://localhost/h", timeoutSeconds: 5 },
		});
		expect(result.status).toBe(1);
		expect(await processIsGone()).toBe(true);
	});

	it("writes phase lines with timestamps and elapsed seconds", async () => {
		installDocker({ upExit: 0 });
		const result = await runStackDeploy({ phaseTimestamps: true });
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(
			/\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] Build and start containers \(compose up\): started/,
		);
		expect(result.stdout).toMatch(
			/\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] Build and start containers \(compose up\): finished after [1-9]\d*s/,
		);
	});

	it("passes when the URL answers 2xx and reports the phase", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upExit: 0, upSleep: 0 });
		installCurl("204");
		const result = await runStackDeploy({
			phaseTimestamps: true,
			healthCheck: { url: "http://localhost:8080/up", timeoutSeconds: 10 },
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Health check passed: HTTP 204");
		expect(result.stdout).toContain("Health check: finished after");
		expect(result.stdout).toContain("Docker Compose Deployed: ✅");
	});

	it("fails the script with a clear line when the URL never answers", async () => {
		installDocker({ upExit: 0, upSleep: 0 });
		installCurl("503");
		const result = await runStackDeploy({
			phaseTimestamps: true,
			healthCheck: { url: "http://localhost:8080/up", timeoutSeconds: 5 },
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toContain(
			"Error: ❌ Health check failed: http://localhost:8080/… did not answer 2xx within 5s, last result: HTTP 503. The new release was left running; no automatic rollback was performed.",
		);
		expect(result.stdout).toContain("Health check: failed after");
		// The deploy is not reported as done and nothing was rolled back.
		expect(result.stdout).not.toContain("Docker Compose Deployed: ✅");
		expect(result.stdout).not.toContain(
			"Restoring previous working deployment",
		);
	}, 30_000);

	it("does not accept a 200 when curl itself failed (stalled or truncated body)", {
		timeout: 30_000,
	}, async () => {
		installDocker({ upExit: 0, upSleep: 0 });
		installCurl("200", { exit: 18 });
		const result = await runStackDeploy({
			healthCheck: { url: "http://localhost:8080/up", timeoutSeconds: 5 },
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("no valid answer (curl exit 18)");
		expect(result.stdout).not.toContain("Health check passed");
	});

	it("does not accept a success that arrives after the deadline", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upExit: 0, upSleep: 0 });
		// Ignores --max-time on purpose: a request that overruns the deadline.
		installCurl("200", { delay: 7 });
		const started = Date.now();
		const result = await runStackDeploy({
			healthCheck: { url: "http://localhost:8080/up", timeoutSeconds: 5 },
		});
		expect(result.status).toBe(1);
		expect(result.stdout).not.toContain("Health check passed");
		// One overrunning request, then the loop stops instead of retrying.
		expect(Date.now() - started).toBeLessThan(20_000);
		expect(
			readFileSync(argsFile, "utf8")
				.split("\n")
				.filter((a) => a === "--max-time"),
		).toHaveLength(1);
	});

	it("caps each request to the time that is left and hardens curl", {
		timeout: 60_000,
	}, async () => {
		installDocker({ upExit: 0, upSleep: 0 });
		installCurl("503");
		const result = await runStackDeploy({
			healthCheck: {
				url: "http://localhost:8080/up?a[]=1&b={x}",
				// 10 s leaves several seconds of slack: on a loaded runner the first
				// attempt can start late, and with a 5 s budget that shrinks its cap
				// below 5 (or leaves room for only one attempt).
				timeoutSeconds: 10,
			},
		});
		expect(result.status).toBe(1);
		const args = readFileSync(argsFile, "utf8").split("\n");
		const maxTimes = args
			.map((arg, i) => (arg === "--max-time" ? Number(args[i + 1]) : null))
			.filter((v): v is number => v !== null);
		expect(maxTimes.length).toBeGreaterThanOrEqual(2);
		// The per-request cap is 5 s even though 10 s are left.
		expect(maxTimes[0]).toBe(5);
		for (const value of maxTimes) expect(value).toBeLessThanOrEqual(5);
		expect(maxTimes[maxTimes.length - 1]).toBeLessThan(5);
		for (const flag of [
			"-L",
			"--globoff",
			"--max-redirs",
			"5",
			"--proto",
			"=http,https",
			"--proto-redir",
		]) {
			expect(args).toContain(flag);
		}
		expect(args).toContain("http://localhost:8080/up?a[]=1&b={x}");
		// The query never reaches the deploy log.
		expect(result.stdout).not.toContain("a[]=1");
		expect(result.stdout).toContain("http://localhost:8080/…");
	});

	it("skips the health check for a swarm stack and says so", {
		timeout: 30_000,
	}, async () => {
		installDocker({ upExit: 0, upSleep: 0 });
		installCurl("503");
		const result = await runStackDeploy(
			{ healthCheck: { url: "http://localhost:8080/up", timeoutSeconds: 5 } },
			{ composeType: "stack" },
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"Health check skipped: docker stack deploy returns",
		);
		expect(result.stdout).toContain("Docker Compose Deployed: ✅");
		expect(existsSync(argsFile)).toBe(false);
	});

	it("only accepts the configured status", async () => {
		installDocker({ upExit: 0, upSleep: 0 });
		installCurl("200");
		const result = await runStackDeploy({
			healthCheck: {
				url: "http://localhost:8080/up",
				timeoutSeconds: 5,
				expectedStatus: 204,
			},
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("did not answer 204");
	}, 30_000);

	it("passes the URL to curl as one literal argument and never runs injected commands", {
		timeout: 120_000,
	}, async () => {
		installDocker({ upExit: 0, upSleep: 0 });
		installCurl("200");
		// No whitespace (the schema refuses it), so `${IFS}` stands in for spaces.
		const p = toShellPath(pwnedFile);
		const ifs = "$" + "{IFS}";
		const payloads = [
			`http://localhost/$(touch${ifs}${p})`,
			`http://localhost/\`touch${ifs}${p}\``,
			`http://localhost/?a=1&b=2;touch${ifs}${p}`,
			`http://localhost/x'";touch${ifs}${p};echo'`,
			`http://localhost/"$(touch${ifs}${p})"`,
			`http://localhost/x>${p}.out|touch${ifs}${p}`,
		];
		for (const url of payloads) {
			rmSync(argsFile, { force: true });
			const result = await runStackDeploy({
				healthCheck: { url, timeoutSeconds: 5 },
			});
			expect(result.status, result.stdout + result.stderr).toBe(0);
			expect(existsSync(pwnedFile)).toBe(false);
			const args = readFileSync(argsFile, "utf8").split("\n");
			expect(args).toContain(url);
		}
	});
});

describe("health check URL quoting (string level)", () => {
	it("never leaves shell metacharacters of the URL unquoted", () => {
		const script = getHealthCheckScript(
			{
				url: "http://localhost/$(id)`id`;rm -rf /|x&y",
				timeoutSeconds: 10,
			},
			{ phaseTimestamps: false },
		);
		const curlLine = script
			.split("\n")
			.find((line) => line.includes("curl -s -L"));
		expect(curlLine).toBeDefined();
		const urlPart = (curlLine as string).split('--max-time "$HC_MAX" ')[1];
		// One single-quoted word: nothing inside it is interpreted by the shell.
		expect(urlPart).toMatch(/^'[^']*' 2>\/dev\/null/);
	});
});
