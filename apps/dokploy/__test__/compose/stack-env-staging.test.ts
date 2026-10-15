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

// A stack's environment used to be exported on the docker line of the deploy
// script (`env -i PATH=.. HOME=.. KEY='value' docker stack deploy ..`): it was
// repeated in every command that needs it, counted toward the 128 KB limit on
// one shell argument, and showed in `ps`. It is now staged once as a 0600 file
// and sourced by the shell that runs docker, so no value is on any command line.
const MAX_ARG_STRLEN = 128 * 1024;

vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	findServerById: vi.fn(),
	findRegistryByIdWithCredentials: vi.fn(),
	loginDockerRegistry: vi.fn(),
	generateApplyPatchesCommand: vi.fn(),
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
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
}));
vi.mock("@dokploy/server/services/registry", () => ({
	findRegistryByIdWithCredentials: mocks.findRegistryByIdWithCredentials,
}));
vi.mock("@dokploy/server/utils/cluster/upload", () => ({
	loginDockerRegistry: mocks.loginDockerRegistry,
	getRegistryTag: (
		registry: { registryUrl: string; username: string },
		image: string,
	) => `${registry.registryUrl}/${registry.username}/${image}`,
}));
vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: mocks.generateApplyPatchesCommand,
}));

import { prepareComposeBuildServerDeploy } from "@dokploy/server/services/compose-build-server";
import {
	buildStackEnvFileContent,
	getBuildComposeCommand,
	getCleanEnvPrefix,
	getStackEnvFileContent,
	stageStackEnvFile,
} from "@dokploy/server/utils/builders/compose";
import {
	getComposeBuildCommand,
	getComposeConfigJsonCommand,
} from "@dokploy/server/utils/builders/compose-remote-build";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Distinct, secret looking `KEY=value` lines of roughly `kb` KB. */
const bigEnv = (kb: number) => {
	const lines: string[] = [];
	let size = 0;
	for (let i = 0; size < kb * 1024; i++) {
		const line = `BIGSECRET_${i}=hunter2-${i}-${"x".repeat(48)}`;
		lines.push(line);
		size += line.length + 1;
	}
	return lines.join("\n");
};

// Quotes, `$`, backticks, a command substitution and backslashes.
const TRICKY: Record<string, string> = {
	T_QUOTES: `it's a "test" with 'single' and "double" quotes`,
	T_DOLLAR: "$HOME ${PATH} $(echo pwned) `echo pwned` $$ $1",
	T_BACKSLASH: "back\\slash \\n literal \\\\ end\\",
	T_BANG: "a!b \\! !!",
	T_EQUALS: "a=b=c",
	T_UNICODE: "héllo ✅ 日本語",
};
const trickyEnvText = Object.entries(TRICKY)
	.map(([key, value]) => `${key}=${value}`)
	.join("\n");

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
	tmp = mkdtempSync(`${tmpdir()}/dokploy-stack-env-`).replaceAll("\\", "/");
	mocks.localBase.path = `${tmp}/compose`;
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.writeFileRemote.mockResolvedValue(undefined);
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const remoteCommands = () =>
	mocks.execAsyncRemote.mock.calls.map((call) => call[1] as string);

describe("stack env file content", () => {
	it("is empty for a compose that is not a stack", () => {
		expect(
			getStackEnvFileContent({
				...baseStack,
				composeType: "docker-compose",
				env: "A=1",
			}),
		).toBe("");
	});

	it("is empty for a stack without variables", () => {
		expect(getStackEnvFileContent(baseStack)).toBe("");
	});

	it("carries service, environment and project variables", () => {
		const content = getStackEnvFileContent({
			...baseStack,
			env: "A=1\nB=${{environment.E}}",
			environment: { project: { env: "P=p" }, env: "E=e" },
		});
		expect(content).toContain("A='1'\n");
		expect(content).toContain("B='e'\n");
	});

	it("leaves out names that are not shell identifiers", () => {
		const content = buildStackEnvFileContent({
			GOOD_1: "ok",
			"BAD-NAME": "x",
			"1BAD": "x",
			"EVIL;touch pwned": "x",
		});
		expect(content).toBe("GOOD_1='ok'\n");
	});

	it("single-quotes every value, whatever it holds", () => {
		expect(buildStackEnvFileContent({ A: "it's" })).toBe("A='it'\\''s'\n");
		expect(buildStackEnvFileContent({ A: "$(x) `y`\nz" })).toBe(
			"A='$(x) `y`\nz'\n",
		);
	});
});

