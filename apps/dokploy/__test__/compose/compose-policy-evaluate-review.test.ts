import { COMPOSE_POLICY_MAX_BYTES } from "@dokploy/server/utils/compose-policy/config";
import {
	type ComposePolicyContext,
	describeCustomCommand,
	evaluateComposePolicy,
	evaluateComposeSpec,
	resolveLiteral,
} from "@dokploy/server/utils/compose-policy/evaluate";
import { describe, expect, it } from "vitest";

/**
 * Review fixes of the restricted-compose audit (T-7455): `security_opt` is a
 * finding only when it weakens confinement, literal defaults and `$PWD`
 * resolve (with no environment lookup), the host paths of env_file, extends,
 * include, configs, secrets and build.ssh are checked, devices and sysctls
 * count, override files are evaluated, a large file is not parsed, and the
 * work is linear.
 */

const CODE = "/etc/dokploy/compose/app-xyz/code";
const context: ComposePolicyContext = {
	appName: "app-xyz",
	projectDirectory: "/etc/dokploy/compose/app-xyz",
	codeDirectory: CODE,
	baseDirectory: CODE,
};

const evaluateYaml = (yaml: string) =>
	evaluateComposePolicy({ text: yaml, context });
const rulesOf = (yaml: string) =>
	evaluateYaml(yaml).map(
		(finding) => `${finding.serviceName}:${finding.ruleId}`,
	);
const service = (body: string) =>
	`services:\n  web:\n    image: nginx\n${body}`;

describe("security_opt: only entries that weaken confinement", () => {
	it.each([
		["no-new-privileges:true"],
		["no-new-privileges=true"],
		["label=type:svirt_lxc_net_t"],
		["label:user:USER"],
		["apparmor=docker-default"],
	])("does not flag the hardening or neutral entry %s", (entry) => {
		expect(rulesOf(service(`    security_opt:\n      - ${entry}\n`))).toEqual(
			[],
		);
	});

	it.each([
		["seccomp=unconfined"],
		["seccomp:unconfined"],
		["seccomp=/profiles/custom.json"],
		["apparmor=unconfined"],
		["apparmor:unconfined"],
		["label=disable"],
		["label:disable"],
		["systempaths=unconfined"],
	])("flags %s", (entry) => {
		expect(rulesOf(service(`    security_opt:\n      - ${entry}\n`))).toEqual([
			"web:host-privilege",
		]);
	});

	it("flags the weakening entry among hardening ones, and names only the key", () => {
		const [finding] = evaluateYaml(
			service(
				"    security_opt:\n      - no-new-privileges:true\n      - seccomp=unconfined\n",
			),
		);
		expect(finding?.detail).toBe("services.web.security_opt");
	});
});

