import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuildComposeCommand } from "@dokploy/server/utils/builders/compose";
import { getRollingReplaceScript } from "@dokploy/server/utils/builders/compose-rolling";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const domain = vi.hoisted(() => ({
	writeDomainsToCompose: vi.fn().mockResolvedValue(""),
	addDomainToCompose: vi.fn(),
}));
vi.mock("@dokploy/server/utils/docker/domain", () => domain);

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

const healthcheck = {
	test: ["CMD", "true"],
	interval: "5s",
	timeout: "2s",
	retries: 3,
};
const SPEC = {
	services: {
		web: { build: ".", healthcheck },
		worker: { image: "ghcr.io/acme/worker:1", healthcheck },
		db: { image: "postgres:16" },
	},
};

const build = (
	overrides: Record<string, unknown> = {},
	options: { remote?: boolean; freshVolumes?: boolean } = {},
) =>
	getBuildComposeCommand({ ...baseCompose, ...overrides } as Compose, {
		deploymentId: "dep-1",
		freshVolumes: options.freshVolumes,
		...(options.remote
			? {
					remoteBuild: {
						images: [{ service: "web", image: "registry.example/web:1" }],
						servingHostLabel: "the serving host",
					},
				}
			: {}),
	});

const rolling = (services: string[], extra: Record<string, unknown> = {}) => ({
	rollingReplace: { enabled: true, services, ...extra },
});

beforeEach(() => {
	domain.addDomainToCompose.mockReset().mockResolvedValue(SPEC);
});

const toShellPath = (path: string) =>
	process.platform === "win32"
		? path
				.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
				.replace(/\\/g, "/")
		: path;
