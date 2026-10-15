import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { quote } from "shell-quote";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

// A single argument to `sh -c` is capped at 128 KB (MAX_ARG_STRLEN) on Linux,
// and the deploy scripts travel as exactly one such argument (ssh2 `exec`, or
// node `exec`/`spawn` with a shell). The expanded compose must therefore never
// be embedded in a script: it is staged through SFTP / fs and the script only
// references the staged file.
const MAX_ARG_STRLEN = 128 * 1024;

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	findServerById: vi.fn(),
	findRegistryByIdWithCredentials: vi.fn(),
	loginDockerRegistry: vi.fn(),
	generateApplyPatchesCommand: vi.fn(),
	localBase: { path: "" },
}));

// Same layout as every other test: forward slashes whatever OS runs the suite.
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
vi.mock("@dokploy/server/utils/providers/raw", () => ({
	getCreateComposeFileCommand: () => "echo write-raw-source;",
}));
vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: mocks.generateApplyPatchesCommand,
}));

import { prepareComposeBuildServerDeploy } from "@dokploy/server/services/compose-build-server";
import { getBuildComposeCommand } from "@dokploy/server/utils/builders/compose";
import {
	getComposePath,
	getInstallStagedComposeCommand,
	getStagedComposePath,
	writeDomainsToCompose,
} from "@dokploy/server/utils/docker/domain";

/**
 * A raw compose whose expanded form is far past the argv limit: many services,
 * each with a long, distinct environment (distinct so YAML never aliases it).
 */
const SERVICES = 60;
const buildBigComposeFile = () => {
	const lines = ["services:"];
	for (let s = 0; s < SERVICES; s++) {
		lines.push(`  svc-${s}:`, "    image: nginx:1.27", "    environment:");
		for (let e = 0; e < 40; e++) {
			lines.push(`      VAR_${s}_${e}: ${"x".repeat(60)}-${s}-${e}`);
		}
	}
	return `${lines.join("\n")}\n`;
};
const bigComposeFile = buildBigComposeFile();

const baseCompose = {
	appName: "big-app",
	composeId: "c1",
	sourceType: "raw",
	composeFile: bigComposeFile,
	command: "",
	composePath: "docker-compose.yml",
	composeType: "docker-compose",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: null,
	env: "",
	mounts: [],
	createEnvFile: false,
	domains: [
		{
			host: "big.example.com",
			serviceName: "svc-0",
			https: false,
			uniqueConfigKey: 1,
			port: 3000,
			enabled: true,
		},
	],
	environment: { project: { env: "" }, env: "" },
} as any;

const STAGED_NAME = /^\.dokploy-compose-[A-Za-z0-9_-]+\.yml$/;

