import {
	COMPOSE_POLICY_RULES,
	type ComposePolicyRuleId,
	parseComposePolicyExclusions,
	resolveComposePolicySettings,
} from "@dokploy/server/utils/compose-policy/config";
import {
	type ComposePolicyContext,
	describeCustomCommand,
	evaluateComposePolicy,
	evaluateComposeSpec,
} from "@dokploy/server/utils/compose-policy/evaluate";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The pure evaluator of the restricted-compose audit (T-7455): every rule in
 * the short and the long syntax, the redaction of everything that is not a
 * fixed value, and the rule that a file that does not parse is a finding and
 * never an exception.
 */

const context: ComposePolicyContext = {
	appName: "app-xyz",
	projectDirectory: "/etc/dokploy/compose/app-xyz",
	codeDirectory: "/etc/dokploy/compose/app-xyz/code",
	composeDirectory: "/etc/dokploy/compose/app-xyz/code",
};

const evaluateYaml = (yaml: string, command?: string | null) =>
	evaluateComposePolicy({ text: yaml, command, context });

const rulesOf = (yaml: string, command?: string | null) =>
	evaluateYaml(yaml, command).map(
		(finding) => `${finding.serviceName}:${finding.ruleId}`,
	);

const service = (body: string) =>
	`services:\n  web:\n    image: nginx\n${body}`;

describe("rule 1: host-privilege keys", () => {
	it.each([
		["privileged: true"],
		["use_api_socket: true"],
		["cap_add:\n      - SYS_ADMIN"],
		["devices:\n      - /dev/fuse:/dev/fuse"],
		["network_mode: host"],
		["pid: host"],
		["ipc: host"],
		["uts: host"],
		["security_opt:\n      - seccomp:unconfined"],
		["userns_mode: host"],
		["cgroup_parent: some-cgroup"],
	])("flags %s", (key) => {
		expect(rulesOf(service(`    ${key}\n`))).toEqual(["web:host-privilege"]);
	});

	it("names the key path and never its value", () => {
		const [finding] = evaluateYaml(
			service("    cap_add:\n      - SYS_ADMIN\n    network_mode: host\n"),
		);
		expect(finding?.detail).toBe(
			"services.web.cap_add; services.web.network_mode=host",
		);
	});

	it("does not flag the safe values", () => {
		expect(
			rulesOf(
				service(
					"    privileged: false\n    cap_add: []\n    network_mode: bridge\n    pid: ''\n",
				),
			),
		).toEqual([]);
	});

	it("counts an interpolated privileged flag, whose value cannot be known", () => {
		expect(rulesOf(service("    privileged: ${PRIVILEGED}\n"))).toEqual([
			"web:host-privilege",
		]);
	});

	it.each([
		["network_mode: service:db"],
		["pid: container:abc"],
		["ipc: service:db"],
		["volumes_from:\n      - container:abc"],
	])("flags a namespace join: %s", (key) => {
		expect(rulesOf(service(`    ${key}\n`))).toEqual(["web:namespace-join"]);
	});
});