const scratch = mkdtempSync(join(tmpdir(), "dokploy-rolling-cmd-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** `sh -n`: the script parses, whatever the names in it are. */
const parses = (script: string) => {
	const path = join(scratch, `s-${Math.random()}.sh`);
	writeFileSync(path, script);
	const result = spawnSync("sh", ["-n", toShellPath(path)], {
		encoding: "utf8",
	});
	return result.status === 0 ? "ok" : `${result.stderr}`;
};

describe("rolling replace: the hook at the up line", () => {
	it("replaces the plain docker up with the rolling function, in place", async () => {
		const command = await build(rolling(["web"]));
		// The functions are defined before they are called, at the position of `up`.
		const defined = command.indexOf("dokploy_roll_run() {");
		const called = command.indexOf("dokploy_roll_run || {");
		expect(defined).toBeGreaterThan(-1);
		expect(called).toBeGreaterThan(defined);
		// No plain recreate of the whole project is left on the deploy line.
		expect(command).not.toMatch(
			/env -i PATH="\$PATH" HOME="\$HOME" docker compose -p my-app[^\n]* up -d --build --remove-orphans 2>&1/,
		);
		// The deploy keeps its failure branch and its success markers.
		expect(command).toContain('echo "Error: ❌ Docker command failed"');
		expect(command).toContain('echo "Docker Compose Deployed: ✅"');
		expect(command).toContain("Rolling replace: web");
		expect(parses(command)).toBe("ok");
	});

	it("keeps persistLastGood and the isolated-deployment network connect on the rolling path", async () => {
		const command = await build({
			...rolling(["web"]),
			isolatedDeployment: true,
		});
		expect(command).toContain("last-good-docker-compose.yml.bak");
		expect(command).toContain(
			'docker network connect my-app $(docker ps --filter "name=dokploy-traefik" -q)',
		);
		// Connect and snapshot come after the rollout.
		const called = command.indexOf("dokploy_roll_run || {");
		expect(command.indexOf("docker network connect my-app")).toBeGreaterThan(
			called,
		);
		expect(command.indexOf("last-good-docker-compose.yml.bak")).toBeGreaterThan(
			called,
		);
	});

	it("restores the previous release only while nothing was promoted", async () => {
		const command = await build(rolling(["web"]));
		expect(command).toContain('if [ "$DOKPLOY_ROLL_PROMOTED" = "0" ]; then');
		expect(command).toContain("No automatic restore was performed");
		// The regular restore is still the one inside the guard.
		const guard = command.indexOf('if [ "$DOKPLOY_ROLL_PROMOTED" = "0" ]');
		expect(
			command.indexOf("Restoring previous working deployment", guard),
		).toBeGreaterThan(guard);
	});

	it("uses the same invocation prefix as the deploy's own up", async () => {
		const command = await build({
			...rolling(["web"]),
			createEnvFile: false,
		});
		expect(command).toContain(
			"docker compose -p my-app -f ./docker-compose.yml",
		);
		expect(command).toContain('"$@"; };');
	});

	it("a build server: no building on the serving host, behind the pull guard", async () => {
		const command = await build(
			{ ...rolling(["web", "worker"]), buildServerId: "build-1" },
			{ remote: true },
		);
		expect(command).toContain(
			'if [ "$PULL_OK" = "1" ]; then dokploy_roll_run; else false; fi',
		);
		expect(command).toContain("--no-deps --no-build $DR_OTHERS");
		expect(command).not.toContain("--build $DR_OTHERS");
		expect(command).not.toContain("compose build");
		expect(parses(command)).toBe("ok");
	});

	it("builds services with a build section and pulls the image-only ones on pullImagesOnDeploy", async () => {
		const command = await build({
			...rolling(["web", "worker"]),
			pullImagesOnDeploy: true,
		});
		expect(command).toContain("DOKPLOY_ROLL_BUILD=web");
		expect(command).toContain("DOKPLOY_ROLL_PULL=worker");
		expect(command).toContain("build --pull $DR_B");
		expect(command).toContain("--no-deps --pull always --build $DR_OTHERS");
	});

	it("does not pull image-only services unless the compose asks to", async () => {
		const command = await build(rolling(["web", "worker"]));
		expect(command).toContain("DOKPLOY_ROLL_PULL=''");
		expect(command).not.toContain("compose pull");
	});

	it("keeps the guardrails around it (phase timestamps, events)", async () => {
		const command = await build({
			...rolling(["web"]),
			deployGuardrails: { phaseTimestamps: true, dockerEvents: true },
		});
		expect(command).toContain("Rolling replace (compose up)");
		const start = command.indexOf("docker events");
		const roll = command.indexOf("dokploy_roll_run || {");
		expect(start).toBeGreaterThan(-1);
		expect(roll).toBeGreaterThan(start);
		expect(parses(command)).toBe("ok");
	});
});

describe("rolling replace: when it cannot apply", () => {
	const plainUp = "up -d --build --remove-orphans 2>&1 || {";

	it.each([
		["a stack", { composeType: "stack" }, undefined, "not stacks"],
		[
			"a custom command",
			{ command: "compose up -d" },
			undefined,
			"custom command",
		],
	])(
		"%s: the plain deploy plus a notice",
		async (_name, overrides, _o, why) => {
			const command = await build({ ...rolling(["web"]), ...overrides });
			expect(command).not.toContain("dokploy_roll_run");
			expect(command).toContain("Rolling replace is off for this deploy");
			expect(command).toContain(why);
		},
	);

	it("fresh volumes: the plain deploy plus a notice", async () => {
		const command = await build(rolling(["web"]), { freshVolumes: true });
		expect(command).not.toContain("dokploy_roll_run");
		expect(command).toContain("recreates the volumes");
		expect(command).toContain(plainUp);
	});

	it("drift: a selected service that lost its healthcheck is recreated normally with a warning, the rest still rolls", async () => {
		domain.addDomainToCompose.mockResolvedValue({
			services: {
				web: { build: ".", healthcheck },
				worker: { image: "ghcr.io/acme/worker:1" },
			},
		});
		const command = await build(rolling(["web", "worker"]));
		expect(command).toContain("DOKPLOY_ROLL_SELECTED=web");
		expect(command).not.toContain("DOKPLOY_ROLL_SELECTED='web worker'");
		expect(command).toContain(
			'Rolling replace: "worker" is recreated normally this time.',
		);
		expect(command).toContain("No healthcheck in the compose file");
	});

	it("drift: when nothing is eligible any more the deploy is the plain one, never a failure", async () => {
		domain.addDomainToCompose.mockResolvedValue({
			services: { web: { build: ".", ports: ["80:80"] } },
		});
		const command = await build(rolling(["web", "removed"]));
		expect(command).not.toContain("dokploy_roll_run");
		expect(command).toContain('"web" is recreated normally');
		expect(command).toContain('"removed" is recreated normally');
		expect(command).toContain('no service "removed"');
		expect(command).toContain(plainUp);
	});

	it("a compose file that cannot be read: plain deploy plus a notice", async () => {
		domain.addDomainToCompose.mockResolvedValue(null);
		const command = await build(rolling(["web"]));
		expect(command).not.toContain("dokploy_roll_run");
		expect(command).toContain("the compose file could not be read");
	});

	it("a spec that throws is the same: never fails the deploy", async () => {
		domain.addDomainToCompose.mockRejectedValue(new Error("boom"));
		const command = await build(rolling(["web"]));
		expect(command).not.toContain("dokploy_roll_run");
		expect(command).toContain("the compose file could not be read");
	});

	it("a short health timeout is raised to cover the healthcheck", async () => {
		const command = await build(rolling(["web"], { healthTimeoutSeconds: 10 }));
		// 3 retries x (5s interval + 2s timeout) = 21s, plus 1s
		expect(command).toContain("dokploy_roll_run");
		expect(command).toContain("$(date +%s) + 22 ))");
		expect(command).toContain(
			"the health wait is raised from 10s to 22s to cover the healthchecks",
		);
	});
});

describe("rolling replace: the generated script", () => {
	const script = (
		extra: Partial<Parameters<typeof getRollingReplaceScript>[0]> = {},
	) =>
		getRollingReplaceScript({
			appName: "my-app",
			invocation: "compose -p my-app -f docker-compose.yml",
			services: ["web"],
			remoteBuild: false,
			pullAlways: false,
			healthTimeoutSeconds: 90,
			drainSeconds: 5,
			...extra,
		});

	it("one service: scale up, record ids, health wait, drain, old ids removed, then reconcile", () => {
		const { definitions } = script();
		const order = [
			'dokploy_roll_reconcile "$1" || return 1;',
			'dokploy_roll_unchanged "$1"',
			'DOKPLOY_ROLL_BEFORE=$(dokploy_roll_ids "$1"',
			'--scale "$1=2" "$1"',
			'dokploy_roll_wait_healthy "$DR_NEW"',
			"waiting 5s before the old container is stopped",
			"dokploy_roll_remove $DR_OLD",
			"--remove-orphans $DR_ALL",
		];
		let at = definitions.indexOf("dokploy_roll_service() {");
		for (const part of order) {
			const next = definitions.indexOf(part, at);
			expect(next, part).toBeGreaterThan(-1);
			at = next;
		}
	});

	it("several services are rolled in the order given", () => {
		const { definitions } = script({ services: ["web", "api", "worker"] });
		expect(definitions).toContain("DOKPLOY_ROLL_SELECTED='web api worker'");
		expect(definitions).toContain(
			'for DR_S in $DR_ROLL; do dokploy_roll_service "$DR_S" || return 1; done;',
		);
	});

	it("always emits the others step; it is skipped at run time when DR_OTHERS is empty", () => {
		// `config --services` also sees included and extended services the raw spec
		// does not list, so the step cannot be decided from the spec.
		const { definitions } = script();
		expect(definitions).toContain("services that are not rolled");
		expect(definitions).toContain('if [ -n "$DR_OTHERS" ]; then');
	});

	it("every up names its services; none is bare", () => {
		const { definitions } = script();
		for (const line of definitions
			.split("\n")
			.filter((l) => / up -d/.test(l))) {
			expect(line).toMatch(/ ("\$1"|\$DR_OTHERS|\$DR_ALL)( 2>&1|$)/);
		}
	});

	it("no drain line when the delay is 0", () => {
		expect(script({ drainSeconds: 0 }).definitions).not.toContain("waiting 0s");
	});

	it("stops old containers by recorded id, never through Compose's scale-down", () => {
		const { definitions } = script();
		expect(definitions).not.toMatch(/--scale "\$1=2"[^\n]*docker rm/);
		expect(definitions).toContain("dokploy_roll_remove $DR_OLD");
		// Compose would scale down by removing the highest-numbered container, so no
		// scale-down is ever issued.
		expect(definitions).not.toMatch(/--scale "\$1=1"/);
	});

	it("hostile names: the script still parses and the names are quoted data", () => {
		const hostile = script({
			appName: "a'b$(touch /tmp/x)`id`",
			invocation: `compose -p ${"'a b'"} -f 'x;y.yml'`,
			services: ["w;touch /tmp/x", "$(id)"],
		});
		expect(parses(`${hostile.definitions}\n${hostile.call}`)).toBe("ok");
		expect(hostile.definitions).not.toContain("DOKPLOY_ROLL_SELECTED=w;touch");
		expect(hostile.definitions).not.toContain(
			"--filter label=com.docker.compose.project=a'b",
		);
	});
});
