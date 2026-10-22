import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { quote } from "shell-quote";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// An application's env, build args and build secrets used to travel on the
// build command line (`--build-arg KEY=value`, `--env KEY=value`) and, for the
// `.env` file, as a base64 blob inside the script: visible in the host's process
// list and counted toward the 128 KB limit on one shell argument. They are now
// staged as 0600 files; a loader sources the build env file so the build tool
// reads its variables from its environment, and the `.env` is copied from its
// staged file.
const MAX_ARG_STRLEN = 128 * 1024;

vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	findServerById: vi.fn(),
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
		// Local (no serverId) paths point at a temp dir; remote ones stay fixed.
		paths: (isServer = false) =>
			isServer
				? actual.paths(true)
				: { ...actual.paths(true), APPLICATIONS_PATH: mocks.localBase.path },
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
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
}));

import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { getDockerCommand } from "@dokploy/server/utils/builders/docker-file";
import { getHerokuCommand } from "@dokploy/server/utils/builders/heroku";
import { getNixpacksCommand } from "@dokploy/server/utils/builders/nixpacks";
import { getPaketoCommand } from "@dokploy/server/utils/builders/paketo";
import { getRailpackCommand } from "@dokploy/server/utils/builders/railpack";
import { getStaticCommand } from "@dokploy/server/utils/builders/static";
import {
	getAppEnvFileContent,
	getBuildEnvFile,
	stageBuildFiles,
} from "@dokploy/server/utils/builders/utils";
import {
	buildEnvFileContent,
	getEnvFileLoader,
	isEnvFileName,
} from "@dokploy/server/utils/docker/env-file";
import { removeStagedFiles } from "@dokploy/server/utils/docker/staging";
import { prepareEnvironmentVariablesForShell } from "@dokploy/server/utils/docker/utils";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

// Quotes, `$`, backticks, a command substitution, backslashes and `=`.
const TRICKY: Record<string, string> = {
	T_QUOTES: `it's a "test" with 'single' and "double" quotes`,
	T_DOLLAR: "$HOME ${PATH} $(echo pwned) `echo pwned` $$ $1",
	T_BACKSLASH: "back\\slash \\n literal \\\\ end\\",
	T_EQUALS: "a=b=c",
	// dotenv trims unquoted values before they reach the builders, so only inner spaces survive.
	T_SPACES: "padded   value",
	T_UNICODE: "héllo ✅ 日本語",
};
const trickyText = Object.entries(TRICKY)
	.map(([key, value]) => `${key}=${value}`)
	.join("\n");

/** Distinct, secret looking `KEY=value` lines of roughly `kb` KB. */
const bigEnv = (kb: number, prefix = "BIGSECRET") => {
	const lines: string[] = [];
	let size = 0;
	for (let i = 0; size < kb * 1024; i++) {
		const line = `${prefix}_${i}=hunter2-${i}-${"x".repeat(48)}`;
		lines.push(line);
		size += line.length + 1;
	}
	return lines.join("\n");
};

/** `count` variables of `kb` KB each: the size is in the values, not the names. */
const bigValues = (count: number, kb: number, prefix: string) =>
	Array.from(
		{ length: count },
		(_, i) => `${prefix}_${i}=hunter2-${i}-${"x".repeat(kb * 1024)}`,
	).join("\n");

const createApplication = (overrides: Record<string, unknown> = {}) =>
	({
		appName: "build-app",
		buildType: "dockerfile",
		sourceType: "git",
		buildPath: "/",
		railpackVersion: "0.15.4",
		env: null,
		buildArgs: null,
		buildSecrets: null,
		cleanCache: false,
		createEnvFile: false,
		publishDirectory: null,
		environment: { env: "", project: { env: "" } },
		...overrides,
	}) as unknown as ApplicationNested;