describe("getCleanEnvPrefix", () => {
	it("is the unchanged env -i prefix without a stack env", () => {
		expect(getCleanEnvPrefix()).toBe('env -i PATH="$PATH" HOME="$HOME" ');
	});

	it("loads the staged file and puts no value on the command line", () => {
		const prefix = getCleanEnvPrefix("/etc/dokploy/compose/app/.dokploy-x");
		expect(prefix).toBe(
			`env -i PATH="$PATH" HOME="$HOME" sh -c 'set -a; . "$1" || exit 1; set +a; shift; exec "$@"' sh /etc/dokploy/compose/app/.dokploy-x`,
		);
	});

	it("shell-quotes the path", () => {
		const odd = "/tmp/a b/$(touch pwned)";
		expect(getCleanEnvPrefix(odd)).toMatch(
			new RegExp(`' sh ${quote([odd]).replace(/[$()]/g, "\\$&")}$`),
		);
	});
});

describe("stackEnvFile staging", () => {
	it("stages nothing when there is nothing to stage", async () => {
		const onStaged = vi.fn();
		expect(
			await stageStackEnvFile(
				{ ...baseStack, serverId: "srv-1" },
				{ deploymentId: "d", onStaged },
			),
		).toBeUndefined();
		expect(
			await stageStackEnvFile(
				{ ...baseStack, composeType: "docker-compose", env: "A=1" },
				{ deploymentId: "d", onStaged },
			),
		).toBeUndefined();
		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
		expect(onStaged).not.toHaveBeenCalled();
	});

	it("stages the env over SFTP, 0600, next to the compose directory", async () => {
		const onStaged = vi.fn();
		const path = await stageStackEnvFile(
			{ ...baseStack, serverId: "srv-1", env: "A=1" },
			{ deploymentId: "dep-1", onStaged },
		);

		expect(path).toBe(
			"/etc/dokploy/compose/stack-app/.dokploy-stage-stack-env-dep-1",
		);
		expect(mocks.writeFileRemote).toHaveBeenCalledWith(
			"srv-1",
			path,
			"A='1'\n",
		);
		expect(onStaged).toHaveBeenCalledWith([path]);
		const prepare = remoteCommands()[0]!;
		expect(prepare.indexOf("umask 077")).toBeGreaterThan(-1);
		expect(prepare.indexOf("umask 077")).toBeLessThan(prepare.indexOf(path!));
	});

	it("stages through fs, 0600, on the local host", async () => {
		const path = await stageStackEnvFile(
			{ ...baseStack, env: "A=1" },
			{ deploymentId: "dep-1" },
		);
		expect(path).toBe(
			`${tmp}/compose/stack-app/.dokploy-stage-stack-env-dep-1`,
		);
		expect(readFileSync(path!, "utf8")).toBe("A='1'\n");
		if (process.platform !== "win32") {
			expect(statSync(path!).mode & 0o777).toBe(0o600);
		}
	});
});

