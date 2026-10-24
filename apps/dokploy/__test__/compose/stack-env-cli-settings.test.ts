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
import { parse as parseDotenv } from "dotenv";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// T-7138: the Environment of a stack is the whole environment of the docker
// process, and compose reads the `COMPOSE_*` settings of a `.env` as if they
// were in its environment. A variable that docker or compose reads as a setting
// of its own must not be able to aim the CLI at another daemon, make it load a
// host binary, or change what compose reads.
vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	localBase: { path: "" },
}));

vi.mock("node:path", async () => {
	const actual = await vi.importActual<typeof import("node:path")>("node:path");
	return { ...actual, ...actual.posix, default: actual.posix };
});
vi.mock("@dokploy/server/constants", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/constants")>();
	return {
		...actual,
		paths: (isServer = false) =>
			isServer
				? actual.paths(true)
				: { ...actual.paths(true), COMPOSE_PATH: mocks.localBase.path },
	};
});
vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	return {
		...actual,
		execAsyncRemote: mocks.execAsyncRemote,
		writeFileRemote: mocks.writeFileRemote,
	};
});

import {
	buildStackEnvFileContent,
	getBuildComposeCommand,
	getCleanEnvPrefix,
	getIgnoredEnvNames,
	getStackEnvFileContent,
} from "@dokploy/server/utils/builders/compose";
import { NEUTRALISED_CLI_ENV } from "@dokploy/server/utils/docker/env-file";

const baseStack = {
	appName: "stack-app",
	composeId: "c1",
	sourceType: "raw",
	composeFile: "services:\n  web:\n    image: nginx\n",
	command: "",
	composePath: "docker-compose.yml",
	composeType: "stack",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: null,
	env: "",
	mounts: [],
	createEnvFile: false,
	domains: [],
	environment: { project: { env: "" }, env: "" },
} as any;