describe("literal fallbacks resolve with no environment lookup", () => {
	it.each([
		["${DATA_DIR:-./data}:/data"],
		["${DATA_DIR-./data}:/data"],
		["${PWD}/data:/data"],
		["$PWD/data:/data"],
		["${PWD:-/srv/x}/data:/data"],
		["${A:-${B:-./data}}:/data"],
	])("a bind of %s is inside the project: no finding", (source) => {
		expect(rulesOf(service(`    volumes:\n      - "${source}"\n`))).toEqual([]);
	});

	it("classifies the default it resolves to", () => {
		expect(
			rulesOf(
				service('    volumes:\n      - "${SOCK:-/var/run/docker.sock}:/s"\n'),
			),
		).toEqual(["web:docker-socket-bind"]);
		expect(
			rulesOf(service('    volumes:\n      - "${DIR:-/etc}:/e"\n')),
		).toEqual(["web:system-path-bind"]);
		expect(
			rulesOf(service('    volumes:\n      - "${DIR:-/srv/data}:/e"\n')),
		).toEqual(["web:foreign-host-bind"]);
	});

	it("keeps 'unresolved' only when there is no literal default", () => {
		for (const source of [
			"${DIR}",
			"$DIR",
			"${DIR:?must be set}",
			"${DIR:+x}",
		]) {
			const [finding] = evaluateYaml(
				service(`    volumes:\n      - "${source}/x:/e"\n`),
			);
			expect(finding?.ruleId, source).toBe("foreign-host-bind");
			expect(finding?.detail, source).toContain("<redacted> (unresolved)");
		}
	});

	it("does not mistake the colon of a default for the end of the source", () => {
		expect(
			rulesOf(service('    volumes:\n      - "${DIR:-./data}:/data:ro"\n')),
		).toEqual([]);
	});

	it("resolves build contexts the same way", () => {
		expect(
			rulesOf(
				"services:\n  web:\n    build:\n      context: ${APP_DIR:-./app}\n",
			),
		).toEqual([]);
		expect(
			rulesOf(
				"services:\n  web:\n    build:\n      context: ${APP_DIR:-/srv/x}\n",
			),
		).toEqual(["web:build-context-outside"]);
		expect(
			rulesOf("services:\n  web:\n    build:\n      context: ${APP_DIR}\n"),
		).toEqual(["web:build-context-outside"]);
	});

	it("treats a boolean default as the boolean", () => {
		for (const value of ["${P:-false}", "${P:-0}", "${P-no}", "false"]) {
			expect(rulesOf(service(`    privileged: ${value}\n`)), value).toEqual([]);
		}
		for (const value of ["${P:-true}", "${P:-1}", "${P}", "$P"]) {
			expect(rulesOf(service(`    privileged: ${value}\n`)), value).toEqual([
				"web:host-privilege",
			]);
		}
	});

	it("resolves $$ to a dollar sign and never reads the environment", () => {
		process.env.T7455_SECRET_DIR = "/etc";
		try {
			expect(resolveLiteral("$$HOME/x", CODE)).toBe("$HOME/x");
			expect(resolveLiteral("${T7455_SECRET_DIR}/x", CODE)).toBeNull();
			expect(resolveLiteral("${T7455_SECRET_DIR:-./x}", CODE)).toBe("./x");
		} finally {
			Reflect.deleteProperty(process.env, "T7455_SECRET_DIR");
		}
	});

	it("does not recurse without end", () => {
		expect(
			resolveLiteral("${A:-${B:-${C:-${D:-${E:-${F:-${G:-x}}}}}}}", CODE),
		).toBeNull();
	});
});

describe("relative paths of a nested compose file", () => {
	// composePath `deploy/docker-compose.yml`: the deploy runs with
	// `--project-directory <code directory>`.
	it("resolve from the code directory", () => {
		expect(
			rulesOf("services:\n  web:\n    build:\n      context: ..\n"),
		).toEqual(["web:build-context-outside"]);
		expect(
			rulesOf(
				service("    volumes:\n      - ../../../../../srv/other:/data\n"),
			),
		).toEqual(["web:foreign-host-bind"]);
		expect(
			rulesOf(service("    volumes:\n      - ./deploy/data:/data\n")),
		).toEqual([]);
	});
});