describe("stack deploy script", () => {
	const secretEnv = bigEnv(60);

	it("is past the old limit: the exported env alone is about 60 KB per use", () => {
		expect(bytes(secretEnv)).toBeGreaterThan(60 * 1024);
	});

	it("stages the env once and keeps every value out of the script", async () => {
		const compose = { ...baseStack, serverId: "srv-1", env: secretEnv };
		const command = await getBuildComposeCommand(compose, {
			deploymentId: "dep-1",
		});

		const stagedPath =
			"/etc/dokploy/compose/stack-app/.dokploy-stage-stack-env-dep-1";
		const stackWrites = mocks.writeFileRemote.mock.calls.filter(
			(call) => call[1] === stagedPath,
		);
		expect(stackWrites).toHaveLength(1);
		expect(stackWrites[0]![0]).toBe("srv-1");
		expect(bytes(stackWrites[0]![2] as string)).toBeGreaterThan(60 * 1024);

		expect(bytes(command)).toBeLessThan(MAX_ARG_STRLEN / 8);
		expect(command).not.toContain("hunter2");
		expect(command).not.toContain("BIGSECRET");
		for (const remote of remoteCommands()) {
			expect(remote).not.toContain("hunter2");
		}
		// The docker line loads the staged file; nothing is exported on it.
		expect(command).toContain(
			`env -i PATH="$PATH" HOME="$HOME" sh -c 'set -a; . "$1" || exit 1; set +a; shift; exec "$@"' sh ${stagedPath} docker stack deploy -c docker-compose.yml stack-app --prune --with-registry-auth 2>&1`,
		);
		// 0600 before it holds the secrets.
		const prepare = remoteCommands()[0]!;
		expect(prepare.indexOf("umask 077")).toBeLessThan(
			prepare.indexOf(stagedPath),
		);
	});

	it("removes the staged env after a successful deploy and when it fails", async () => {
		const command = await getBuildComposeCommand(
			{ ...baseStack, serverId: "srv-1", env: "A=1" },
			{ deploymentId: "dep-1" },
		);
		const stagedPath =
			"/etc/dokploy/compose/stack-app/.dokploy-stage-stack-env-dep-1";
		const up = command.indexOf("stack deploy");
		const failure = command.indexOf("Docker command failed", up);
		const afterFailure = command.indexOf("exit 1; }", failure);
		const failureBlock = command.slice(failure, afterFailure);
		expect(failureBlock).toContain(`rm -f ${stagedPath};`);
		const successBlock = command.slice(
			afterFailure,
			command.indexOf("Docker Compose Deployed"),
		);
		expect(successBlock).toContain(`rm -f ${stagedPath};`);
	});

	it("removes the staged env too when the .env or the compose step stops the script", async () => {
		const command = await getBuildComposeCommand(
			{ ...baseStack, serverId: "srv-1", env: "A=1", createEnvFile: true },
			{ deploymentId: "dep-1" },
		);
		const stackEnv =
			"/etc/dokploy/compose/stack-app/.dokploy-stage-stack-env-dep-1";
		const envFailure = command.match(
			/\{ rm -f (\S+)([^;]*); echo "❌ Error: Could not write the environment file"/,
		);
		expect(envFailure).not.toBeNull();
		expect(envFailure![0]).toContain(stackEnv);
	});

	it("removes what it staged when a later staging step fails", async () => {
		// The stack env is written first, the .env second.
		mocks.writeFileRemote
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("sftp down"));
		await expect(
			getBuildComposeCommand(
				{ ...baseStack, serverId: "srv-1", env: "A=1", createEnvFile: true },
				{ deploymentId: "dep-1" },
			),
		).rejects.toThrow("sftp down");
		expect(remoteCommands().at(-1)).toBe(
			"rm -f /etc/dokploy/compose/stack-app/.dokploy-stage-stack-env-dep-1",
		);
	});

	it("is byte for byte the script it always was for a stack without variables", async () => {
		const command = await getBuildComposeCommand(
			{ ...baseStack, serverId: "srv-1" },
			{ deploymentId: "dep-1" },
		);
		expect(command).toContain(
			'env -i PATH="$PATH" HOME="$HOME"  docker stack deploy',
		);
		expect(command).not.toContain(".dokploy-stage-stack-env");
		expect(mocks.writeFileRemote).not.toHaveBeenCalledWith(
			"srv-1",
			expect.stringContaining("stack-env"),
			expect.anything(),
		);
	});

	it("does not stage an env for docker compose", async () => {
		const command = await getBuildComposeCommand(
			{ ...baseStack, composeType: "docker-compose", env: "A=1" },
			{ deploymentId: "dep-1" },
		);
		expect(command).toContain(
			'env -i PATH="$PATH" HOME="$HOME"  docker compose',
		);
		expect(command).not.toContain(".dokploy-stage-stack-env");
	});
});