let tmp = "";
beforeEach(() => {
	vi.clearAllMocks();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = mkdtempSync(`${tmpdir()}/dokploy-stack-settings-`).replaceAll(
		"\\",
		"/",
	);
	mocks.localBase.path = `${tmp}/compose`;
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.writeFileRemote.mockResolvedValue(undefined);
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const CLI_SETTINGS = [
	"DOCKER_HOST",
	"DOCKER_CONFIG",
	"DOCKER_CONTEXT",
	"DOCKER_TLS_VERIFY",
	"DOCKER_CERT_PATH",
	"DOCKER_CLI_PLUGIN_EXTRA_DIRS",
	"DOCKER_API_VERSION",
	"BUILDKIT_HOST",
	"BUILDX_CONFIG",
	"COMPOSE_FILE",
	"COMPOSE_PROJECT_NAME",
	"COMPOSE_ENV_FILES",
	"COMPOSE_PROFILES",
	"COMPOSE_PATH_SEPARATOR",
	"PATH",
	"HOME",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"BASH_ENV",
	"XDG_CONFIG_HOME",
	"GIT_SSH_COMMAND",
] as const;

const ORDINARY = {
	WEB_PORT: "8080",
	TZ: "Europe/Paris",
	LANG: "C.UTF-8",
	LC_ALL: "C",
	HTTP_PROXY: "http://proxy:3128",
	// Environment names are case-sensitive: docker reads only the upper-case ones.
	docker_host: "lower",
	compose_file: "lower",
	Docker_Config: "mixed",
	// Not prefixed by a reserved one.
	DOCKERISH: "1",
	COMPOSER_HOME: "/x",
	MYDOCKER_HOST: "x",
};

const envText = (vars: Record<string, string>) =>
	Object.entries(vars)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");

const evilEnv = (value: string) =>
	Object.fromEntries(CLI_SETTINGS.map((name) => [name, value]));

describe("stack env: docker and compose settings", () => {
	it("leaves every name docker or compose reads as a setting out of the staged file", () => {
		const content = getStackEnvFileContent({
			...baseStack,
			env: envText({ ...evilEnv("evil"), ...ORDINARY }),
		});
		const names = content
			.split("\n")
			.filter(Boolean)
			.map((line) => line.slice(0, line.indexOf("=")));
		for (const name of CLI_SETTINGS) expect(names).not.toContain(name);
		expect(content).not.toContain("evil");
		expect([...names].sort()).toEqual(Object.keys(ORDINARY).sort());
		expect(content).toContain("WEB_PORT='8080'\n");
		expect(content).toContain("docker_host='lower'\n");
	});

	it("reads the names the way the staging code parses them", () => {
		const content = getStackEnvFileContent({
			...baseStack,
			env: [
				"export DOCKER_HOST=ssh://root@other",
				"  DOCKER_CONTEXT = remote",
				"DOCKER_CONFIG: /tmp/evil",
				'export   COMPOSE_FILE="/etc/other.yml"',
				"\tCOMPOSE_ENV_FILES=/etc/dokploy/compose/other/code/.env",
				"export KEPT=1",
			].join("\n"),
		});
		expect(content).toBe("KEPT='1'\n");
	});

	it("filters on the name, so a value that came through a reference is not a way in", () => {
		const content = getStackEnvFileContent({
			...baseStack,
			env: "DOCKER_HOST=${{project.H}}\nOK=${{environment.E}}",
			environment: { project: { env: "H=ssh://root@other" }, env: "E=e" },
		});
		expect(content).toBe("OK='e'\n");
	});

	it("filters in buildStackEnvFileContent as well", () => {
		expect(
			buildStackEnvFileContent({
				DOCKER_HOST: "ssh://x",
				COMPOSE_FILE: "/x",
				KEEP: "1",
			}),
		).toBe("KEEP='1'\n");
	});

	it("lists the names it leaves out, sorted, for a stack and a compose with a .env only", () => {
		const env = "DOCKER_HOST=a\nCOMPOSE_FILE=b\nOK=1";
		expect(getIgnoredEnvNames({ ...baseStack, env })).toEqual([
			"COMPOSE_FILE",
			"DOCKER_HOST",
		]);
		expect(
			getIgnoredEnvNames({
				...baseStack,
				composeType: "docker-compose",
				createEnvFile: true,
				env,
			}),
		).toEqual(["COMPOSE_FILE"]);
		expect(
			getIgnoredEnvNames({
				...baseStack,
				composeType: "docker-compose",
				env,
			}),
		).toEqual([]);
	});

	it("tells the deploy log which names were left out, never their values", async () => {
		const command = await getBuildComposeCommand(
			{
				...baseStack,
				serverId: "srv-1",
				env: "DOCKER_HOST=ssh://root@secret-host\nCOMPOSE_FILE=/x\nWEB_PORT=1",
			},
			{ deploymentId: "dep-1" },
		);
		expect(command).toContain(
			"Warning: ⚠️ Not passed to docker, because docker and compose read them as their own settings: COMPOSE_FILE, DOCKER_HOST",
		);
		expect(command).not.toContain("secret-host");
		const staged = mocks.writeFileRemote.mock.calls.find((call) =>
			String(call[1]).includes("stack-env"),
		);
		expect(staged?.[2]).toBe("WEB_PORT='1'\n");
	});

	it("says nothing when no name is left out", async () => {
		const command = await getBuildComposeCommand(
			{ ...baseStack, serverId: "srv-1", env: "A=1" },
			{ deploymentId: "dep-1" },
		);
		expect(command).not.toContain("Not passed to docker");
	});
});

// Runs the generated script in a real shell, as the deploy does.
const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;
const itWithSh = hasSh ? it : it.skip;

const parseEnv0 = (raw: string) => {
	const vars = new Map<string, string>();
	for (const entry of raw.split("\0")) {
		const at = entry.indexOf("=");
		if (at > 0) vars.set(entry.slice(0, at), entry.slice(at + 1));
	}
	return vars;
};

describe("stack env in a real shell", () => {
	/** A fake docker that records the environment it was run with. */
	const installFakeDocker = () => {
		const bin = `${tmp}/bin`;
		const out = `${tmp}/out`;
		mkdirSync(bin, { recursive: true });
		mkdirSync(out, { recursive: true });
		mkdirSync(`${tmp}/compose/stack-app/code`, { recursive: true });
		writeFileSync(
			`${bin}/docker`,
			`#!/bin/sh\nenv -0 > ${out}/env.bin\nexit 0\n`,
		);
		chmodSync(`${bin}/docker`, 0o755);
		return { bin, out };
	};
	const runScript = (script: string, bin: string) =>
		spawnSync("sh", ["-c", script], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
			},
		});

	itWithSh(
		"does not hand docker a setting; the other variables still arrive",
		async () => {
			const { bin, out } = installFakeDocker();
			const script = await getBuildComposeCommand(
				{ ...baseStack, env: envText({ ...evilEnv(`${tmp}/x`), ...ORDINARY }) },
				{ deploymentId: "dep-sh-settings" },
			);

			const result = runScript(script, bin);

			expect(result.status).toBe(0);
			const received = parseEnv0(readFileSync(`${out}/env.bin`, "utf8"));
			for (const name of CLI_SETTINGS) {
				if (name === "PATH" || name === "HOME") continue;
				expect(received.get(name) ?? "").toBe("");
			}
			// The deploy shell's own PATH and HOME, not the Environment's.
			expect(received.get("PATH")).not.toBe(`${tmp}/x`);
			expect(received.get("HOME")).not.toBe(`${tmp}/x`);
			for (const [key, value] of Object.entries(ORDINARY)) {
				expect(received.get(key)).toBe(value);
			}
		},
	);

	itWithSh(
		"does not let the Environment choose the docker binary through PATH",
		async () => {
			const { bin, out } = installFakeDocker();
			// A planted `docker` in the directory the stack names as its PATH.
			const evil = `${tmp}/evil`;
			mkdirSync(evil, { recursive: true });
			writeFileSync(`${evil}/docker`, `#!/bin/sh\ntouch ${tmp}/pwned\n`);
			chmodSync(`${evil}/docker`, 0o755);
			const script = await getBuildComposeCommand(
				{ ...baseStack, env: `PATH=${evil}\nA=1` },
				{ deploymentId: "dep-sh-path" },
			);

			const result = runScript(script, bin);

			expect(result.status).toBe(0);
			expect(existsSync(`${tmp}/pwned`)).toBe(false);
			expect(existsSync(`${out}/env.bin`)).toBe(true);
		},
	);

	itWithSh(
		"filters every segment of a chained custom command, which share one staged file",
		async () => {
			const { bin, out } = installFakeDocker();
			const script = await getBuildComposeCommand(
				{
					...baseStack,
					command:
						"compose -p stack-app config && docker compose -p stack-app up -d",
					env: "DOCKER_HOST=ssh://root@other\nDOCKER_CONFIG=/tmp/x\nA=1",
				},
				{ deploymentId: "dep-sh-chain" },
			);
			// One loader per docker command, each with the filtered file.
			expect(script.match(/exec "\$@"' sh \S+ docker/g)).toHaveLength(2);

			const result = runScript(script, bin);

			expect(result.status).toBe(0);
			const received = parseEnv0(readFileSync(`${out}/env.bin`, "utf8"));
			expect(received.get("DOCKER_HOST") ?? "").toBe("");
			expect(received.get("DOCKER_CONFIG") ?? "").toBe("");
			expect(received.get("A")).toBe("1");
		},
	);
});

describe("compose .env: COMPOSE_* settings", () => {
	const dockerCompose = {
		...baseStack,
		composeType: "docker-compose",
		serverId: "srv-1",
		createEnvFile: true,
	};
	/** What the deploy script writes to the `.env`. */
	const writtenEnv = async (env: string, overrides = {}) => {
		await getBuildComposeCommand(
			{ ...dockerCompose, env, ...overrides },
			{ deploymentId: "dep-1" },
		);
		const staged = mocks.writeFileRemote.mock.calls.find((call) =>
			String(call[1]).includes("stage-env"),
		);
		return String(staged?.[2]);
	};

	it("keeps the COMPOSE_* settings that steer which files and project compose reads out of the .env", async () => {
		const content = await writtenEnv(
			[
				"COMPOSE_FILE=/etc/dokploy/compose/other/code/docker-compose.yml",
				"COMPOSE_ENV_FILES=/etc/dokploy/compose/other/code/.env",
				"COMPOSE_PATH_SEPARATOR=;",
				"COMPOSE_PROJECT_NAME=other-tenant-app",
				"COMPOSE_UNKNOWN_FUTURE_SETTING=1",
				"KEPT=1",
			].join("\n"),
		);
		expect(content).not.toContain("COMPOSE_FILE");
		expect(content).not.toContain("COMPOSE_ENV_FILES");
		expect(content).not.toContain("COMPOSE_PATH_SEPARATOR");
		expect(content).not.toContain("COMPOSE_UNKNOWN_FUTURE_SETTING");
		expect(content).not.toContain("other-tenant-app");
		expect(content).toContain('KEPT="1"');
	});

	it("always writes Dokploy's project name, once, where it always was", async () => {
		const content = await writtenEnv("COMPOSE_PROJECT_NAME=other\nA=1");
		expect(content.split("\n")).toEqual([
			'APP_NAME="stack-app"',
			'COMPOSE_PROJECT_NAME="stack-app"',
			'A="1"',
			'DOCKER_CONFIG="/root/.docker"',
		]);
	});

	it("keeps the settings that only tune how compose runs, and Dokploy's own COMPOSE_PREFIX", async () => {
		const content = await writtenEnv(
			"COMPOSE_PROFILES=web\nCOMPOSE_PARALLEL_LIMIT=2\nCOMPOSE_IGNORE_ORPHANS=true",
			{ randomize: true, suffix: "abc123" },
		);
		expect(content).toContain('COMPOSE_PROFILES="web"');
		expect(content).toContain('COMPOSE_PARALLEL_LIMIT="2"');
		expect(content).toContain('COMPOSE_IGNORE_ORPHANS="true"');
		expect(content).toContain('COMPOSE_PREFIX="abc123"');
	});

	it("keeps DOCKER_* in the .env: compose reads them from its process environment, not from here", async () => {
		const content = await writtenEnv(
			"DOCKER_HOST=ssh://x\nDOCKER_CONFIG=/srv/docker",
		);
		expect(content).toContain('DOCKER_HOST="ssh://x"');
		expect(content).toContain('DOCKER_CONFIG="/srv/docker"');
		// The process environment of the docker line stays `env -i`.
		const command = await getBuildComposeCommand(
			{ ...dockerCompose, env: "DOCKER_HOST=ssh://x" },
			{ deploymentId: "dep-2" },
		);
		expect(command).toContain(
			`env -i PATH="$PATH" HOME="$HOME" ${NEUTRALISED_CLI_ENV}  docker compose`,
		);
		expect(command).not.toContain("ssh://x");
	});

	it("names the COMPOSE_* variables it left out in the deploy log", async () => {
		const command = await getBuildComposeCommand(
			{ ...dockerCompose, env: "COMPOSE_FILE=/x\nCOMPOSE_PROFILES=web\nA=1" },
			{ deploymentId: "dep-1" },
		);
		expect(command).toContain("read them as their own settings: COMPOSE_FILE'");
	});

	it("writes no .env, and warns of nothing, with Create env file off", async () => {
		const command = await getBuildComposeCommand(
			{
				...dockerCompose,
				createEnvFile: false,
				env: "COMPOSE_FILE=/x\nDOCKER_HOST=ssh://x",
			},
			{ deploymentId: "dep-1" },
		);
		expect(command).not.toContain("Not passed to docker");
		// Only the compose file is staged: Dokploy writes no .env.
		expect(
			mocks.writeFileRemote.mock.calls.filter((call) =>
				String(call[1]).includes("env"),
			),
		).toEqual([]);
	});

	it("filters the .env of a stack that has one, too", async () => {
		const content = await writtenEnv("COMPOSE_FILE=/x\nA=1", {
			composeType: "stack",
		});
		expect(content).not.toContain("COMPOSE_FILE");
		expect(content).toContain("A=1");
		expect(content).toContain("COMPOSE_PROJECT_NAME=stack-app");
	});
});

// Compose before v2.39.3 copies every key of a `.env` into its own environment
// unless the process environment already has it (set, even empty), and docker
// 25+ reads DOCKER_HOST and friends lazily; its children (credential helpers,
// buildx) inherit LD_PRELOAD and BASH_ENV. The prefix every docker command runs
// under sets those empty, so a `.env` cannot supply them.
const DANGEROUS_DOTENV = {
	DOCKER_HOST: "ssh://root@other",
	DOCKER_CONTEXT: "other",
	DOCKER_TLS_VERIFY: "1",
	DOCKER_CERT_PATH: "/tmp/certs",
	DOCKER_API_VERSION: "1.01",
	DOCKER_CONFIG: "/tmp/evil",
	LD_PRELOAD: "/tmp/evil.so",
	LD_LIBRARY_PATH: "/tmp/evil",
	LD_AUDIT: "/tmp/evil.so",
	BASH_ENV: "/tmp/evil.sh",
	GCONV_PATH: "/tmp/evil",
};

const writtenEnvOf = async (env: string, overrides = {}) => {
	await getBuildComposeCommand(
		{
			...baseStack,
			composeType: "docker-compose",
			serverId: "srv-1",
			createEnvFile: true,
			env,
			...overrides,
		},
		{ deploymentId: "dep-1" },
	);
	return String(
		mocks.writeFileRemote.mock.calls.find((call) =>
			String(call[1]).includes("stage-env"),
		)?.[2],
	);
};

describe("the env -i prefix sets the CLI's settings empty (T-7138)", () => {
	it("carries the empty assignments, with and without a staged stack env", () => {
		for (const name of Object.keys(DANGEROUS_DOTENV)) {
			expect(NEUTRALISED_CLI_ENV).toContain(`${name}=`);
		}
		expect(getCleanEnvPrefix()).toBe(
			`env -i PATH="$PATH" HOME="$HOME" ${NEUTRALISED_CLI_ENV} `,
		);
		expect(getCleanEnvPrefix("/x/staged")).toContain(
			`HOME="$HOME" ${NEUTRALISED_CLI_ENV} sh -c`,
		);
	});

	itWithSh(
		"keeps a .env that compose before v2.39.3 copies from setting them (names only)",
		async () => {
			const dir = `${tmp}/project`;
			mkdirSync(dir, { recursive: true });
			// What Dokploy writes for a compose whose Environment holds the settings.
			const written = await writtenEnvOf(envText(DANGEROUS_DOTENV));
			for (const name of Object.keys(DANGEROUS_DOTENV)) {
				expect(written).toContain(`${name}=`);
			}
			writeFileSync(`${dir}/.env`, `${written}\n`);
			// A docker that does what setEnvWithDotEnv does before v2.39.3 (copy a
			// key unless the environment has it, empty or not), then writes the
			// NAMES of the settings that ended up non-empty. Never a value.
			writeFileSync(
				`${dir}/docker`,
				[
					"#!/bin/sh",
					"while IFS= read -r line; do",
					"  key=${line%%=*}; value=${line#*=}",
					'  [ -n "$key" ] || continue',
					'  value=${value#\\"}; value=${value%\\"}',
					'  if ! printenv "$key" >/dev/null 2>&1 && [ -n "$value" ]; then echo "$key"; fi',
					`done < .env > ${tmp}/names.txt`,
				].join("\n"),
			);
			chmodSync(`${dir}/docker`, 0o755);
			const run = (prefix: string) => {
				spawnSync("sh", ["-c", `cd ${dir} && ${prefix} ${dir}/docker`], {
					encoding: "utf8",
				});
				return readFileSync(`${tmp}/names.txt`, "utf8")
					.split("\n")
					.filter((name) => name in DANGEROUS_DOTENV)
					.sort();
			};

			// The control: the old prefix lets the .env supply every one of them.
			expect(run('env -i PATH="$PATH" HOME="$HOME"')).toEqual(
				Object.keys(DANGEROUS_DOTENV).sort(),
			);
			// The prefix of a deploy does not let it supply any.
			expect(run(getCleanEnvPrefix())).toEqual([]);
		},
	);
});

describe("compose .env: other settings and line breaks (T-7138)", () => {
	it("keeps the neutralised names and other DOCKER_*, leaves out the settings nothing neutralises", async () => {
		const content = await writtenEnvOf(
			[
				"DOCKER_HOST=ssh://x",
				"DOCKER_REGISTRY=reg.example.com",
				"LD_PRELOAD=/x.so",
				"BUILDX_CONFIG=/x",
				"BUILDKIT_HOST=tcp://x",
				"GIT_SSH_COMMAND=x",
				"XDG_CONFIG_HOME=/x",
				"LD_DEBUG=all",
				"SSH_ASKPASS=/x",
				"my-var=1",
				"KEPT=1",
			].join("\n"),
		);
		expect(content).toContain('DOCKER_HOST="ssh://x"');
		expect(content).toContain('DOCKER_REGISTRY="reg.example.com"');
		expect(content).toContain('LD_PRELOAD="/x.so"');
		expect(content).toContain('my-var="1"');
		expect(content).toContain('KEPT="1"');
		for (const name of [
			"BUILDX_CONFIG",
			"BUILDKIT_HOST",
			"GIT_SSH_COMMAND",
			"XDG_CONFIG_HOME",
			"LD_DEBUG",
			"SSH_ASKPASS",
		]) {
			expect(content).not.toContain(name);
		}
	});

	const dotenvKeys = (content: string) => Object.keys(parseDotenv(content));

	it("does not let a multi-line value of a stack's .env add a variable of its own", async () => {
		const content = await writtenEnvOf(
			'A="x\nCOMPOSE_FILE=evil.yml\nDOCKER_HOST=ssh://x"\nB=2',
			{ composeType: "stack" },
		);
		expect(dotenvKeys(content)).toEqual([
			"APP_NAME",
			"COMPOSE_PROJECT_NAME",
			"A",
			"B",
			"DOCKER_CONFIG",
		]);
		expect(parseDotenv(content).A).toBe(
			"x\nCOMPOSE_FILE=evil.yml\nDOCKER_HOST=ssh://x",
		);
		// A carriage return too.
		const withCr = await writtenEnvOf('A="x\rCOMPOSE_FILE=evil.yml"', {
			composeType: "stack",
		});
		expect(dotenvKeys(withCr)).not.toContain("COMPOSE_FILE");
	});

	it("keeps a stack's single-line values unquoted, as its services read them", async () => {
		const content = await writtenEnvOf("A=1\nB=two words", {
			composeType: "stack",
		});
		expect(content).toContain("\nA=1\n");
		expect(content).toContain("\nB=two words\n");
	});

	it("does the same for a compose's .env", async () => {
		const content = await writtenEnvOf('A="x\nCOMPOSE_FILE=evil.yml"\nB=2');
		expect(dotenvKeys(content)).not.toContain("COMPOSE_FILE");
		expect(parseDotenv(content).A).toBe("x\nCOMPOSE_FILE=evil.yml");
	});
});