describe("rule 2: system binds", () => {
	const bind = (source: string) =>
		rulesOf(service(`    volumes:\n      - ${source}:/data\n`));

	it.each(["/var/run/docker.sock", "/run/docker.sock"])(
		"flags the docker socket %s (short syntax)",
		(path) => {
			expect(bind(path)).toEqual(["web:docker-socket-bind"]);
		},
	);

	it("flags the docker socket in the long syntax", () => {
		expect(
			rulesOf(
				service(
					"    volumes:\n      - type: bind\n        source: /var/run/docker.sock\n        target: /var/run/docker.sock\n",
				),
			),
		).toEqual(["web:docker-socket-bind"]);
	});

	it.each([
		"/",
		"/etc",
		"/etc/shadow",
		"/proc",
		"/sys",
		"/dev",
		"/dev/sda",
		"/root",
		"/root/.ssh",
		"/boot",
		"/usr",
		"/usr/local/bin",
		"/bin",
		"/sbin",
		"/lib",
		"/lib64",
		"/var",
		"/var/run",
		"/run",
		"/var/lib",
		"/var/lib/docker",
		"/var/lib/docker/volumes/other_volume/_data",
	])("flags the system path %s (short syntax)", (path) => {
		expect(bind(path)).toEqual(["web:system-path-bind"]);
	});

	it("flags a system path in the long syntax, and an untyped source", () => {
		expect(
			rulesOf(
				service(
					"    volumes:\n      - type: bind\n        source: /etc\n        target: /host-etc\n",
				),
			),
		).toEqual(["web:system-path-bind"]);
		expect(
			rulesOf(
				service("    volumes:\n      - source: /proc\n        target: /p\n"),
			),
		).toEqual(["web:system-path-bind"]);
	});

	it("resolves .. before it decides", () => {
		expect(bind("../../../../../etc")).toEqual(["web:system-path-bind"]);
		// Another compose of this host is under /etc/dokploy: a system path too.
		expect(bind("/etc/dokploy/compose/app-xyz/../other-app/files")).toEqual([
			"web:system-path-bind",
		]);
	});

	it("flags any other absolute host path outside the compose's own directory", () => {
		expect(bind("/srv/shared-data")).toEqual(["web:foreign-host-bind"]);
		expect(bind("/var/log/nginx")).toEqual(["web:foreign-host-bind"]);
		expect(bind("/mnt/other-app/files")).toEqual(["web:foreign-host-bind"]);
	});

	it("allows the compose's own directory, relative or absolute", () => {
		expect(bind("./data")).toEqual([]);
		expect(bind(".")).toEqual([]);
		expect(bind("../files/uploads")).toEqual([]);
		expect(bind("/etc/dokploy/compose/app-xyz/files")).toEqual([]);
	});

	it("does not flag named volumes, anonymous volumes or tmpfs", () => {
		expect(
			rulesOf(
				service(
					"    volumes:\n      - data:/data\n      - /anonymous\n      - type: tmpfs\n        target: /tmp\n      - type: volume\n        source: data\n        target: /d\n",
				),
			),
		).toEqual([]);
	});

	it("flags a bind through driver_opts, attributed to the service that mounts it", () => {
		const yaml = `${service("    volumes:\n      - hostdir:/data\n")}volumes:\n  hostdir:\n    driver: local\n    driver_opts:\n      type: none\n      o: bind\n      device: /etc\n`;
		expect(evaluateYaml(yaml)).toEqual([
			{
				serviceName: "web",
				ruleId: "system-path-bind",
				detail: "volumes.hostdir.driver_opts.device: /etc",
			},
		]);
		const docker = `${service("    volumes:\n      - hostdir:/data\n")}volumes:\n  hostdir:\n    driver_opts:\n      type: none\n      o: rbind,ro\n      device: /var/run/docker.sock\n`;
		expect(rulesOf(docker)).toEqual(["web:docker-socket-bind"]);
	});

	it("leaves a driver_opts device inside the compose's directory, and an nfs mount, alone", () => {
		const own = `${service("    volumes:\n      - d:/data\n")}volumes:\n  d:\n    driver_opts:\n      type: none\n      o: bind\n      device: /etc/dokploy/compose/app-xyz/files/x\n`;
		expect(rulesOf(own)).toEqual([]);
		const nfs = `${service("    volumes:\n      - d:/data\n")}volumes:\n  d:\n    driver_opts:\n      type: nfs\n      o: addr=10.0.0.1\n      device: ':/export'\n`;
		expect(rulesOf(nfs)).toEqual([]);
	});

	it("joins the details of one service and rule into one finding", () => {
		const findings = evaluateYaml(
			service("    volumes:\n      - /etc:/a\n      - /proc:/b\n"),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toBe(
			"services.web.volumes[0]: /etc; services.web.volumes[1]: /proc",
		);
	});
});

describe("rule 3: shared volumes", () => {
	const withVolumes = (volumes: string) =>
		`${service("    volumes:\n      - data:/data\n")}volumes:\n${volumes}`;

	it.each([
		["  data:\n    external: true\n"],
		["  data:\n    external:\n      name: other-project_data\n"],
	])("flags an external volume", (volumes) => {
		expect(evaluateYaml(withVolumes(volumes))).toEqual([
			{
				serviceName: "web",
				ruleId: "external-volume",
				detail: "volumes.data: external",
			},
		]);
	});

	it("flags an explicit name that is not namespaced to this compose", () => {
		expect(
			rulesOf(withVolumes("  data:\n    name: another-projects-volume\n")),
		).toEqual(["web:foreign-volume-name"]);
	});

	it.each(["app-xyz", "app-xyz_data", "app-xyz-data", "APP-XYZ_data"])(
		"accepts the explicit name %s, which is namespaced to this compose",
		(name) => {
			expect(rulesOf(withVolumes(`  data:\n    name: ${name}\n`))).toEqual([]);
		},
	);

	it("does not accept a name that only starts with the app name", () => {
		expect(rulesOf(withVolumes("  data:\n    name: app-xyzzy\n"))).toEqual([
			"web:foreign-volume-name",
		]);
	});

	it("records an unmounted shared volume at the compose level", () => {
		const yaml = `${service("")}volumes:\n  orphan:\n    external: true\n`;
		expect(rulesOf(yaml)).toEqual(["<compose>:external-volume"]);
	});

	it("leaves a plain volume alone", () => {
		expect(rulesOf(withVolumes("  data: {}\n"))).toEqual([]);
		expect(rulesOf(withVolumes("  data:\n"))).toEqual([]);
	});
});

describe("rule 4: build contexts", () => {
	const build = (body: string) =>
		rulesOf(`services:\n  web:\n    build:\n${body}`);

	it("flags a context outside the code directory (short and long syntax)", () => {
		expect(rulesOf("services:\n  web:\n    build: ../../other\n")).toEqual([
			"web:build-context-outside",
		]);
		expect(build("      context: /srv/elsewhere\n")).toEqual([
			"web:build-context-outside",
		]);
	});

	it("flags a context into docker storage", () => {
		expect(
			rulesOf("services:\n  web:\n    build: /var/lib/docker/overlay2\n"),
		).toEqual(["web:build-context-docker-storage"]);
		expect(build("      context: /var/lib/docker\n")).toEqual([
			"web:build-context-docker-storage",
		]);
	});

	it("flags a dockerfile that leaves the code directory", () => {
		expect(
			build(
				"      context: .\n      dockerfile: ../../../outside/Dockerfile\n",
			),
		).toEqual(["web:build-context-outside"]);
	});

	it("flags additional contexts, as a map and as a list", () => {
		expect(
			build(
				"      context: .\n      additional_contexts:\n        shared: /srv/x\n",
			),
		).toEqual(["web:build-context-outside"]);
		expect(
			build(
				"      context: .\n      additional_contexts:\n        - shared=/var/lib/docker\n",
			),
		).toEqual(["web:build-context-docker-storage"]);
	});

	it("leaves contexts inside the code directory, and remote ones, alone", () => {
		expect(rulesOf("services:\n  web:\n    build: ./app\n")).toEqual([]);
		expect(
			build("      context: .\n      dockerfile: docker/Dockerfile\n"),
		).toEqual([]);
		expect(
			build("      context: https://github.com/acme/repo.git#main\n"),
		).toEqual([]);
		expect(
			build(
				"      context: .\n      additional_contexts:\n        base: docker-image://alpine:3\n",
			),
		).toEqual([]);
	});

	it("resolves a nested compose file from its own directory", () => {
		const nested = {
			...context,
			composeDirectory: "/etc/dokploy/compose/app-xyz/code/deploy",
		};
		const spec = parse("services:\n  web:\n    build: ..\n");
		expect(evaluateComposeSpec(spec, nested)).toEqual([]);
		const outside = parse("services:\n  web:\n    build: ../..\n");
		expect(
			evaluateComposeSpec(outside, nested).map((finding) => finding.ruleId),
		).toEqual(["build-context-outside"]);
	});
});

describe("rule 5: custom command", () => {
	it("is recorded with only the names of the flags and subcommands", () => {
		const [finding] = evaluateComposePolicy({
			text: null,
			command:
				"docker compose -p my-project -f docker-compose.prod.yml --env-file /root/secrets.env up -d && docker compose down",
			context,
		});
		expect(finding).toEqual({
			serviceName: "<compose>",
			ruleId: "custom-command",
			detail:
				"custom command (flags: --env-file, -f, -p; subcommands: compose, down, up; chained: 1)",
		});
	});

	it.each([
		["docker compose --file=a.yml up", "flags: --file"],
		["docker compose --project-name x up", "flags: --project-name"],
		["docker compose --project-directory /x up", "flags: --project-directory"],
		["docker compose -f./a.yml up", "flags: -f"],
		["docker compose up -d; docker compose logs", "chained: 1"],
	])("reports %s", (command, expected) => {
		expect(describeCustomCommand(command)).toContain(expected);
	});

	it("never prints a value", () => {
		const detail = describeCustomCommand(
			"docker compose -f /srv/hidden/compose.yml --env-file ./token-abc123 up && echo PASSWORD=hunter2 | tee out.txt",
		);
		for (const secret of [
			"hidden",
			"token-abc123",
			"hunter2",
			"PASSWORD",
			"tee",
		]) {
			expect(detail).not.toContain(secret);
		}
	});

	it("is not a finding when the compose has no custom command", () => {
		for (const command of [null, undefined, "", "   "]) {
			expect(
				evaluateComposePolicy({ text: "services: {}", command, context }),
			).toEqual([]);
		}
	});
});

describe("rule 6: unparseable compose", () => {
	it.each([
		["invalid YAML", "services:\n  web: [unclosed\n", "YAML parse error"],
		[
			"multi-document YAML",
			"services:\n  a:\n    image: x\n---\nservices:\n  b:\n    privileged: true\n",
			"multi-document YAML",
		],
		["a scalar", "just a string", "compose file is not a mapping"],
		["a list", "- a\n- b\n", "compose file is not a mapping"],
	])("is one finding for %s, and never an exception", (_name, text, detail) => {
		expect(evaluateComposePolicy({ text, context })).toEqual([
			{ serviceName: "<compose>", ruleId: "unparseable-compose", detail },
		]);
	});

	it("does not evaluate the rest of a file that does not parse", () => {
		const findings = evaluateComposePolicy({
			text: "services:\n  web:\n    privileged: true\n    bad: [\n",
			command: "docker compose up",
			context,
		});
		expect(findings.map((finding) => finding.ruleId)).toEqual([
			"custom-command",
			"unparseable-compose",
		]);
	});

	it("keeps the parser's message, which quotes the file, out of the finding", () => {
		const findings = evaluateComposePolicy({
			text: "services:\n  web:\n    environment:\n      TOKEN: hunter2-secret\n    bad: [unclosed\n",
			context,
		});
		expect(JSON.stringify(findings)).not.toContain("hunter2-secret");
		expect(JSON.stringify(findings)).not.toContain("TOKEN");
	});

	it("treats an empty file as nothing to evaluate", () => {
		expect(evaluateComposePolicy({ text: "", context })).toEqual([]);
		expect(
			evaluateComposePolicy({ text: "# only a comment\n", context }),
		).toEqual([]);
	});

	it("does not throw on shapes that are not a compose file", () => {
		for (const spec of [
			null,
			3,
			"x",
			[],
			{ services: "x" },
			{ services: { a: 1 } },
		]) {
			expect(() => evaluateComposeSpec(spec, context)).not.toThrow();
		}
		expect(
			evaluateComposeSpec(
				{ services: { a: { volumes: [1, null, { type: "bind" }], build: 5 } } },
				context,
			),
		).toEqual([]);
	});

	it("evaluates the YAML merge keys and anchors the deploy uses", () => {
		const yaml = [
			"x-base: &base",
			"  privileged: true",
			"services:",
			"  web:",
			"    <<: *base",
			"    image: nginx",
			"",
		].join("\n");
		expect(rulesOf(yaml)).toEqual(["web:host-privilege"]);
	});
});

describe("redaction: nothing from the file or the environment is copied", () => {
	const SECRETS = [
		"s3cr3t-db-password",
		"hunter2",
		"/home/alice",
		"alice-private-dir",
		"/srv/bob-secret",
		"bob-secret",
		"carols-volume",
		"ghp_abcdef123456",
		"supersecretcontext",
		"dave-credentials",
	];

	const yaml = `
services:
  web:
    image: nginx
    environment:
      DB_PASSWORD: s3cr3t-db-password
      API_TOKEN: ghp_abcdef123456
    env_file:
      - ./dave-credentials.env
    labels:
      secret.label: hunter2
    privileged: true
    cap_add:
      - SYS_ADMIN
    volumes:
      - /home/alice/alice-private-dir:/data
      - /srv/bob-secret:/b:ro
      - \${SECRET_PATH}:/c
      - shared:/d
    build:
      context: /srv/supersecretcontext
      dockerfile: ../../../dave-credentials/Dockerfile
volumes:
  shared:
    name: carols-volume
`;

	it("holds only fixed rule ids, key paths and known system roots", () => {
		const findings = evaluateYaml(
			yaml,
			"docker compose -f /srv/bob-secret/compose.yml --env-file /home/alice/hunter2 up",
		);
		expect(findings.length).toBeGreaterThan(0);
		const text = JSON.stringify(findings);
		for (const secret of SECRETS) {
			expect(text, secret).not.toContain(secret);
		}
		for (const finding of findings) {
			expect(COMPOSE_POLICY_RULES).toContain(finding.ruleId);
			expect(finding.detail.length).toBeLessThanOrEqual(300);
		}
		expect(text).toContain("<redacted>");
	});

	it("does not look up an interpolated value", () => {
		const text = JSON.stringify(
			evaluateYaml(
				"services:\n  web:\n    volumes:\n      - ${SECRET_PATH}:/c\n    build:\n      context: ${SECRET_CONTEXT}\n",
			),
		);
		expect(text).toContain("<redacted> (unresolved)");
		expect(text).not.toContain("SECRET_PATH");
		expect(text).not.toContain("SECRET_CONTEXT");
	});

	it("sanitizes a service name before it is printed", () => {
		const findings = evaluateYaml(
			'services:\n  "web\\nINJECTED line":\n    privileged: true\n',
		);
		expect(findings[0]?.serviceName).toBe("web_INJECTED_line");
	});

	it("emits only known rule ids", () => {
		const seen = new Set<ComposePolicyRuleId>(
			evaluateYaml(yaml, "docker compose up").map((finding) => finding.ruleId),
		);
		for (const id of seen) expect(COMPOSE_POLICY_RULES).toContain(id);
	});
});

describe("settings parsing", () => {
	it("is off by default, with nothing excluded", () => {
		expect(resolveComposePolicySettings(undefined)).toEqual({
			auditEnabled: false,
			exclusions: [],
		});
		expect(resolveComposePolicySettings({})).toEqual({
			auditEnabled: false,
			exclusions: [],
		});
	});

	it("reads the switch and keeps the valid exclusions only", () => {
		expect(
			resolveComposePolicySettings({
				restrictedComposeAudit: true,
				restrictedComposeAuditExclusions: [
					{ id: "a", reason: "legacy" },
					{ id: "" },
					"nope",
					{ id: "b", reason: 5 },
				],
			}),
		).toEqual({
			auditEnabled: true,
			exclusions: [{ id: "a", reason: "legacy" }, { id: "b" }],
		});
		expect(parseComposePolicyExclusions("not a list")).toEqual([]);
	});
});