let tmp = "";
beforeEach(() => {
	vi.clearAllMocks();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = mkdtempSync(`${tmpdir()}/dokploy-argv-`).replaceAll("\\", "/");
	mocks.localBase.path = `${tmp}/compose`;
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.writeFileRemote.mockResolvedValue(undefined);
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const base64Of = (text: string) => Buffer.from(text, "utf8").toString("base64");
const stagedFilesIn = (directory: string) =>
	readdirSync(directory).filter((name) => STAGED_NAME.test(name));

describe("the test compose is past the argv limit", () => {
	it("expands to more than 128 KB of YAML", async () => {
		const snippet = await writeDomainsToCompose(
			{ ...baseCompose, serverId: "srv-1" },
			baseCompose.domains,
			{ deploymentId: "dep-size" },
		);
		const staged = mocks.writeFileRemote.mock.calls[0]![2] as string;
		expect(Buffer.byteLength(staged)).toBeGreaterThan(MAX_ARG_STRLEN);
		expect(Buffer.byteLength(base64Of(staged))).toBeGreaterThan(MAX_ARG_STRLEN);
		expect(snippet.length).toBeLessThan(1024);
	});
});

describe("writeDomainsToCompose on a remote host", () => {
	it("stages the compose over SFTP and keeps it out of every command", async () => {
		const compose = { ...baseCompose, serverId: "srv-1" };
		const snippet = await writeDomainsToCompose(compose, compose.domains, {
			deploymentId: "dep-1",
		});

		const stagedPath =
			"/etc/dokploy/compose/big-app/.dokploy-compose-dep-1.yml";
		expect(mocks.writeFileRemote).toHaveBeenCalledTimes(1);
		const [serverId, path, content] = mocks.writeFileRemote.mock.calls[0]!;
		expect(serverId).toBe("srv-1");
		expect(path).toBe(stagedPath);
		// The staged file is the full expanded compose, labels included.
		const parsed = parse(content as string);
		expect(Object.keys(parsed.services)).toHaveLength(SERVICES);
		expect(parsed.services["svc-0"].labels).toContain("traefik.enable=true");
		expect(parsed.services["svc-59"].environment.VAR_59_39).toContain("-59-39");

		const commands = [
			snippet,
			...mocks.execAsyncRemote.mock.calls.map((call) => call[1] as string),
		];
		for (const command of commands) {
			expect(command.length).toBeLessThan(4096);
			expect(command).not.toContain("base64");
			expect(command).not.toContain("services:");
			expect(command).not.toContain(base64Of("services:").slice(0, 12));
		}
		// The directory is created and the file pre-created 0600 before SFTP fills it.
		const prepare = mocks.execAsyncRemote.mock.calls[0]![1] as string;
		expect(prepare).toContain("mkdir -p /etc/dokploy/compose/big-app");
		expect(prepare).toContain("umask 077");
		expect(prepare).toContain(stagedPath);
		// The snippet only moves the staged file into place, and cleans up after itself.
		expect(snippet).toContain(`cat ${stagedPath} > ${getComposePath(compose)}`);
		expect(snippet).toContain(`rm -f ${stagedPath}`);
	});

	it("uses a fresh staged path for a deployment without an id", async () => {
		const compose = { ...baseCompose, serverId: "srv-1" };
		await writeDomainsToCompose(compose, compose.domains);
		await writeDomainsToCompose(compose, compose.domains);
		const [first, second] = mocks.writeFileRemote.mock.calls.map(
			(call) => call[1] as string,
		);
		expect(first).toMatch(/\/\.dokploy-compose-[0-9a-f-]{36}\.yml$/);
		expect(first).not.toBe(second);
	});

	it("never lets a user controlled appName or composePath break out of the snippet", async () => {
		const compose = {
			...baseCompose,
			serverId: "srv-1",
			appName: "app; touch /tmp/pwned",
			composeFile: "services:\n  web:\n    image: nginx\n",
		};
		const snippet = await writeDomainsToCompose(compose, [], {
			deploymentId: "dep 1; reboot",
		});
		// Both paths come back as single shell words.
		expect(snippet).toContain(
			"'/etc/dokploy/compose/app; touch /tmp/pwned/code/docker-compose.yml'",
		);
		expect(getStagedComposePath(compose, "dep 1; reboot")).toMatch(
			/\.dokploy-compose-dep1reboot\.yml$/,
		);
	});

	it("removes the half-created staged file and rethrows when the upload fails", async () => {
		mocks.writeFileRemote.mockRejectedValue(new Error("sftp down"));
		await expect(
			writeDomainsToCompose(
				{ ...baseCompose, serverId: "srv-1" },
				baseCompose.domains,
				{ deploymentId: "dep-1" },
			),
		).rejects.toThrow("sftp down");
		const last = mocks.execAsyncRemote.mock.calls.at(-1)![1] as string;
		expect(last).toBe(
			"rm -f /etc/dokploy/compose/big-app/.dokploy-compose-dep-1.yml",
		);
	});

	it("still reports a missing compose file or a bad domain without staging anything", async () => {
		const missing = await writeDomainsToCompose(
			{
				...baseCompose,
				serverId: "srv-1",
				composeFile: "",
			},
			[],
			{ deploymentId: "dep-1" },
		);
		const badDomain = await writeDomainsToCompose(
			{ ...baseCompose, serverId: "srv-1" },
			[{ ...baseCompose.domains[0], serviceName: "$(touch /tmp/pwned)" }],
			{ deploymentId: "dep-1" },
		);
		expect(missing).toContain("Compose file not found");
		expect(missing).toContain("exit 1");
		expect(badDomain).toContain("Has occurred an error");
		expect(badDomain).toContain("exit 1");
		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});

describe("serving-host deploy script", () => {
	const baseOptions = { deploymentId: "dep-9" };

	it("stays far below the argv limit on a remote server", async () => {
		const command = await getBuildComposeCommand(
			{ ...baseCompose, serverId: "srv-1" },
			baseOptions,
		);
		const staged = mocks.writeFileRemote.mock.calls[0]![2] as string;

		expect(Buffer.byteLength(staged)).toBeGreaterThan(MAX_ARG_STRLEN);
		expect(Buffer.byteLength(command)).toBeLessThan(MAX_ARG_STRLEN / 8);
		expect(command).not.toContain("base64");
		expect(command).not.toContain("svc-59");
		// `cat staged > compose` runs where the old `echo | base64 -d` ran: after
		// the banner and before the docker command.
		const install = command.indexOf(
			"cat /etc/dokploy/compose/big-app/.dokploy-compose-dep-9.yml > /etc/dokploy/compose/big-app/code/docker-compose.yml",
		);
		expect(install).toBeGreaterThan(-1);
		expect(install).toBeLessThan(
			command.indexOf('env -i PATH="$PATH" HOME="$HOME"'),
		);
		expect(mocks.writeFileRemote).toHaveBeenCalledWith(
			"srv-1",
			"/etc/dokploy/compose/big-app/.dokploy-compose-dep-9.yml",
			staged,
		);
		for (const call of mocks.execAsyncRemote.mock.calls) {
			expect(Buffer.byteLength(call[1] as string)).toBeLessThan(4096);
		}
	});

	it("stays far below the argv limit on the local host and stages through fs", async () => {
		mkdirSync(`${tmp}/compose/big-app`, { recursive: true });
		const command = await getBuildComposeCommand(baseCompose, baseOptions);

		expect(Buffer.byteLength(command)).toBeLessThan(MAX_ARG_STRLEN / 8);
		expect(command).not.toContain("base64");
		expect(command).not.toContain("svc-59");
		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();

		const stagedPath = `${tmp}/compose/big-app/.dokploy-compose-dep-9.yml`;
		expect(command).toContain(
			`cat ${quote([stagedPath])} > ${quote([`${tmp}/compose/big-app/code/docker-compose.yml`])}`,
		);
		const staged = readFileSync(stagedPath, "utf8");
		expect(Buffer.byteLength(staged)).toBeGreaterThan(MAX_ARG_STRLEN);
		expect(Object.keys(parse(staged).services)).toHaveLength(SERVICES);
		if (process.platform !== "win32") {
			expect(statSync(stagedPath).mode & 0o777).toBe(0o600);
		}
	});

	it("removes staged files older than an hour and leaves recent ones alone", async () => {
		const dir = `${tmp}/compose/big-app`;
		mkdirSync(dir, { recursive: true });
		const stale = `${dir}/.dokploy-compose-old.yml`;
		const recent = `${dir}/.dokploy-compose-recent.yml`;
		const unrelated = `${dir}/docker-compose.yml.keep`;
		for (const file of [stale, recent, unrelated]) writeFileSync(file, "x");
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		utimesSync(stale, twoHoursAgo, twoHoursAgo);
		utimesSync(unrelated, twoHoursAgo, twoHoursAgo);

		await writeDomainsToCompose(baseCompose, baseCompose.domains, {
			deploymentId: "dep-new",
		});

		expect(existsSync(stale)).toBe(false);
		expect(existsSync(recent)).toBe(true);
		expect(existsSync(unrelated)).toBe(true);
		expect(existsSync(`${dir}/.dokploy-compose-dep-new.yml`)).toBe(true);
	});
});

describe("build-server handoff", () => {
	const buildServer = {
		serverId: "build-1",
		name: "builder",
		ipAddress: "10.0.0.9",
		serverType: "build",
		organizationId: "org-1",
	};
	const registry = {
		registryId: "reg-1",
		registryName: "main",
		registryUrl: "reg.example.com",
		username: "acme",
		organizationId: "org-1",
	};

	it("stages the compose on the build server instead of passing it to `run`", async () => {
		mocks.findServerById.mockResolvedValue(buildServer);
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(registry);
		mocks.loginDockerRegistry.mockResolvedValue(undefined);
		mocks.generateApplyPatchesCommand.mockResolvedValue("");
		const runStep = vi.fn().mockResolvedValue(undefined);

		const entity = {
			...baseCompose,
			buildServerId: "build-1",
			buildRegistryId: "reg-1",
			server: { name: "prod-1" },
		};
		// No service builds: the handoff ends right after `compose config`.
		mocks.execAsyncRemote.mockImplementation(
			async (_serverId: string, command: string) => ({
				stdout: command.includes("config --format json")
					? JSON.stringify({
							name: "big-app",
							services: { web: { image: "nginx" } },
						})
					: "",
				stderr: "",
			}),
		);

		await prepareComposeBuildServerDeploy({
			entity,
			deployment: { logPath: "/tmp/log", deploymentId: "dep-7" },
			runStep,
		});

		const staged = mocks.writeFileRemote.mock.calls.find(
			(call) => call[0] === "build-1",
		);
		expect(staged).toBeDefined();
		expect(staged![1]).toBe(
			"/etc/dokploy/compose/big-app/.dokploy-compose-dep-7.yml",
		);
		expect(Buffer.byteLength(staged![2] as string)).toBeGreaterThan(
			MAX_ARG_STRLEN,
		);
		expect(Object.keys(parse(staged![2] as string).services)).toHaveLength(
			SERVICES,
		);

		const commands = mocks.execAsyncRemote.mock.calls.map(
			(call) => call[1] as string,
		);
		expect(commands.length).toBeGreaterThan(0);
		for (const command of commands) {
			expect(Buffer.byteLength(command)).toBeLessThan(MAX_ARG_STRLEN / 8);
			expect(command).not.toContain("svc-59");
			expect(command).not.toContain("base64 -d > /etc/dokploy/compose");
		}
		const install = commands.find((command) =>
			command.includes(
				"cat /etc/dokploy/compose/big-app/.dokploy-compose-dep-7.yml > /etc/dokploy/compose/big-app/code/docker-compose.yml",
			),
		);
		expect(install).toBeDefined();
		// Installed before `compose config` reads it, then nothing else uses it.
		const installIndex = commands.indexOf(install!);
		const configIndex = commands.findIndex((command) =>
			command.includes("config --format json"),
		);
		expect(installIndex).toBeLessThan(configIndex);
		// The only step left for the serving host is dropping a stale override.
		for (const [step] of runStep.mock.calls) {
			expect(Buffer.byteLength(step as string)).toBeLessThan(1024);
		}
	});
});

// Runs the generated snippet in a real shell, as the deploy script does.
const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;
const itWithSh = hasSh ? it : it.skip;
describe("installing the staged compose with a real shell", () => {
	const run = (script: string) =>
		spawnSync("sh", ["-c", script], { encoding: "utf8" });

	itWithSh(
		"puts the compose in place byte for byte and removes the staged file",
		async () => {
			const codeDir = `${tmp}/compose/big-app/code`;
			mkdirSync(codeDir, { recursive: true });
			writeFileSync(`${codeDir}/docker-compose.yml`, "old: true\n");

			const snippet = await writeDomainsToCompose(
				baseCompose,
				baseCompose.domains,
				{ deploymentId: "dep-sh" },
			);
			const stagedPath = `${tmp}/compose/big-app/.dokploy-compose-dep-sh.yml`;
			const staged = readFileSync(stagedPath, "utf8");
			expect(Buffer.byteLength(staged)).toBeGreaterThan(MAX_ARG_STRLEN);

			const result = run(`set -e\n{ ${snippet}
echo installed; }`);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("installed");
			expect(readFileSync(`${codeDir}/docker-compose.yml`, "utf8")).toBe(
				staged,
			);
			expect(existsSync(stagedPath)).toBe(false);
			expect(stagedFilesIn(`${tmp}/compose/big-app`)).toEqual([]);
		},
	);

	itWithSh(
		"removes the staged file and stops the script when the compose cannot be written",
		async () => {
			// The code directory does not exist, so the copy fails.
			mkdirSync(`${tmp}/compose/big-app`, { recursive: true });
			const snippet = await writeDomainsToCompose(
				baseCompose,
				baseCompose.domains,
				{ deploymentId: "dep-fail" },
			);
			expect(stagedFilesIn(`${tmp}/compose/big-app`)).toHaveLength(1);

			const result = run(`set -e\n{ ${snippet}
echo should-not-run; }`);

			expect(result.status).toBe(1);
			expect(result.stdout).toContain("Could not write the compose file");
			expect(result.stdout).not.toContain("should-not-run");
			expect(stagedFilesIn(`${tmp}/compose/big-app`)).toEqual([]);
		},
	);

	itWithSh(
		"survives a clone that wipes the code directory between staging and install",
		async () => {
			const codeDir = `${tmp}/compose/big-app/code`;
			mkdirSync(codeDir, { recursive: true });
			const snippet = await writeDomainsToCompose(
				baseCompose,
				baseCompose.domains,
				{ deploymentId: "dep-clone" },
			);
			const staged = readFileSync(
				`${tmp}/compose/big-app/.dokploy-compose-dep-clone.yml`,
				"utf8",
			);

			// What every clone command starts with.
			const result = run(
				`set -e\nrm -rf '${codeDir}'; mkdir -p '${codeDir}';\n{ ${snippet} }`,
			);

			expect(result.status).toBe(0);
			expect(readFileSync(`${codeDir}/docker-compose.yml`, "utf8")).toBe(
				staged,
			);
			expect(stagedFilesIn(`${tmp}/compose/big-app`)).toEqual([]);
		},
	);

	itWithSh("quotes odd paths as single words", () => {
		const dir = `${tmp}/odd dir`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${dir}/staged one.yml`, "a: 1\n");
		const result = run(
			getInstallStagedComposeCommand(
				`${dir}/staged one.yml`,
				`${dir}/target $(echo pwned).yml`,
			),
		);
		expect(result.status).toBe(0);
		expect(readFileSync(`${dir}/target $(echo pwned).yml`, "utf8")).toBe(
			"a: 1\n",
		);
		expect(existsSync(`${dir}/staged one.yml`)).toBe(false);
	});
});