describe("stack env on the build server", () => {
	it("loads the staged env in the config and build commands", () => {
		const compose = { ...baseStack, env: "A=1" };
		const file = "/etc/dokploy/compose/stack-app/.dokploy-stage-stack-env-d";
		for (const command of [
			getComposeConfigJsonCommand(compose, "/code", undefined, file),
			getComposeBuildCommand(compose, "/code", undefined, file),
		]) {
			expect(command).toContain(
				`env -i PATH="$PATH" HOME="$HOME" sh -c 'set -a; . "$1" || exit 1; set +a; shift; exec "$@"' sh ${file} docker compose`,
			);
			expect(command).not.toContain("A=");
		}
	});

	it("stages the env on the build server, uses it for config, and removes it afterwards", async () => {
		mocks.findServerById.mockResolvedValue({
			serverId: "build-1",
			name: "builder",
			ipAddress: "10.0.0.9",
			serverType: "build",
			organizationId: "org-1",
		});
		mocks.findRegistryByIdWithCredentials.mockResolvedValue({
			registryId: "reg-1",
			registryName: "main",
			registryUrl: "reg.example.com",
			username: "acme",
			organizationId: "org-1",
		});
		mocks.loginDockerRegistry.mockResolvedValue(undefined);
		mocks.generateApplyPatchesCommand.mockResolvedValue("");
		mocks.execAsyncRemote.mockImplementation(
			async (_serverId: string, command: string) => ({
				stdout: command.includes("config --format json")
					? JSON.stringify({
							name: "stack-app",
							services: { web: { image: "nginx" } },
						})
					: "",
				stderr: "",
			}),
		);

		await prepareComposeBuildServerDeploy({
			entity: {
				...baseStack,
				env: bigEnv(60),
				buildServerId: "build-1",
				buildRegistryId: "reg-1",
				server: { name: "prod-1" },
			},
			deployment: { logPath: "/tmp/log", deploymentId: "dep-7" },
			runStep: vi.fn().mockResolvedValue(undefined),
		});

		const stagedPath =
			"/etc/dokploy/compose/stack-app/.dokploy-stage-stack-env-dep-7";
		const writes = mocks.writeFileRemote.mock.calls.filter(
			(call) => call[1] === stagedPath,
		);
		expect(writes).toHaveLength(1);
		expect(writes[0]![0]).toBe("build-1");

		const commands = remoteCommands();
		const config = commands.find((command) =>
			command.includes("config --format json"),
		)!;
		expect(config).toContain(`sh ${stagedPath} docker compose`);
		for (const command of commands) {
			expect(command).not.toContain("hunter2");
			expect(bytes(command)).toBeLessThan(MAX_ARG_STRLEN / 8);
		}
		// Removed once the build is done, with nothing else after it.
		expect(commands.at(-1)).toBe(`rm -f ${stagedPath}`);
	});

	it("removes the staged env when the build fails", async () => {
		mocks.findServerById.mockResolvedValue({
			serverId: "build-1",
			name: "builder",
			ipAddress: "10.0.0.9",
			serverType: "build",
			organizationId: "org-1",
		});
		mocks.findRegistryByIdWithCredentials.mockResolvedValue({
			registryId: "reg-1",
			registryName: "main",
			registryUrl: "reg.example.com",
			username: "acme",
			organizationId: "org-1",
		});
		mocks.generateApplyPatchesCommand.mockResolvedValue("");
		mocks.execAsyncRemote.mockImplementation(
			async (_serverId: string, command: string) => {
				if (command.includes("config --format json")) {
					throw new Error("config failed");
				}
				return { stdout: "", stderr: "" };
			},
		);

		await expect(
			prepareComposeBuildServerDeploy({
				entity: {
					...baseStack,
					env: "A=1",
					buildServerId: "build-1",
					buildRegistryId: "reg-1",
					server: { name: "prod-1" },
				},
				deployment: { logPath: "/tmp/log", deploymentId: "dep-8" },
				runStep: vi.fn().mockResolvedValue(undefined),
			}),
		).rejects.toThrow("config failed");
		expect(remoteCommands()).toContain(
			"rm -f /etc/dokploy/compose/stack-app/.dokploy-stage-stack-env-dep-8",
		);
	});
});

// Runs the generated snippets in a real shell, as the deploy script does.
const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;
const itWithSh = hasSh ? it : it.skip;
const stagedIn = (directory: string) =>
	readdirSync(directory).filter((name) => name.startsWith(".dokploy-"));

/** Parses `env -0` output. */
const parseEnv0 = (raw: string) => {
	const vars = new Map<string, string>();
	for (const entry of raw.split("\0")) {
		const at = entry.indexOf("=");
		if (at > 0) vars.set(entry.slice(0, at), entry.slice(at + 1));
	}
	return vars;
};