describe("more host paths", () => {
	it("checks env_file in every form", () => {
		expect(rulesOf(service("    env_file: ./.env\n"))).toEqual([]);
		expect(rulesOf(service("    env_file: /etc/shadow\n"))).toEqual([
			"web:system-path-bind",
		]);
		expect(
			rulesOf(
				service(
					"    env_file:\n      - ./.env\n      - path: /srv/secrets.env\n        required: false\n",
				),
			),
		).toEqual(["web:foreign-host-bind"]);
	});

	it("checks extends.file and include", () => {
		expect(
			rulesOf(
				service(
					"    extends:\n      file: /srv/other/compose.yml\n      service: x\n",
				),
			),
		).toEqual(["web:foreign-host-bind"]);
		expect(rulesOf(service("    extends:\n      service: base\n"))).toEqual([]);
		expect(rulesOf("include:\n  - ./other.yml\nservices: {}\n")).toEqual([]);
		expect(rulesOf("include:\n  - /etc/other.yml\nservices: {}\n")).toEqual([
			"<compose>:system-path-bind",
		]);
		expect(
			rulesOf(
				"include:\n  - path:\n      - ./a.yml\n      - /srv/b.yml\n    project_directory: /var/run\n    env_file: /root/.env\nservices: {}\n",
			).sort(),
		).toEqual(["<compose>:foreign-host-bind", "<compose>:system-path-bind"]);
		expect(rulesOf("include: /etc/x.yml\nservices: {}\n")).toEqual([
			"<compose>:system-path-bind",
		]);
	});

	it("checks the file of top-level configs and secrets", () => {
		expect(
			rulesOf(
				"services: {}\nconfigs:\n  c:\n    file: ./c.conf\nsecrets:\n  s:\n    file: ./s.txt\n  t:\n    environment: TOKEN\n",
			),
		).toEqual([]);
		expect(
			rulesOf(
				"services: {}\nconfigs:\n  c:\n    file: /etc/passwd\nsecrets:\n  s:\n    file: /srv/keys/id\n",
			).sort(),
		).toEqual(["<compose>:foreign-host-bind", "<compose>:system-path-bind"]);
	});

	it("checks build.ssh paths, and not the bare ssh agent forms", () => {
		expect(
			rulesOf(
				"services:\n  web:\n    build:\n      context: .\n      ssh:\n        - default\n        - mykey\n",
			),
		).toEqual([]);
		expect(
			rulesOf(
				"services:\n  web:\n    build:\n      context: .\n      ssh:\n        - key=/root/.ssh/id_rsa\n",
			),
		).toEqual(["web:system-path-bind"]);
		expect(
			rulesOf(
				"services:\n  web:\n    build:\n      context: .\n      ssh:\n        key: /srv/keys/id\n",
			),
		).toEqual(["web:foreign-host-bind"]);
	});

	it("never prints the paths it flags outside the known system roots", () => {
		const text = JSON.stringify(
			evaluateYaml(
				"include:\n  - /srv/secret-include.yml\nservices:\n  web:\n    env_file: /srv/secret-env/.env\nsecrets:\n  s:\n    file: /srv/secret-key\n",
			),
		);
		expect(text).not.toContain("secret-include");
		expect(text).not.toContain("secret-env");
		expect(text).not.toContain("secret-key");
	});
});

describe("more host-privilege keys", () => {
	it.each([
		["sysctls:\n      net.ipv4.ip_forward: 1"],
		["sysctls:\n      - net.ipv4.ip_forward=1"],
		["device_cgroup_rules:\n      - 'c 13:* rmw'"],
		["cgroup: host"],
		[
			"deploy:\n      resources:\n        reservations:\n          devices:\n            - driver: nvidia\n              count: all\n              capabilities: [gpu]",
		],
	])("flags %s", (key) => {
		expect(rulesOf(service(`    ${key}\n`))).toEqual(["web:host-privilege"]);
	});

	it("leaves cgroup: private and plain reservations alone", () => {
		expect(rulesOf(service("    cgroup: private\n"))).toEqual([]);
		expect(
			rulesOf(
				service(
					"    deploy:\n      resources:\n        reservations:\n          memory: 1G\n",
				),
			),
		).toEqual([]);
	});
});

