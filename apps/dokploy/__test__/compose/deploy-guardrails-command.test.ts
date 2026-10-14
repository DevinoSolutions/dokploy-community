import { spawnSync } from "node:child_process";
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
	getBuildComposeCommand(
		{ ...baseCompose, ...overrides } as Compose,
		{
			deploymentId: "dep-1",
			...(remote
				? {
						remoteBuild: {
							images: [{ service: "web", image: "registry.example/web:1" }],
							servingHostLabel: "the serving host",
						},
					}
				: {}),
		},
	);

const remoteOverrides = { buildServerId: "build-1" };

const GUARDRAIL_MARKERS = [
	"dokploy_phase",
	"dokploy_events",
	"docker events",
	"DOKPLOY_EVENTS",
	"curl",
	"Health check",
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
		["a malformed value", { healthCheck: { url: "ftp://nope" } }],
	];

	it.each(offValues)("%s produces the same script as no setting", async (_name, value) => {
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
	});

	it("keeps the docker line and its failure branch exactly as before", async () => {
		const command = await build();
		expect(command).toContain(
			'env -i PATH="$PATH" HOME="$HOME"  docker compose -p my-app',
		);
		expect(command).toContain(
			'|| { echo "Error: ❌ Docker command failed"; ',
		);
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
		const failureFlush = command.indexOf(
			"|| { dokploy_events_flush; echo",
		);
		const successFlush = command.indexOf(
			"\n\t\tdokploy_events_flush;\n",
			failureFlush,
		);
		expect(start).toBeGreaterThan(-1);
		expect(command).toContain(
			`--filter ${quote(["label=com.docker.compose.project=my-app"])}`,
		);
		expect(command).toContain(
			"--format '{{.TimeNano}} {{.Type}} {{.Action}} {{.Actor.Attributes.name}}'",
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

	it("always has a trap and a hard timeout as safety nets", async () => {
		const command = await build({ deployGuardrails: { dockerEvents: true } });
		expect(command).toContain(
			`trap 'dokploy_events_stop; rm -f "$DOKPLOY_EVENTS_FILE"' EXIT;`,
		);
		expect(command).toContain("timeout 7200 docker events");
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
		const script = getDockerEventsStartScript("docker-compose", "app; rm -rf /");
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
		const check = command.indexOf("curl -s -o /dev/null");
		const lastGood = command.indexOf("Could not refresh the last-good snapshot");
		const deployed = command.indexOf('echo "Docker Compose Deployed: ✅"');
		expect(check).toBeGreaterThan(up);
		expect(lastGood).toBeGreaterThan(check);
		expect(deployed).toBeGreaterThan(lastGood);
		expect(command).toContain("http://localhost:3000/health");
		// 2 s between attempts, any 2xx by default, no rollback on failure.
		expect(command).toContain("sleep 2;");
		expect(command).toContain("2??) HC_OK=1");
		expect(command).not.toContain("dokploy_events");
	});

	it("matches an exact status when one is configured", async () => {
		const command = await build({
			deployGuardrails: { healthCheck: { ...healthCheck, expectedStatus: 204 } },
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

	it("falls back to the default timeout when parsed from a minimal object", async () => {
		const command = await build({
			deployGuardrails: { healthCheck: { url: "http://localhost/h" } },
		});
		expect(command).toContain("+ 60 ))");
	});
});

// ---------------------------------------------------------------------------
// Executed against a real POSIX shell with fake `docker` and `curl` binaries.
// Skipped where no usable `sh` exists.
// ---------------------------------------------------------------------------

const sh = (script: string, env: Record<string, string> = {}) =>
	spawnSync("sh", ["-c", script], {
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

// The shell sees MSYS paths on Windows; keep scripts in a path both agree on.
const toShellPath = (path: string) =>
	process.platform === "win32"
		? path.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, "/")
		: path;

describe.skipIf(!hasSh)("executed in a real shell", () => {
	let dir = "";
	let binDir = "";
	let pidFile = "";
	let argsFile = "";
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
	}: { upExit: number; upSleep?: number; events?: number }) => {
		writeBin(
			"docker",
			`case "$1" in
  events)
    echo $$ > ${toShellPath(pidFile)}
    i=0
    while [ $i -lt ${events} ]; do echo "17000000$((10 + i))123456789 container start web$i"; i=$((i + 1)); done
    exec sleep 300 ;;
  stack|compose) sleep ${upSleep}; exit ${upExit} ;;
  *) exit 0 ;;
esac`,
		);
	};

	const installCurl = (status: string) => {
		writeBin(
			"curl",
			`printf '%s\\n' "$@" > ${toShellPath(argsFile)}\nprintf '${status}'`,
		);
	};

	const runStackDeploy = async (
		deployGuardrails: unknown,
		overrides: Record<string, unknown> = {},
	) => {
		const command = await build({
			composeType: "stack",
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

	const processIsGone = async () => {
		const pid = readFileSync(pidFile, "utf8").trim();
		for (let i = 0; i < 20; i++) {
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
		pwnedFile = join(dir, "pwned");
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("appends readable, capped docker events and stops the process after a successful up", async () => {
		installDocker({ upExit: 0, events: 3 });
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

	it("caps the appended events and says so", async () => {
		installDocker({ upExit: 0, events: 8 });
		const script = `${getDockerEventsStartScript("stack", "my-app", { maxLines: 3 })}
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

	it("stops the events process when up fails too, and still fails the deploy", async () => {
		installDocker({ upExit: 1 });
		const result = await runStackDeploy({ dockerEvents: true });
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Error: ❌ Docker command failed");
		expect(result.stdout).toContain("Docker events for my-app");
		expect(await processIsGone()).toBe(true);
	});

	it("stops the events process when the health check aborts the script", { timeout: 30_000 }, async () => {
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
			/\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] Deploy stack \(docker stack deploy\): started/,
		);
		expect(result.stdout).toMatch(
			/\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] Deploy stack \(docker stack deploy\): finished after [1-9]\d*s/,
		);
	});

	it("passes when the URL answers 2xx and reports the phase", { timeout: 60_000 }, async () => {
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
			"Error: ❌ Health check failed: http://localhost:8080/up did not answer 2xx within 5s, last result: HTTP 503",
		);
		expect(result.stdout).toContain("Health check: failed after");
		// The deploy is not reported as done and nothing was rolled back.
		expect(result.stdout).not.toContain("Docker Compose Deployed: ✅");
		expect(result.stdout).not.toContain("Restoring previous working deployment");
	}, 30_000);

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

	it("passes the URL to curl as one literal argument and never runs injected commands", { timeout: 120_000 }, async () => {
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
			.find((line) => line.includes("curl -s -o /dev/null"));
		expect(curlLine).toBeDefined();
		const urlPart = (curlLine as string).split("--max-time 5 ")[1];
		// One single-quoted word: nothing inside it is interpreted by the shell.
		expect(urlPart).toMatch(/^'[^']*' 2>\/dev\/null/);
	});
});