let tmp = "";
beforeEach(() => {
	vi.clearAllMocks();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = mkdtempSync(`${tmpdir()}/dokploy-build-env-`).replaceAll("\\", "/");
	mocks.localBase.path = `${tmp}/applications`;
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.writeFileRemote.mockResolvedValue(undefined);
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const stagedDir = () => `${tmp}/applications/build-app`;
const stagedIn = (directory: string) =>
	existsSync(directory)
		? readdirSync(directory).filter((name) => name.startsWith(".dokploy-"))
		: [];

type Builder = (
	application: ApplicationNested,
	options?: { deploymentId?: string; serverId?: string | null },
) => Promise<string>;
const builders: Array<[string, string, Builder]> = [
	["dockerfile", "dockerfile", getDockerCommand],
	["nixpacks", "nixpacks", getNixpacksCommand],
	["heroku", "heroku_buildpacks", getHerokuCommand],
	["paketo", "paketo_buildpacks", getPaketoCommand],
	["railpack", "railpack", getRailpackCommand],
	["static", "static", getStaticCommand],
];

describe("env file names", () => {
	it("accepts ordinary variable names", () => {
		for (const name of ["API_KEY", "_x", "a1", "NODE_ENV", "DATABASE_URL"]) {
			expect(isEnvFileName(name), name).toBe(true);
		}
	});

	it("rejects names a shell cannot source", () => {
		for (const name of ["BAD-NAME", "1BAD", "EVIL;touch pwned", "A B", ""]) {
			expect(isEnvFileName(name), name).toBe(false);
		}
	});

	it("rejects names that would change how the build tool itself runs", () => {
		for (const name of [
			"PATH",
			"HOME",
			"IFS",
			"UID",
			"PPID",
			"LD_PRELOAD",
			"DOCKER_HOST",
			"BUILDKIT_SYNTAX",
			"HTTP_PROXY",
			"https_proxy",
			"NO_PROXY",
			"SSH_AUTH_SOCK",
			"LC_ALL",
			"BASH_ENV",
			"GOGC",
			"GOMEMLIMIT",
			"GODEBUG",
			"GIT_SSH_COMMAND",
			"PACK_VOLUME_KEY",
			"XDG_DATA_HOME",
			"REGISTRY_AUTH_FILE",
			"MALLOC_ARENA_MAX",
		]) {
			expect(isEnvFileName(name), name).toBe(false);
		}
	});

	it("keeps names that only look like reserved ones", () => {
		// No bare "GO" or "GIT" prefix: these are ordinary build variables.
		for (const name of ["GOOGLE_API_KEY", "GO_ENV", "GITHUB_TOKEN", "PACKAGE"]) {
			expect(isEnvFileName(name), name).toBe(true);
		}
	});

	it("stages ordinary GIT_ and PACK_ build arguments", () => {
		for (const name of [
			"GIT_TOKEN",
			"GIT_PASSWORD",
			"GIT_COMMIT_SHA",
			"GIT_CONFIG_FOO",
			"PACK_FOO",
			"PACK_TOKEN",
		]) {
			expect(isEnvFileName(name), name).toBe(true);
		}
	});

	it("keeps the variables git and pack read for themselves reserved", () => {
		for (const name of [
			"GIT_SSH",
			"GIT_SSH_COMMAND",
			"GIT_ASKPASS",
			"GIT_DIR",
			"GIT_WORK_TREE",
			"GIT_EXEC_PATH",
			"GIT_TEMPLATE_DIR",
			"GIT_CONFIG",
			"GIT_CONFIG_GLOBAL",
			"GIT_CONFIG_SYSTEM",
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_KEY_0",
			"GIT_CONFIG_VALUE_12",
			"PACK_HOME",
			"PACK_VOLUME_KEY",
			// Behaviour the git run itself reads (and logs).
			...["GIT_CURL_VERBOSE",
			"GIT_CONFIG_PARAMETERS",
			"GIT_CONFIG_NOSYSTEM",
			"GIT_PROXY_COMMAND",
			"GIT_INDEX_FILE",
			"GIT_OBJECT_DIRECTORY",
			"GIT_ALTERNATE_OBJECT_DIRECTORIES",
			"GIT_COMMON_DIR",
			"GIT_CEILING_DIRECTORIES",
			"GIT_DISCOVERY_ACROSS_FILESYSTEM",
			"GIT_EXTERNAL_DIFF",
			"GIT_PAGER",
			"GIT_EDITOR",
			"GIT_SEQUENCE_EDITOR",
			"GIT_TERMINAL_PROMPT",
			"GIT_SSH_VARIANT",
			"GIT_ALLOW_PROTOCOL",
			"GIT_PROTOCOL_FROM_USER",
			"GIT_NAMESPACE",
			"GIT_REPLACE_REF_BASE",
			"GIT_NO_REPLACE_OBJECTS",
			"GIT_QUARANTINE_PATH",
			"GIT_OPTIONAL_LOCKS",
			"GIT_REDACT_COOKIES"],
			// One name per reserved prefix.
			"GIT_TRACE",
			"GIT_TRACE_CURL",
			"GIT_SSL_NO_VERIFY",
			"GIT_HTTP_PROXY_AUTHMETHOD",
		]) {
			expect(isEnvFileName(name), name).toBe(false);
		}
	});

	it("single-quotes every value, whatever it holds", () => {
		expect(buildEnvFileContent([["A", "it's"]])).toBe("A='it'\\''s'\n");
		expect(buildEnvFileContent([["A", "$(x) `y`\nz"]])).toBe("A='$(x) `y`\nz'\n");
	});
});

describe.each(builders)("%s builder keeps values out of the command", (name, buildType, build) => {
	const application = (overrides: Record<string, unknown> = {}) =>
		createApplication({
			buildType,
			publishDirectory: name === "static" ? "dist" : null,
			env: "API_TOKEN=supersecret-token-1\nDB_PASSWORD=p4ss'w\"ord$(id)",
			buildArgs: "NPM_TOKEN=npm-secret-2",
			buildSecrets: "REGISTRY_PASSPHRASE=passphrase-secret-3",
			...overrides,
		});

	it("passes names only and stages the values on the build server", async () => {
		const command = await build(application({ serverId: "srv-1" }), {
			deploymentId: "dep-1",
			serverId: "srv-1",
		});

		for (const secret of [
			"supersecret-token-1",
			"p4ss",
			"npm-secret-2",
			"passphrase-secret-3",
		]) {
			expect(command, secret).not.toContain(secret);
		}
		// The values were written through SFTP, to the file the command loads.
		expect(mocks.writeFileRemote).toHaveBeenCalled();
		const written = mocks.writeFileRemote.mock.calls.map(
			(call) => [call[1], call[2]] as [string, string],
		);
		const all = written.map(([, content]) => content).join("\n");
		if (name === "dockerfile" || name === "static") {
			expect(all).toContain("NPM_TOKEN='npm-secret-2'");
			expect(all).toContain("REGISTRY_PASSPHRASE='passphrase-secret-3'");
			expect(command).toContain("--build-arg NPM_TOKEN");
			expect(command).not.toMatch(/--build-arg NPM_TOKEN=/);
			expect(command).toContain("--secret type=env,id=REGISTRY_PASSPHRASE");
		} else {
			expect(all).toContain("API_TOKEN='supersecret-token-1'");
			expect(command).toMatch(/--env API_TOKEN(?![=\w])/);
			expect(command).not.toMatch(/--env API_TOKEN=/);
		}
		for (const [path] of written) {
			expect(path).toMatch(
				/^\/etc\/dokploy\/applications\/build-app\/\.dokploy-stage-[a-z-]*env-dep-1$/,
			);
			expect(command).toContain(path);
		}
		// Created 0600 before it holds content.
		const prepare = mocks.execAsyncRemote.mock.calls
			.map((call) => call[1] as string)
			.join("\n");
		expect(prepare).toContain("umask 077");
		// The file is removed after the build and on its failure branch.
		const removals = command.match(/rm -f [^;\n]*\.dokploy-stage-[^;\n]*/g);
		expect(removals?.length ?? 0).toBeGreaterThanOrEqual(2);
	});

	it("stays far under the argument limit with 300 KB of values", async () => {
		const command = await build(
			application({
				env: bigValues(4, 75, "BIGENV"),
				buildArgs: bigValues(4, 75, "BIGARG"),
				buildSecrets: bigValues(2, 75, "BIGSEC"),
			}),
			{ deploymentId: "dep-big" },
		);

		expect(bytes(command)).toBeLessThan(MAX_ARG_STRLEN / 8);
		expect(command).not.toContain("hunter2");
	});

	it("keeps a command with hundreds of variables under the limit", async () => {
		// Only the names are left on the command line.
		const command = await build(
			application({
				env: bigEnv(60),
				buildArgs: bigEnv(60, "BIGARG"),
				buildSecrets: null,
			}),
			{ deploymentId: "dep-many" },
		);

		expect(bytes(command)).toBeLessThan(MAX_ARG_STRLEN);
		expect(command).not.toContain("hunter2");
	});

	it("is unchanged by the staging when there is nothing to hide", async () => {
		const command = await build(
			application({ env: null, buildArgs: null, buildSecrets: null }),
			{ deploymentId: "dep-none" },
		);

		expect(command).not.toContain(".dokploy-stage-");
		expect(command).not.toContain("set -a");
		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
	});
});

describe("variables the env file cannot carry keep their command line form", () => {
	it("passes reserved and empty ones inline, unchanged", async () => {
		const command = await getNixpacksCommand(
			createApplication({
				buildType: "nixpacks",
				env: "PATH=/custom/bin\nDOCKER_HOST=tcp://x:2375\nEMPTY=\nNORMAL=value-7",
			}),
			{ deploymentId: "dep-res" },
		);

		expect(command).toContain(`--env ${quote(["PATH=/custom/bin"])}`);
		expect(command).toContain(`--env ${quote(["DOCKER_HOST=tcp://x:2375"])}`);
		expect(command).toContain(`--env ${quote(["EMPTY="])}`);
		expect(command).toMatch(/--env NORMAL(?![=\w])/);
		expect(command).not.toContain("value-7");
	});

	it("keeps a docker build arg that clashes with a secret of the same name", async () => {
		const command = await getDockerCommand(
			createApplication({
				buildArgs: "TOKEN=from-arg",
				buildSecrets: "TOKEN=from-secret",
			}),
			{ deploymentId: "dep-clash" },
		);

		expect(command).toContain(`--build-arg ${quote(["TOKEN=from-arg"])}`);
		expect(command).toContain("--secret type=env,id=TOKEN");
		expect(command).not.toContain("from-secret");
	});

	it("exports a railpack secret the env file cannot carry, as before", async () => {
		const command = await getRailpackCommand(
			createApplication({
				buildType: "railpack",
				env: "LD_PRELOAD=/x.so\nAPI_TOKEN=railpack-secret",
			}),
			{ deploymentId: "dep-rp" },
		);

		expect(command).toContain(`export LD_PRELOAD=${quote(["/x.so"])}`);
		expect(command).not.toContain("railpack-secret");
		expect(command).toContain("--secret id=API_TOKEN,env=API_TOKEN");
		expect(command).toContain("--secret id=LD_PRELOAD,env=LD_PRELOAD");
	});

	it("hashes the same variables to the same railpack cache key as before", async () => {
		const a = await getRailpackCommand(
			createApplication({ buildType: "railpack", env: "A=1\nB=two words" }),
			{ deploymentId: "x" },
		);
		const b = await getRailpackCommand(
			createApplication({ buildType: "railpack", env: "A=1\nB=two words" }),
			{ deploymentId: "y" },
		);
		const hash = (command: string) =>
			command.match(/secrets-hash=([a-f0-9]{64})/)?.[1];
		expect(hash(a)).toBe(hash(b));
		// The input before this change: the shell-quoted `KEY=value` strings from
		// prepareEnvironmentVariablesForShell, sorted, fed to sha256.
		const { createHash } = await import("node:crypto");
		const previous = createHash("sha256");
		for (const variable of prepareEnvironmentVariablesForShell(
			"A=1\nB=two words",
			"",
			"",
		).sort()) {
			previous.update(variable);
		}
		expect(hash(a)).toBe(previous.digest("hex"));
	});
});

describe("application .env file", () => {
	const dockerfileApp = (overrides: Record<string, unknown> = {}) =>
		createApplication({
			buildType: "dockerfile",
			createEnvFile: true,
			env: "APP_SECRET=env-file-secret-9\nOTHER=1",
			...overrides,
		});

	it("is staged, not embedded as base64 in the command", async () => {
		const command = await getDockerCommand(
			dockerfileApp({ serverId: "srv-1" }),
			{ deploymentId: "dep-env", serverId: "srv-1" },
		);

		const content = getAppEnvFileContent(
			"APP_SECRET=env-file-secret-9\nOTHER=1",
		);
		expect(command).not.toContain("base64");
		expect(command).not.toContain(Buffer.from(content).toString("base64"));
		expect(command).not.toContain("env-file-secret-9");
		const written = mocks.writeFileRemote.mock.calls.find((call) =>
			(call[1] as string).includes("app-env"),
		);
		expect(written?.[2]).toBe(content);
		expect(command).toContain(
			"cat /etc/dokploy/applications/build-app/.dokploy-stage-app-env-dep-env > /etc/dokploy/applications/build-app/code/.env",
		);
	});

	it("stays under the argument limit with a 300 KB env", async () => {
		const command = await getDockerCommand(
			dockerfileApp({ env: bigEnv(300) }),
			{ deploymentId: "dep-env-big" },
		);

		expect(bytes(command)).toBeLessThan(MAX_ARG_STRLEN / 8);
	});

	it("is not written when publishDirectory is set or createEnvFile is off", async () => {
		await getDockerCommand(
			dockerfileApp({ publishDirectory: "dist", serverId: "srv-1" }),
			{ deploymentId: "dep-a", serverId: "srv-1" },
		);
		await getDockerCommand(
			dockerfileApp({ createEnvFile: false, serverId: "srv-1" }),
			{ deploymentId: "dep-b", serverId: "srv-1" },
		);

		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
	});
});

describe("stageBuildFiles", () => {
	it("writes nothing for no files", async () => {
		expect(await stageBuildFiles("build-app", [], { serverId: "s" })).toEqual(
			[],
		);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("stages on the given server and reports the paths", async () => {
		const onStaged = vi.fn();
		const [path] = await stageBuildFiles(
			"build-app",
			[{ kind: "build-env", content: "A='1'\n" }],
			{ serverId: "build-1", deploymentId: "dep-s", onStaged },
		);

		expect(path).toBe(
			"/etc/dokploy/applications/build-app/.dokploy-stage-build-env-dep-s",
		);
		expect(mocks.writeFileRemote).toHaveBeenCalledWith(
			"build-1",
			path,
			"A='1'\n",
		);
		expect(onStaged).toHaveBeenCalledWith([path]);
	});

	it("stages locally with mode 0600", async () => {
		const [path] = await stageBuildFiles(
			"build-app",
			[{ kind: "build-env", content: "A='1'\n" }],
			{ deploymentId: "dep-l" },
		);

		expect(path).toBe(`${stagedDir()}/.dokploy-stage-build-env-dep-l`);
		expect(readFileSync(path as string, "utf8")).toBe("A='1'\n");
		if (process.platform !== "win32") {
			expect(statSync(path as string).mode & 0o777).toBe(0o600);
		}
	});
});

// Runs the generated commands in a real shell, with fake build tools that record
// the environment and arguments they were started with.
const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;
const itWithSh = hasSh ? it : it.skip;

/** Parses `env -0` output. */
const parseEnv0 = (raw: string) => {
	const vars = new Map<string, string>();
	for (const entry of raw.split("\0")) {
		const at = entry.indexOf("=");
		if (at > 0) vars.set(entry.slice(0, at), entry.slice(at + 1));
	}
	return vars;
};

describe("build commands in a real shell", () => {
	const installFakeTools = (exitCode: number) => {
		const bin = `${tmp}/bin`;
		const out = `${tmp}/out`;
		mkdirSync(bin, { recursive: true });
		mkdirSync(out, { recursive: true });
		for (const tool of ["docker", "pack", "nixpacks", "railpack"]) {
			// Each docker subcommand records on its own (`docker-build`,
			// `docker-buildx`), and the builder setup and teardown (`buildx create`,
			// `buildx rm`) record nothing and always succeed.
			const name = tool === "docker" ? "docker-$1" : tool;
			writeFileSync(
				`${bin}/${tool}`,
				`#!/bin/sh\ncase "$1 $2" in "buildx rm"|"buildx create") exit 0;; esac\nenv -0 > ${out}/${name}.env.bin\nls -A ${tmp}/applications/build-app | grep '^.dokploy-stage-build-env' > ${out}/${name}.staged.txt\nprintf '%s\\n' "$@" > ${out}/${name}.args.txt\nexit ${exitCode}\n`,
			);
			chmodSync(`${bin}/${tool}`, 0o755);
		}
		// The command `cd`s into the build context a clone would have made.
		mkdirSync(`${tmp}/applications/build-app/code`, { recursive: true });
		return { bin, out };
	};
	const run = (script: string, bin: string) =>
		spawnSync("sh", ["-c", script], {
			encoding: "utf8",
			cwd: tmp,
			env: {
				...process.env,
				PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
			},
		});
	const received = (out: string, tool: string) =>
		parseEnv0(readFileSync(`${out}/${tool}.env.bin`, "utf8"));
	const argsOf = (out: string, tool: string) =>
		readFileSync(`${out}/${tool}.args.txt`, "utf8");
	/** Staged build env files still on disk when the tool started. */
	const stagedAtStart = (out: string, tool: string) =>
		readFileSync(`${out}/${tool}.staged.txt`, "utf8").trim();

	itWithSh(
		"docker build gets build args and secrets in its environment, none in argv",
		async () => {
			const { bin, out } = installFakeTools(0);
			const script = await getDockerCommand(
				createApplication({
					buildArgs: `${trickyText}\n${bigEnv(60, "BIGARG")}`,
					buildSecrets: "SECRET_ONE=s3cr3t-one",
				}),
				{ deploymentId: "dep-sh" },
			);
			expect(bytes(script)).toBeLessThan(MAX_ARG_STRLEN / 4);

			const result = run(script, bin);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("Docker build completed");
			const env = received(out, "docker-build");
			for (const [key, value] of Object.entries(TRICKY)) {
				expect(env.get(key), key).toBe(value);
			}
			expect(env.get("BIGARG_0")).toBe(`hunter2-0-${"x".repeat(48)}`);
			expect(env.get("SECRET_ONE")).toBe("s3cr3t-one");
			const args = argsOf(out, "docker-build");
			expect(args).toContain("--build-arg\nT_QUOTES\n");
			expect(args).toContain("--build-arg\nBIGARG_0\n");
			expect(args).toContain("--secret\ntype=env,id=SECRET_ONE\n");
			expect(args).not.toContain("hunter2");
			expect(args).not.toContain("s3cr3t-one");
			expect(args).not.toContain("pwned");
			expect(stagedIn(stagedDir())).toEqual([]);
		},
	);

	itWithSh("docker build still reads an inline-only secret name", async () => {
		const { bin, out } = installFakeTools(0);
		const script = await getDockerCommand(
			createApplication({ buildSecrets: "DOCKER_SECRET=inline-ok" }),
			{ deploymentId: "dep-inline" },
		);

		const result = run(script, bin);

		expect(result.status).toBe(0);
		expect(received(out, "docker-build").get("DOCKER_SECRET")).toBe("inline-ok");
	});

	itWithSh(
		"nixpacks, heroku and paketo get their env from the environment",
		async () => {
			for (const [build, buildType, tool] of [
				[getNixpacksCommand, "nixpacks", "nixpacks"],
				[getHerokuCommand, "heroku_buildpacks", "pack"],
				[getPaketoCommand, "paketo_buildpacks", "pack"],
			] as const) {
				const { bin, out } = installFakeTools(0);
				const script = await build(
					createApplication({
						buildType,
						env: `${trickyText}\n${bigEnv(60)}`,
					}),
					{ deploymentId: `dep-${buildType}` },
				);
				expect(bytes(script)).toBeLessThan(MAX_ARG_STRLEN / 4);

				const result = run(script, bin);

				expect(result.status, buildType).toBe(0);
				const env = received(out, tool);
				for (const [key, value] of Object.entries(TRICKY)) {
					expect(env.get(key), `${buildType} ${key}`).toBe(value);
				}
				expect(env.get("BIGSECRET_800")).toBe(`hunter2-800-${"x".repeat(48)}`);
				const args = argsOf(out, tool);
				expect(args).toContain("--env\nT_QUOTES\n");
				expect(args).not.toContain("hunter2");
				expect(args).not.toContain("pwned");
				expect(stagedIn(stagedDir())).toEqual([]);
			}
		},
	);

	itWithSh(
		"railpack gets prepare's env and the buildx secrets from the environment",
		async () => {
			const { bin, out } = installFakeTools(0);
			// The script downloads railpack; the fake tools stand in for it.
			const script = (
				await getRailpackCommand(
					createApplication({
						buildType: "railpack",
						env: `${trickyText}\nLD_PRELOAD=/x.so`,
					}),
					{ deploymentId: "dep-rp-sh" },
				)
			).replace(/^\$SUDO_CMD bash -c .*$/m, "true");

			const result = run(script, bin);

			expect(result.status).toBe(0);
			expect(stagedIn(stagedDir())).toEqual([]);
			const prepareEnv = received(out, "railpack");
			for (const [key, value] of Object.entries(TRICKY)) {
				expect(prepareEnv.get(key), key).toBe(value);
			}
			const args = argsOf(out, "railpack");
			expect(args).toContain("--env\nT_QUOTES\n");
			expect(args).toContain("--env\nLD_PRELOAD=/x.so\n");
			expect(args).not.toContain("pwned");
			// The buildx secrets come from the environment of the build itself.
			const buildEnv = received(out, "docker-buildx");
			for (const [key, value] of Object.entries(TRICKY)) {
				expect(buildEnv.get(key), `buildx ${key}`).toBe(value);
			}
			expect(buildEnv.get("LD_PRELOAD")).toBe("/x.so");
			const buildArgs = argsOf(out, "docker-buildx");
			expect(buildArgs).toContain("--secret\nid=T_QUOTES,env=T_QUOTES\n");
			expect(buildArgs).not.toContain("pwned");
		},
	);

	itWithSh("removes the staged env when the build fails", async () => {
		const { bin } = installFakeTools(1);
		const script = await getNixpacksCommand(
			createApplication({ buildType: "nixpacks", env: "API_TOKEN=abc123" }),
			{ deploymentId: "dep-fail" },
		);

		const result = run(script, bin);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Nixpacks build failed");
		expect(stagedIn(stagedDir())).toEqual([]);
	});

	itWithSh(
		"a script that stops before the build leaves nothing once the caller cleans up",
		async () => {
			const { bin, out } = installFakeTools(0);
			const staged: string[] = [];
			const script = await getNixpacksCommand(
				createApplication({ buildType: "nixpacks", env: "API_TOKEN=abc123" }),
				{ deploymentId: "dep-early", onStaged: (paths) => staged.push(...paths) },
			);
			expect(staged).toHaveLength(1);

			// The clone fails under `set -e` before the build step is reached.
			const result = run(`set -e; false; ${script}`, bin);

			expect(result.status).not.toBe(0);
			expect(existsSync(`${out}/nixpacks.env.bin`)).toBe(false);
			// Only the caller knows the script never got that far.
			expect(stagedIn(stagedDir())).toHaveLength(1);
			await removeStagedFiles(null, staged);
			expect(stagedIn(stagedDir())).toEqual([]);
		},
	);

	itWithSh(
		"nixpacks with a publish directory leaves no docker env file when it fails",
		async () => {
			const { bin } = installFakeTools(1);
			const staged: string[] = [];
			const script = await getNixpacksCommand(
				createApplication({
					buildType: "nixpacks",
					publishDirectory: "dist",
					env: "API_TOKEN=abc123",
					buildArgs: "NPM_TOKEN=abc",
				}),
				{ deploymentId: "dep-pub", onStaged: (paths) => staged.push(...paths) },
			);
			// The nixpacks file and the static stage's docker file.
			expect(staged).toHaveLength(2);
			expect(stagedIn(stagedDir())).toHaveLength(2);

			const result = run(script, bin);

			expect(result.status).toBe(1);
			expect(result.stdout).toContain("Nixpacks build failed");
			expect(stagedIn(stagedDir())).toEqual([]);
		},
	);

	itWithSh(
		"nixpacks with a publish directory leaves no docker env file when the copy fails",
		async () => {
			const { bin } = installFakeTools(0);
			// `docker cp` fails; every other docker call succeeds.
			writeFileSync(
				`${bin}/docker`,
				'#!/bin/sh\ncase "$1" in cp) exit 1;; esac\nexit 0\n',
			);
			chmodSync(`${bin}/docker`, 0o755);
			const script = await getNixpacksCommand(
				createApplication({
					buildType: "nixpacks",
					publishDirectory: "dist",
					env: "API_TOKEN=abc123",
					buildArgs: "NPM_TOKEN=abc",
				}),
				{ deploymentId: "dep-cp" },
			);
			expect(stagedIn(stagedDir())).toHaveLength(2);

			const result = run(script, bin);

			expect(result.status).toBe(1);
			expect(result.stdout).toContain("failed");
			expect(stagedIn(stagedDir())).toEqual([]);
		},
	);

	describe("a single-use loader consumes the staged file", () => {
		const secrets = {
			env: "API_TOKEN=abc123",
			buildArgs: "NPM_TOKEN=abc",
		};
		// [name, buildType, builder, fake tool, a variable that tool must receive]
		const singleUse: Array<[string, string, Builder, string, string]> = [
			["dockerfile", "dockerfile", getDockerCommand, "docker-build", "NPM_TOKEN"],
			["nixpacks", "nixpacks", getNixpacksCommand, "nixpacks", "API_TOKEN"],
			["heroku", "heroku_buildpacks", getHerokuCommand, "pack", "API_TOKEN"],
			["paketo", "paketo_buildpacks", getPaketoCommand, "pack", "API_TOKEN"],
		];

		for (const [name, buildType, build, tool, variable] of singleUse) {
			itWithSh(`${name} deletes the file as soon as it is sourced`, async () => {
				const { bin, out } = installFakeTools(0);
				const script = await build(
					createApplication({ buildType, ...secrets }),
					{ deploymentId: `dep-${name}-once` },
				);
				expect(stagedIn(stagedDir()).length).toBeGreaterThan(0);

				const result = run(script, bin);

				expect(result.status).toBe(0);
				// Sourced (the tool has the variable) and already gone while it runs.
				expect(received(out, tool).has(variable)).toBe(true);
				expect(stagedAtStart(out, tool)).toBe("");
				expect(stagedIn(stagedDir())).toEqual([]);
			});

			itWithSh(
				`${name} still fails without running the tool when the file is gone`,
				async () => {
					const { bin, out } = installFakeTools(0);
					const script = await build(
						createApplication({ buildType, ...secrets }),
						{ deploymentId: `dep-${name}-gone` },
					);
					for (const file of stagedIn(stagedDir())) {
						rmSync(`${stagedDir()}/${file}`);
					}

					const result = run(script, bin);

					expect(result.status).toBe(1);
					expect(existsSync(`${out}/${tool}.env.bin`)).toBe(false);
				},
			);
		}

		itWithSh(
			"railpack keeps the file for its second read, the script's cleanup removes it",
			async () => {
				const { bin, out } = installFakeTools(0);
				const script = (
					await getRailpackCommand(
						createApplication({ buildType: "railpack", ...secrets }),
						{ deploymentId: "dep-rp-twice" },
					)
				).replace(/^\$SUDO_CMD bash -c .*$/m, "true");
				expect(script).not.toContain('rm -f -- "$1"');

				const result = run(script, bin);

				expect(result.status).toBe(0);
				// Still there for prepare, and for the build that reads it again.
				expect(stagedAtStart(out, "railpack")).not.toBe("");
				expect(stagedAtStart(out, "docker-buildx")).not.toBe("");
				expect(received(out, "docker-buildx").get("API_TOKEN")).toBe("abc123");
				expect(stagedIn(stagedDir())).toEqual([]);
			},
		);

		itWithSh("the loader removes the file only when asked to consume it", () => {
			const { bin } = installFakeTools(0);
			const cases: Array<[string, { consume?: boolean } | undefined, boolean]> =
				[
					["default", undefined, true],
					["consume", { consume: true }, false],
					["keep", { consume: false }, true],
				];
			for (const [label, options, existsAfter] of cases) {
				const file = `${tmp}/envfile-${label}`;
				writeFileSync(file, buildEnvFileContent([["API_TOKEN", "abc123"]]));

				const result = run(
					`${getEnvFileLoader(file, options)} sh -c 'test "$API_TOKEN" = abc123'`,
					bin,
				);

				expect(result.status, label).toBe(0);
				expect(existsSync(file), label).toBe(existsAfter);
			}
		});
	});


	itWithSh("loads and removes a staged file whose path has a space", () => {
		const { bin, out } = installFakeTools(0);
		const directory = `${tmp}/dir with space`;
		mkdirSync(directory, { recursive: true });
		const file = `${directory}/.dokploy-stage-build-env-dep-space`;
		writeFileSync(file, buildEnvFileContent([["API_TOKEN", "abc123"]]));
		const envFile = getBuildEnvFile(file);

		const result = run(`${envFile.loader}docker build; ${envFile.cleanup}`, bin);

		expect(result.status).toBe(0);
		expect(received(out, "docker-build").get("API_TOKEN")).toBe("abc123");
		expect(existsSync(file)).toBe(false);
	});

	itWithSh("removes the staged env when the build context is missing", async () => {
		const { bin } = installFakeTools(0);
		rmSync(`${tmp}/applications/build-app/code`, { recursive: true });
		const script = await getDockerCommand(
			createApplication({ buildArgs: "NPM_TOKEN=abc" }),
			{ deploymentId: "dep-ctx" },
		);

		const result = run(script, bin);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("does not exist");
		expect(stagedIn(stagedDir())).toEqual([]);
	});

	itWithSh(
		"fails the build instead of running the tool without its env",
		async () => {
			const { bin, out } = installFakeTools(0);
			const script = await getNixpacksCommand(
				createApplication({ buildType: "nixpacks", env: "API_TOKEN=abc123" }),
				{ deploymentId: "dep-missing" },
			);
			// Something removed the staged file between staging and use.
			rmSync(`${stagedDir()}/.dokploy-stage-build-env-dep-missing`);

			const result = run(script, bin);

			expect(result.status).toBe(1);
			expect(existsSync(`${out}/nixpacks.env.bin`)).toBe(false);
		},
	);

	itWithSh("a sourced PATH cannot redirect the tool", async () => {
		const { bin, out } = installFakeTools(0);
		const evil = `${tmp}/evil`;
		mkdirSync(evil, { recursive: true });
		writeFileSync(`${evil}/docker`, `#!/bin/sh\ntouch ${tmp}/pwned\n`);
		chmodSync(`${evil}/docker`, 0o755);
		const file = `${tmp}/envfile`;
		writeFileSync(file, buildEnvFileContent([["PATH", evil]]));

		const result = run(`${getEnvFileLoader(file)} docker build`, bin);

		expect(result.status).toBe(0);
		expect(existsSync(`${tmp}/pwned`)).toBe(false);
		expect(existsSync(`${out}/docker-build.env.bin`)).toBe(true);
	});

	itWithSh(
		"writes the application .env from its staged file, values intact",
		async () => {
			const { bin } = installFakeTools(0);
			const script = await getDockerCommand(
				createApplication({
					createEnvFile: true,
					env: trickyText,
				}),
				{ deploymentId: "dep-dotenv" },
			);
			expect(script).not.toContain("hunter2");

			const result = run(script, bin);

			expect(result.status).toBe(0);
			const written = readFileSync(
				`${tmp}/applications/build-app/code/.env`,
				"utf8",
			);
			expect(written).toBe(
				getAppEnvFileContent(trickyText),
			);
			expect(written).toContain("T_QUOTES=it's a");
			expect(stagedIn(stagedDir())).toEqual([]);
		},
	);

	itWithSh("writes an empty .env when the env is empty", async () => {
		const { bin } = installFakeTools(0);
		const script = await getDockerCommand(
			createApplication({ createEnvFile: true, env: null }),
			{ deploymentId: "dep-empty" },
		);

		const result = run(script, bin);

		expect(result.status).toBe(0);
		expect(readFileSync(`${tmp}/applications/build-app/code/.env`, "utf8")).toBe("");
	});
});