describe("override files of a custom command", () => {
	it("are evaluated like the compose file, in the same finding", () => {
		const findings = evaluateComposePolicy({
			text: "services:\n  web:\n    image: nginx\n",
			overrides: [
				"services:\n  web:\n    privileged: true\n    volumes:\n      - /var/run/docker.sock:/s\n",
			],
			command: "docker compose -f docker-compose.yml -f override.yml up -d",
			context,
		});
		expect(findings.map((f) => `${f.serviceName}:${f.ruleId}`)).toEqual([
			"<compose>:custom-command",
			"web:host-privilege",
			"web:docker-socket-bind",
		]);
	});

	it("an override that does not parse is one finding, never an exception", () => {
		const findings = evaluateComposePolicy({
			text: "services: {}\n",
			overrides: ["services: [unclosed\n"],
			context,
		});
		expect(findings).toEqual([
			{
				serviceName: "<compose>",
				ruleId: "unparseable-compose",
				detail: "override file: YAML parse error",
			},
		]);
	});

	it("an override above the size cap is not parsed", () => {
		const findings = evaluateComposePolicy({
			text: "services: {}\n",
			overrides: [`# ${"x".repeat(COMPOSE_POLICY_MAX_BYTES)}\nservices: {}\n`],
			context,
		});
		expect(findings).toEqual([
			{
				serviceName: "<compose>",
				ruleId: "compose-too-large",
				detail: "override file: larger than 512 KB, not evaluated",
			},
		]);
	});
});

describe("a custom command: only chaining operators count", () => {
	it("does not count a glob as a chained command", () => {
		expect(describeCustomCommand("docker compose -f ./*.yml up -d")).toBe(
			"custom command (flags: -f; subcommands: compose, up)",
		);
		expect(
			describeCustomCommand("docker compose up -d && docker compose ps | cat"),
		).toContain("chained: 2");
	});

	it("does not analyse a huge command", () => {
		expect(
			describeCustomCommand(`docker compose up ${"a ".repeat(40_000)}`),
		).toBe("custom command (too long to analyse)");
	});
});

describe("size and cost", () => {
	it("a compose above the cap is one compose-too-large finding and is not parsed", () => {
		// Not even valid YAML after the comment: parsing it would be a finding of
		// its own, so this proves the file was never parsed.
		const text = `services: [unclosed\n# ${"x".repeat(COMPOSE_POLICY_MAX_BYTES)}\n`;
		const started = performance.now();
		const findings = evaluateComposePolicy({ text, context });
		const elapsed = performance.now() - started;

		expect(findings).toEqual([
			{
				serviceName: "<compose>",
				ruleId: "compose-too-large",
				detail: "larger than 512 KB, not evaluated",
			},
		]);
		expect(elapsed).toBeLessThan(250);
	});

	it("a file just under the cap is still evaluated", () => {
		const text = `services:\n  web:\n    privileged: true\n# ${"x".repeat(COMPOSE_POLICY_MAX_BYTES - 200)}\n`;
		expect(
			evaluateComposePolicy({ text, context }).map((f) => f.ruleId),
		).toEqual(["host-privilege"]);
	});

	it("is linear in the number of volumes a service mounts (no volumes x mounts scan)", () => {
		const count = 20_000;
		const volumes: Record<string, unknown> = {};
		const mounts: string[] = [];
		for (let i = 0; i < count; i++) {
			volumes[`v${i}`] = { external: true };
			mounts.push(`v${i}:/data${i}`);
		}
		const spec = {
			services: { web: { image: "x", volumes: mounts } },
			volumes,
		};

		const started = performance.now();
		const findings = evaluateComposeSpec(spec, context);
		const elapsed = performance.now() - started;

		expect(findings).toHaveLength(1);
		expect(findings[0]?.ruleId).toBe("external-volume");
		expect(findings[0]?.detail.length).toBeLessThanOrEqual(300);
		// 20 000 x 20 000 comparisons would take seconds.
		expect(elapsed).toBeLessThan(500);
	});

	it("is linear in the number of services too", () => {
		const services: Record<string, unknown> = {};
		for (let i = 0; i < 5_000; i++) {
			services[`s${i}`] = {
				image: "x",
				volumes: [`/etc/dir${i}:/d`],
				privileged: true,
			};
		}
		const started = performance.now();
		const findings = evaluateComposeSpec({ services }, context);
		const elapsed = performance.now() - started;

		expect(findings.length).toBeLessThanOrEqual(200);
		expect(elapsed).toBeLessThan(1000);
	});
});