describe("stack env in a real shell", () => {
	/** A fake docker that records the environment and arguments it was run with. */
	const installFakeDocker = (exitCode: number) => {
		const bin = `${tmp}/bin`;
		const out = `${tmp}/out`;
		mkdirSync(bin, { recursive: true });
		mkdirSync(out, { recursive: true });
		// The deploy script `cd`s into the code directory a clone would have made.
		mkdirSync(`${tmp}/compose/stack-app/code`, { recursive: true });
		writeFileSync(
			`${bin}/docker`,
			`#!/bin/sh\nenv -0 > ${out}/env.bin\nprintf '%s\\n' "$@" > ${out}/args.txt\nexit ${exitCode}\n`,
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
				HOSTLEAK: "from-the-host",
			},
		});

	itWithSh(
		"hands docker every tricky value of a ~60 KB env, intact and exported",
		async () => {
			const env = `${trickyEnvText}\n${bigEnv(60)}`;
			const { bin, out } = installFakeDocker(0);
			const script = await getBuildComposeCommand(
				{ ...baseStack, env },
				{ deploymentId: "dep-sh" },
			);
			expect(bytes(script)).toBeLessThan(MAX_ARG_STRLEN / 8);

			const result = runScript(script, bin);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("Docker Compose Deployed");
			const received = parseEnv0(readFileSync(`${out}/env.bin`, "utf8"));
			for (const [key, value] of Object.entries(TRICKY)) {
				expect(received.get(key)).toBe(value);
			}
			expect(received.get("BIGSECRET_0")).toBe(`hunter2-0-${"x".repeat(48)}`);
			expect(received.get("BIGSECRET_800")).toBe(
				`hunter2-800-${"x".repeat(48)}`,
			);
			// `env -i` still drops everything the host had.
			expect(received.has("HOSTLEAK")).toBe(false);
			// docker's argv carries the command and no value.
			const args = readFileSync(`${out}/args.txt`, "utf8");
			expect(args).toContain("stack\ndeploy\n");
			expect(args).not.toContain("hunter2");
			// Nothing left behind, and nothing was executed from a value.
			expect(stagedIn(`${tmp}/compose/stack-app`)).toEqual([]);
		},
	);

	itWithSh(
		"round-trips a value with newlines through the staged file",
		async () => {
			const values = {
				NL_VALUE: "line1\nline2\n\nit's $(echo pwned) `echo pwned`\nend\n",
				AFTER: "still-fine",
				PADDED: "  padded  ",
			};
			const { bin, out } = installFakeDocker(0);
			mkdirSync(`${tmp}/compose/stack-app`, { recursive: true });
			const file = `${tmp}/compose/stack-app/.dokploy-stage-stack-env-nl`;
			writeFileSync(file, buildStackEnvFileContent(values));

			const result = runScript(
				`${getCleanEnvPrefix(file)} docker stack deploy`,
				bin,
			);

			expect(result.status).toBe(0);
			const received = parseEnv0(readFileSync(`${out}/env.bin`, "utf8"));
			for (const [key, value] of Object.entries(values)) {
				expect(received.get(key)).toBe(value);
			}
			expect(received.has("pwned")).toBe(false);
		},
	);

	itWithSh("removes the staged env when docker fails", async () => {
		const { bin } = installFakeDocker(1);
		const script = await getBuildComposeCommand(
			{ ...baseStack, env: "SECRET_TOKEN=abc" },
			{ deploymentId: "dep-fail" },
		);

		const result = runScript(script, bin);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Docker command failed");
		expect(stagedIn(`${tmp}/compose/stack-app`)).toEqual([]);
		expect(existsSync(`${tmp}/compose/stack-app/code/docker-compose.yml`)).toBe(
			true,
		);
	});

	itWithSh(
		"fails the deploy instead of running docker without its env",
		async () => {
			const { bin, out } = installFakeDocker(0);
			const script = await getBuildComposeCommand(
				{ ...baseStack, env: "SECRET_TOKEN=abc" },
				{ deploymentId: "dep-missing" },
			);
			// Something removed the staged file between staging and use.
			rmSync(`${tmp}/compose/stack-app/.dokploy-stage-stack-env-dep-missing`);

			const result = runScript(script, bin);

			expect(result.status).toBe(1);
			expect(existsSync(`${out}/env.bin`)).toBe(false);
		},
	);
});
