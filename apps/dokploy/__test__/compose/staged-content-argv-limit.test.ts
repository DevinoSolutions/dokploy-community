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
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// A single argument to `sh -c` is capped at 128 KB (MAX_ARG_STRLEN) on Linux,
// and the deploy scripts travel as exactly one such argument (ssh2 `exec`, or
// node `exec` with a shell). Raw compose sources, the compose `.env` and file
// mounts can each be that large (the build-server step even joins every mount
// into one command), so none of them may be embedded in a script: they are
// staged through SFTP / fs and the script only references the staged file.
// (Patches have the same test in staged-patches-argv-limit.test.ts.)
const MAX_ARG_STRLEN = 128 * 1024;

// Spawning a real shell is slow when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	findServerById: vi.fn(),
	findRegistryByIdWithCredentials: vi.fn(),
	loginDockerRegistry: vi.fn(),
	generateApplyPatchesCommand: vi.fn(),
	deploymentStatus: vi.fn(),
	mountRow: vi.fn(),
	localBase: { path: "" },
	statFailsFor: new Set<string>(),
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
				: {
						...actual.paths(true),
						COMPOSE_PATH: `${mocks.localBase.path}/compose`,
						APPLICATIONS_PATH: `${mocks.localBase.path}/applications`,
					},
	};
});
vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	return {
		...actual,
		execAsync: mocks.execAsync,
		execAsyncRemote: mocks.execAsyncRemote,
		writeFileRemote: mocks.writeFileRemote,
	};
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		// The names `statFailsFor` fails on are listed first, whatever order the
		// filesystem lists in, so the test does not depend on it.
		readdir: async (path: string, ...rest: unknown[]) => {
			const names = (await (actual.readdir as (...args: unknown[]) => unknown)(
				path,
				...rest,
			)) as string[];
			const failing = (name: string) =>
				[...mocks.statFailsFor].some((suffix) => name.endsWith(suffix));
			return [...names.filter(failing), ...names.filter((n) => !failing(n))];
		},
		// A concurrent deploy consuming a file between readdir and stat.
		stat: async (path: string, ...rest: unknown[]) => {
			for (const name of mocks.statFailsFor) {
				if (String(path).endsWith(name)) {
					throw Object.assign(new Error("ENOENT: no such file"), {
						code: "ENOENT",
					});
				}
			}
			return (actual.stat as (...args: unknown[]) => unknown)(path, ...rest);
		},
	};
});
vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			deployments: {
				findFirst: (...args: unknown[]) => mocks.deploymentStatus(...args),
			},
			mounts: { findFirst: (...args: unknown[]) => mocks.mountRow(...args) },
		},
	},
}));
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
	createFileMount,
	updateFileMount,
} from "@dokploy/server/services/mount";
import {
	getBuildComposeCommand,
	getCreateEnvFileCommand,
} from "@dokploy/server/utils/builders/compose";
import { writeDomainsToCompose } from "@dokploy/server/utils/docker/domain";
import {
	getInstallStagedFileCommand,
	getStagedFilePath,
	removeStagedFiles,
	stageFiles,
} from "@dokploy/server/utils/docker/staging";
import { getCreateFilesCommand } from "@dokploy/server/utils/docker/utils";
import { ExecError } from "@dokploy/server/utils/process/ExecError";
import { getCreateComposeFileCommand } from "@dokploy/server/utils/providers/raw";

/** Distinct, secret looking text of roughly `kb` KB (distinct so nothing aliases). */
const bigText = (label: string, kb: number) => {
	const lines: string[] = [];
	let size = 0;
	for (let i = 0; size < kb * 1024; i++) {
		const line = `${label}_SECRET_${i}=hunter2-${label}-${i}-${"x".repeat(48)}`;
		lines.push(line);
		size += line.length + 1;
	}
	return `${lines.join("\n")}\n`;
};
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const base64Of = (text: string) => Buffer.from(text, "utf8").toString("base64");

const bigComposeFile = () => {
	const lines = ["services:"];
	for (let s = 0; s < 60; s++) {
		lines.push(`  svc-${s}:`, "    image: nginx:1.27", "    environment:");
		for (let e = 0; e < 40; e++) {
			lines.push(`      VAR_${s}_${e}: ${"y".repeat(60)}-${s}-${e}`);
		}
	}
	return `${lines.join("\n")}\n`;
};

const baseCompose = {
	appName: "big-app",
	composeId: "c1",
	sourceType: "raw",
	composeFile: "services:\n  web:\n    image: nginx\n",
	command: "",
	composePath: "docker-compose.yml",
	composeType: "docker-compose",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: null,
	env: "",
	mounts: [],
	createEnvFile: true,
	domains: [],
	environment: { project: { env: "" }, env: "" },
} as any;

let tmp = "";
beforeEach(() => {
	vi.clearAllMocks();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = mkdtempSync(`${tmpdir()}/dokploy-staged-`).replaceAll("\\", "/");
	mocks.localBase.path = tmp;
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.writeFileRemote.mockResolvedValue(undefined);
	mocks.deploymentStatus.mockResolvedValue({ status: "running" });
	mocks.statFailsFor.clear();
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Every command string that left for a host: nothing may carry content. */
const remoteCommands = () =>
	mocks.execAsyncRemote.mock.calls.map((call) => call[1] as string);
const expectNoContentIn = (commands: string[], contents: string[]) => {
	for (const command of commands) {
		expect(bytes(command)).toBeLessThan(MAX_ARG_STRLEN / 8);
		expect(command).not.toContain("base64");
		for (const content of contents) {
			const sample = content.slice(0, 64);
			expect(command).not.toContain(sample);
			expect(command).not.toContain(base64Of(sample).slice(0, 24));
		}
	}
};

describe("raw compose source (getCreateComposeFileCommand)", () => {
	const source = bigComposeFile();

	it("is past the argv limit, so the old inline form could not run", () => {
		expect(bytes(source)).toBeGreaterThan(MAX_ARG_STRLEN * 0.8);
		expect(bytes(base64Of(source))).toBeGreaterThan(MAX_ARG_STRLEN);
	});

	it("stages the source over SFTP on a remote host and keeps it out of the command", async () => {
		const command = await getCreateComposeFileCommand(
			{ ...baseCompose, composeFile: source, serverId: "srv-1" },
			{ deploymentId: "dep-1" },
		);

		const staged = "/etc/dokploy/compose/big-app/.dokploy-stage-raw-dep-1";
		expect(mocks.writeFileRemote).toHaveBeenCalledTimes(1);
		expect(mocks.writeFileRemote).toHaveBeenCalledWith("srv-1", staged, source);
		expectNoContentIn([command, ...remoteCommands()], [source]);
		// The staged file sits next to code/, which the snippet wipes first.
		expect(staged.startsWith("/etc/dokploy/compose/big-app/.")).toBe(true);
		expect(command).toContain(
			"rm -rf /etc/dokploy/compose/big-app/code && mkdir -p /etc/dokploy/compose/big-app/code && cat ",
		);
		expect(command).toContain(
			`cat ${staged} > /etc/dokploy/compose/big-app/code/docker-compose.yml`,
		);
		expect(command).toContain(`rm -f ${staged}`);
		// The file is created 0600 on the host before SFTP fills it.
		const prepare = remoteCommands()[0]!;
		expect(prepare).toContain("mkdir -p /etc/dokploy/compose/big-app");
		expect(prepare.indexOf("umask 077")).toBeLessThan(prepare.indexOf(staged));
	});

	it("stages through fs, 0600, on the local host", async () => {
		const command = await getCreateComposeFileCommand(
			{ ...baseCompose, composeFile: source },
			{ deploymentId: "dep-2" },
		);
		const staged = `${tmp}/compose/big-app/.dokploy-stage-raw-dep-2`;
		expect(readFileSync(staged, "utf8")).toBe(source);
		if (process.platform !== "win32") {
			expect(statSync(staged).mode & 0o777).toBe(0o600);
		}
		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
		expect(bytes(command)).toBeLessThan(1024);
		expect(command).not.toContain("base64");
	});

	it("reports the staged paths so a caller can clean up", async () => {
		const onStaged = vi.fn();
		await getCreateComposeFileCommand(
			{ ...baseCompose, composeFile: source, serverId: "srv-1" },
			{ deploymentId: "dep-3", onStaged },
		);
		expect(onStaged).toHaveBeenCalledWith([
			"/etc/dokploy/compose/big-app/.dokploy-stage-raw-dep-3",
		]);
	});
});

describe("compose .env (getCreateEnvFileCommand)", () => {
	const secretEnv = bigText("ENVSECRET", 200);

	it("stages a 200 KB env instead of embedding it", async () => {
		const compose = { ...baseCompose, env: secretEnv, serverId: "srv-1" };
		const command = await getCreateEnvFileCommand(compose, {
			deploymentId: "dep-1",
		});

		const [serverId, path, content] = mocks.writeFileRemote.mock.calls[0]!;
		expect(serverId).toBe("srv-1");
		expect(path).toBe("/etc/dokploy/compose/big-app/.dokploy-stage-env-dep-1");
		expect(bytes(content as string)).toBeGreaterThan(MAX_ARG_STRLEN);
		expect(content).toContain("ENVSECRET_SECRET_0=");
		expect(content).toContain("APP_NAME=");
		expectNoContentIn([command, ...remoteCommands()], [secretEnv]);
		expect(command).not.toContain("ENVSECRET");
		// The mode of an existing .env survives: touch, then `cat >` (never `mv`).
		expect(command).toContain(
			"{ touch /etc/dokploy/compose/big-app/code/.env && cat ",
		);
		expect(command).toContain(
			"cat /etc/dokploy/compose/big-app/.dokploy-stage-env-dep-1 > /etc/dokploy/compose/big-app/code/.env",
		);
		expect(command).not.toContain(" mv ");
		// Created 0600 before it holds the secrets.
		const prepare = remoteCommands()[0]!;
		expect(prepare).toContain("umask 077");
	});

	it("writes nothing to the log or error path: the failure message is fixed text", async () => {
		const command = await getCreateEnvFileCommand(
			{ ...baseCompose, env: secretEnv, serverId: "srv-1" },
			{ deploymentId: "dep-1" },
		);
		expect(command).toContain("Could not write the environment file");
		expect(command).not.toContain("hunter2");
	});
});

describe("file mounts (getCreateFilesCommand)", () => {
	const mountA = bigText("MOUNTA", 130);
	const mountB = bigText("MOUNTB", 60);
	const mountC = bigText("MOUNTC", 60);

	it("stages every mount of a >128 KB set and keeps all of them out of the command", async () => {
		const command = await getCreateFilesCommand({
			serverId: "build-1",
			outputPath: "/etc/dokploy/compose/big-app/files",
			files: [
				{ filePath: "a.env", content: mountA },
				{ filePath: "conf/b.cfg", content: mountB },
				{ filePath: "conf/", content: "" },
				{ filePath: "c.cfg", content: mountC },
			],
			deploymentId: "dep-1",
		});

		expect(bytes(mountA) + bytes(mountB) + bytes(mountC)).toBeGreaterThan(
			MAX_ARG_STRLEN,
		);
		expect(bytes(command)).toBeLessThan(4096);
		expectNoContentIn([command, ...remoteCommands()], [mountA, mountB, mountC]);

		// One prepare round trip for the whole set, then one SFTP write per file.
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		const prepare = remoteCommands()[0]!;
		expect(prepare).toContain("umask 077");
		expect(mocks.writeFileRemote.mock.calls).toEqual([
			[
				"build-1",
				"/etc/dokploy/compose/big-app/.dokploy-stage-mount-dep-1-0",
				mountA,
			],
			[
				"build-1",
				"/etc/dokploy/compose/big-app/.dokploy-stage-mount-dep-1-1",
				mountB,
			],
			[
				"build-1",
				"/etc/dokploy/compose/big-app/.dokploy-stage-mount-dep-1-2",
				mountC,
			],
		]);
		// Staged next to files/, never inside it: files/ is bind-mounted into containers.
		for (const [, path] of mocks.writeFileRemote.mock.calls) {
			expect(path as string).not.toContain("/files/");
		}
		expect(command).toContain(
			"cat /etc/dokploy/compose/big-app/.dokploy-stage-mount-dep-1-0 > /etc/dokploy/compose/big-app/files/a.env",
		);
		expect(command).toContain(
			"mkdir -p /etc/dokploy/compose/big-app/files/conf",
		);
	});

	it("quotes paths with spaces and shell metacharacters as single words", async () => {
		const command = await getCreateFilesCommand({
			serverId: "build-1",
			outputPath: "/etc/dokploy/compose/big-app/files",
			files: [{ filePath: "a b/$(touch pwned).env", content: "x=1\n" }],
			deploymentId: "dep 1; reboot",
		});
		expect(command).toContain(
			"'/etc/dokploy/compose/big-app/files/a b/$(touch pwned).env'",
		);
		expect(mocks.writeFileRemote.mock.calls[0]![1]).toBe(
			"/etc/dokploy/compose/big-app/.dokploy-stage-mount-dep1reboot-0",
		);
	});

	it("removes what it staged and rethrows when an upload fails", async () => {
		mocks.writeFileRemote
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("sftp down"));
		await expect(
			getCreateFilesCommand({
				serverId: "build-1",
				outputPath: "/etc/dokploy/compose/big-app/files",
				files: [
					{ filePath: "a", content: "1" },
					{ filePath: "b", content: "2" },
				],
				deploymentId: "dep-1",
			}),
		).rejects.toThrow("sftp down");
		expect(remoteCommands().at(-1)).toBe(
			"rm -f /etc/dokploy/compose/big-app/.dokploy-stage-mount-dep-1-0 /etc/dokploy/compose/big-app/.dokploy-stage-mount-dep-1-1",
		);
	});
});

// Runs the generated snippets in a real shell, as the deploy script does.
const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;
const itWithSh = hasSh ? it : it.skip;
const run = (script: string) =>
	spawnSync("sh", ["-c", `set -e\n${script}`], { encoding: "utf8" });
const stagedIn = (directory: string) =>
	readdirSync(directory).filter((name) => name.startsWith(".dokploy-"));

describe("staged content in a real shell", () => {
	itWithSh(
		"writes a >128 KB raw compose byte for byte and removes the staged file",
		async () => {
			const source = bigComposeFile() + bigComposeFile().slice(0, 40_000);
			const command = await getCreateComposeFileCommand(
				{ ...baseCompose, composeFile: source },
				{ deploymentId: "dep-sh" },
			);
			mkdirSync(`${tmp}/compose/big-app/code`, { recursive: true });
			writeFileSync(`${tmp}/compose/big-app/code/old.txt`, "old");

			const result = run(command);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("File 'docker-compose.yml' created");
			expect(
				readFileSync(`${tmp}/compose/big-app/code/docker-compose.yml`, "utf8"),
			).toBe(source);
			// The code dir was wiped like before; the staged file survived that wipe.
			expect(existsSync(`${tmp}/compose/big-app/code/old.txt`)).toBe(false);
			expect(stagedIn(`${tmp}/compose/big-app`)).toEqual([]);
		},
	);

	itWithSh(
		"writes the .env, keeping an existing file's mode, and removes the staged file",
		async () => {
			const env = bigText("ENVSECRET", 150);
			const compose = { ...baseCompose, env };
			const command = await getCreateEnvFileCommand(compose, {
				deploymentId: "dep-env",
			});
			mkdirSync(`${tmp}/compose/big-app/code`, { recursive: true });
			const envFile = `${tmp}/compose/big-app/code/.env`;
			writeFileSync(envFile, "OLD=1\n", { mode: 0o640 });

			const result = run(command);

			expect(result.status).toBe(0);
			const written = readFileSync(envFile, "utf8");
			expect(bytes(written)).toBeGreaterThan(MAX_ARG_STRLEN);
			expect(written).toContain("ENVSECRET_SECRET_0=");
			expect(written).not.toContain("OLD=1");
			if (process.platform !== "win32") {
				expect(statSync(envFile).mode & 0o777).toBe(0o640);
			}
			expect(stagedIn(`${tmp}/compose/big-app`)).toEqual([]);
		},
	);

	itWithSh(
		"creates nested file mounts, a directory mount and replaces a directory in the way",
		async () => {
			const a = bigText("MOUNTA", 140);
			const b = bigText("MOUNTB", 20);
			const filesDir = `${tmp}/compose/big-app/files`;
			mkdirSync(`${filesDir}/b.cfg`, { recursive: true });
			writeFileSync(`${filesDir}/b.cfg/inner`, "x");
			const command = await getCreateFilesCommand({
				outputPath: filesDir,
				files: [
					{ filePath: "deep/er/a.env", content: a },
					{ filePath: "b.cfg", content: b },
					{ filePath: "empty-dir/", content: "" },
				],
				replaceDirectory: true,
				deploymentId: "dep-m",
			});

			const result = run(command);

			expect(result.status).toBe(0);
			expect(readFileSync(`${filesDir}/deep/er/a.env`, "utf8")).toBe(a);
			expect(readFileSync(`${filesDir}/b.cfg`, "utf8")).toBe(b);
			expect(statSync(`${filesDir}/empty-dir`).isDirectory()).toBe(true);
			expect(stagedIn(`${tmp}/compose/big-app`)).toEqual([]);
			// Nothing was staged inside the bind-mounted directory.
			expect(stagedIn(filesDir)).toEqual([]);
		},
	);

	itWithSh(
		"stops at a failed copy and removes every staged file of the set",
		async () => {
			const filesDir = `${tmp}/compose/big-app/files`;
			mkdirSync(filesDir, { recursive: true });
			// A regular file where a directory is needed: the second mount cannot be written.
			writeFileSync(`${filesDir}/blocker`, "x");
			const command = await getCreateFilesCommand({
				outputPath: filesDir,
				files: [
					{ filePath: "ok.cfg", content: "ok\n" },
					{ filePath: "blocker/x.cfg", content: "never\n" },
					{ filePath: "after.cfg", content: "after\n" },
				],
				deploymentId: "dep-f",
			});

			const result = run(`${command}\necho should-not-run`);

			expect(result.status).toBe(1);
			expect(result.stdout).toContain("Could not write a file mount");
			expect(result.stdout).not.toContain("should-not-run");
			expect(readFileSync(`${filesDir}/ok.cfg`, "utf8")).toBe("ok\n");
			expect(existsSync(`${filesDir}/after.cfg`)).toBe(false);
			expect(stagedIn(`${tmp}/compose/big-app`)).toEqual([]);
		},
	);

	itWithSh("copies with cat so an existing destination keeps its mode", () => {
		const dir = `${tmp}/odd dir`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${dir}/staged one`, "new\n");
		writeFileSync(`${dir}/target $(echo pwned)`, "old\n", { mode: 0o640 });
		const result = run(
			getInstallStagedFileCommand({
				staged: `${dir}/staged one`,
				destination: `${dir}/target $(echo pwned)`,
				failureMessage: "failed",
			}),
		);
		expect(result.status).toBe(0);
		expect(readFileSync(`${dir}/target $(echo pwned)`, "utf8")).toBe("new\n");
		if (process.platform !== "win32") {
			expect(statSync(`${dir}/target $(echo pwned)`).mode & 0o777).toBe(0o640);
		}
		expect(existsSync(`${dir}/staged one`)).toBe(false);
	});
});

describe("staging housekeeping", () => {
	it("removes staged files older than an hour and leaves recent and unrelated ones", async () => {
		const dir = `${tmp}/compose/big-app`;
		mkdirSync(dir, { recursive: true });
		const stale = `${dir}/.dokploy-stage-env-old`;
		const staleCompose = `${dir}/.dokploy-compose-old.yml`;
		const recent = `${dir}/.dokploy-stage-env-recent`;
		const unrelated = `${dir}/notes.txt`;
		for (const file of [stale, staleCompose, recent, unrelated]) {
			writeFileSync(file, "x");
		}
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		for (const file of [stale, staleCompose, unrelated]) {
			utimesSync(file, twoHoursAgo, twoHoursAgo);
		}

		await stageFiles({
			directory: dir,
			files: [{ path: `${dir}/.dokploy-stage-env-new`, content: "n" }],
		});

		expect(existsSync(stale)).toBe(false);
		expect(existsSync(staleCompose)).toBe(false);
		expect(existsSync(recent)).toBe(true);
		expect(existsSync(unrelated)).toBe(true);
		expect(existsSync(`${dir}/.dokploy-stage-env-new`)).toBe(true);
	});

	it("sweeps stale files on the remote host in the same prepare round trip", async () => {
		await stageFiles({
			serverId: "srv-1",
			directory: "/etc/dokploy/compose/big-app",
			files: [
				{
					path: getStagedFilePath({
						directory: "/etc/dokploy/compose/big-app",
						kind: "env",
						deploymentId: "dep-1",
					}),
					content: "n",
				},
			],
		});
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		const prepare = remoteCommands()[0]!;
		expect(prepare).toContain("-name '.dokploy-stage-*'");
		expect(prepare).toContain("-name '.dokploy-compose-*.yml'");
		expect(prepare).toContain("-mmin +60");
	});

	it("keeps sweeping when one file vanishes between readdir and stat", async () => {
		const dir = `${tmp}/compose/big-app`;
		mkdirSync(dir, { recursive: true });
		const gone = `${dir}/.dokploy-stage-z-gone`;
		const stale = `${dir}/.dokploy-stage-a-stale`;
		for (const file of [gone, stale]) writeFileSync(file, "x");
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		for (const file of [gone, stale])
			utimesSync(file, twoHoursAgo, twoHoursAgo);
		mocks.statFailsFor.add(".dokploy-stage-z-gone");

		await stageFiles({
			directory: dir,
			files: [{ path: `${dir}/.dokploy-stage-env-new`, content: "n" }],
		});

		expect(existsSync(stale)).toBe(false);
		expect(existsSync(`${dir}/.dokploy-stage-env-new`)).toBe(true);
	});

	it("removeStagedFiles never throws", async () => {
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh down"));
		await expect(
			removeStagedFiles("srv-1", ["/etc/dokploy/compose/a/.dokploy-stage-x"]),
		).resolves.toBeUndefined();
	});
});

// L1: a failed prepare step threw an ExecError, which deployCompose does not
// write to the deployment log (it only logs non-ExecError errors).
describe("a failed remote prepare step", () => {
	const prepareFailure = () =>
		new ExecError("Command failed with exit code 1: mkdir: Permission denied", {
			command:
				"mkdir -p /etc/dokploy/compose/big-app && (umask 077 && : > /etc/dokploy/compose/big-app/.dokploy-stage-env-dep-1)",
			stderr:
				"mkdir: cannot create directory '/etc/dokploy/compose/big-app': Permission denied\n",
			exitCode: 1,
			serverId: "srv-1",
		});

	it("is rethrown as a plain Error that carries the reason", async () => {
		mocks.execAsyncRemote.mockRejectedValue(prepareFailure());

		const error = await getCreateEnvFileCommand(
			{ ...baseCompose, env: "TOKEN=hunter2", serverId: "srv-1" },
			{ deploymentId: "dep-1" },
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		// deployCompose logs `error.message` for everything that is not an ExecError.
		expect(error).not.toBeInstanceOf(ExecError);
		expect((error as Error).name).toBe("Error");
		const message = (error as Error).message;
		expect(message).toContain("Permission denied");
		expect(message).toContain("/etc/dokploy/compose/big-app");
		// The command and the content never reach the message.
		expect(message).not.toContain("umask");
		expect(message).not.toContain("hunter2");
		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
	});

	it("keeps the original failure as the cause", async () => {
		const original = prepareFailure();
		mocks.execAsyncRemote.mockRejectedValue(original);

		const error = await getCreateEnvFileCommand(
			{ ...baseCompose, env: "TOKEN=hunter2", serverId: "srv-1" },
			{ deploymentId: "dep-1" },
		).catch((e: unknown) => e);

		// Remote-unreachable detection walks the cause chain.
		expect((error as Error).cause).toBe(original);
		expect((error as Error).message).not.toContain("umask");
		expect((error as Error).message).not.toContain("hunter2");
	});

	it("does the same for the compose file staged by writeDomainsToCompose", async () => {
		mocks.execAsyncRemote.mockRejectedValue(prepareFailure());
		const error = await writeDomainsToCompose(
			{ ...baseCompose, serverId: "srv-1" },
			[],
			{ deploymentId: "dep-1" },
		).catch((e: unknown) => e);
		expect(error).not.toBeInstanceOf(ExecError);
		expect((error as Error).message).toContain("Permission denied");
	});

	it("falls back to the error message when the failure has no output", async () => {
		mocks.execAsyncRemote.mockRejectedValue(new Error("connect ETIMEDOUT"));
		const error = await getCreateComposeFileCommand(
			{ ...baseCompose, serverId: "srv-1" },
			{ deploymentId: "dep-1" },
		).catch((e: unknown) => e);
		expect((error as Error).message).toContain("connect ETIMEDOUT");
	});
});

describe("files staged for a script that stops early", () => {
	const run = (script: string) =>
		spawnSync(
			"sh",
			[
				"-c",
				`set -e
${script}`,
			],
			{ encoding: "utf8" },
		);
	const hasShHere = spawnSync("sh", ["-c", "true"]).status === 0;
	const itSh = hasShHere ? it : it.skip;
	const stagedNames = (dir: string) =>
		readdirSync(dir).filter((name) => name.startsWith(".dokploy-"));

	itSh(
		"removes the staged .env when there is no compose file to write",
		async () => {
			const compose = { ...baseCompose, env: bigText("ENVSECRET", 20) };
			const envCommand = await getCreateEnvFileCommand(compose, {
				deploymentId: "dep-e",
			});
			const staged = `${tmp}/compose/big-app/.dokploy-stage-env-dep-e`;
			expect(existsSync(staged)).toBe(true);

			const composeCommand = await writeDomainsToCompose(
				{ ...compose, composeFile: "" },
				[],
				{ deploymentId: "dep-e", alsoRemove: [staged] },
			);
			const result = run(`${composeCommand}
${envCommand}
echo should-not-run`);

			expect(result.status).toBe(1);
			expect(result.stdout).toContain("Compose file not found");
			expect(result.stdout).not.toContain("should-not-run");
			expect(stagedNames(`${tmp}/compose/big-app`)).toEqual([]);
		},
	);

	itSh("removes the staged .env when the compose copy fails", async () => {
		const compose = { ...baseCompose, env: bigText("ENVSECRET", 20) };
		await getCreateEnvFileCommand(compose, { deploymentId: "dep-c" });
		const staged = `${tmp}/compose/big-app/.dokploy-stage-env-dep-c`;

		// No code/ directory, so the copy of the compose cannot succeed.
		const composeCommand = await writeDomainsToCompose(compose, [], {
			deploymentId: "dep-c",
			alsoRemove: [staged],
		});
		const result = run(`${composeCommand}
echo should-not-run`);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Could not write the compose file");
		expect(stagedNames(`${tmp}/compose/big-app`)).toEqual([]);
	});

	it("getBuildComposeCommand hands the staged .env to the compose step", async () => {
		const command = await getBuildComposeCommand(
			{ ...baseCompose, env: "TOKEN=hunter2", serverId: "srv-1" },
			{ deploymentId: "dep-b" },
		);
		const env = "/etc/dokploy/compose/big-app/.dokploy-stage-env-dep-b";
		// The failure branch of the compose copy removes the staged env too.
		expect(command).toContain(
			`rm -f /etc/dokploy/compose/big-app/.dokploy-compose-dep-b.yml ${env};`,
		);
	});

	itSh(
		"getBuildComposeCommand leaves no staged .env behind when the compose is missing",
		async () => {
			const command = await getBuildComposeCommand(
				{
					...baseCompose,
					composeFile: "",
					env: bigText("ENVSECRET", 20),
				},
				{ deploymentId: "dep-m" },
			);
			expect(
				existsSync(`${tmp}/compose/big-app/.dokploy-stage-env-dep-m`),
			).toBe(true);

			const result = run(command);

			expect(result.status).toBe(1);
			expect(result.stdout).toContain("Compose file not found");
			expect(stagedNames(`${tmp}/compose/big-app`)).toEqual([]);
		},
	);
});

describe("build-server step", () => {
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

	const source = bigComposeFile();
	const env = bigText("ENVSECRET", 150);
	const mountA = bigText("MOUNTA", 140);
	const mountB = bigText("MOUNTB", 40);
	const entity = {
		...baseCompose,
		composeFile: source,
		env,
		buildServerId: "build-1",
		buildRegistryId: "reg-1",
		server: { name: "prod-1" },
		mounts: [
			{ type: "file", filePath: "a.env", content: mountA },
			{ type: "file", filePath: "conf/b.cfg", content: mountB },
			{ type: "bind", hostPath: "/srv/data", mountPath: "/data" },
		],
	};
	const deployment = { logPath: "/tmp/log", deploymentId: "dep-9" };

	beforeEach(() => {
		mocks.findServerById.mockResolvedValue(buildServer);
		mocks.findRegistryByIdWithCredentials.mockResolvedValue(registry);
		mocks.loginDockerRegistry.mockResolvedValue(undefined);
		mocks.generateApplyPatchesCommand.mockResolvedValue("");
		// No service builds: the step ends right after `compose config`.
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
	});

	it("never joins the sources, the env or the mounts into a command", async () => {
		const runStep = vi.fn().mockResolvedValue(undefined);
		await prepareComposeBuildServerDeploy({ entity, deployment, runStep });

		const staged = new Map(
			mocks.writeFileRemote.mock.calls.map((call) => [
				call[1] as string,
				call[2] as string,
			]),
		);
		expect(
			staged.get("/etc/dokploy/compose/big-app/.dokploy-stage-raw-dep-9"),
		).toBe(source);
		expect(
			staged.get("/etc/dokploy/compose/big-app/.dokploy-stage-mount-dep-9-0"),
		).toBe(mountA);
		expect(
			staged.get("/etc/dokploy/compose/big-app/.dokploy-stage-mount-dep-9-1"),
		).toBe(mountB);
		expect(
			staged.get("/etc/dokploy/compose/big-app/.dokploy-stage-env-dep-9"),
		).toContain("ENVSECRET_SECRET_0=");
		expect(
			staged.get("/etc/dokploy/compose/big-app/.dokploy-compose-dep-9.yml"),
		).toContain("svc-59");
		for (const call of mocks.writeFileRemote.mock.calls) {
			expect(call[0]).toBe("build-1");
		}

		// The mounts alone are past the limit; the commands are tiny anyway.
		expect(bytes(mountA) + bytes(mountB)).toBeGreaterThan(MAX_ARG_STRLEN);
		const commands = remoteCommands();
		expect(commands.length).toBeGreaterThan(0);
		expectNoContentIn(commands, [source, env, mountA, mountB]);
		expect(commands.join("\n")).not.toContain("hunter2");
		for (const [step] of runStep.mock.calls) {
			expect(bytes(step as string)).toBeLessThan(1024);
		}
		// Installed before `compose config` reads them.
		const configIndex = commands.findIndex((c) =>
			c.includes("config --format json"),
		);
		for (const destination of [
			"/etc/dokploy/compose/big-app/files/a.env",
			"/etc/dokploy/compose/big-app/files/conf/b.cfg",
			"/etc/dokploy/compose/big-app/code/docker-compose.yml",
			"/etc/dokploy/compose/big-app/code/.env",
		]) {
			const index = commands.findIndex((c) => c.includes(`> ${destination}`));
			expect(index, destination).toBeGreaterThan(-1);
			expect(index, destination).toBeLessThan(configIndex);
		}
	});

	// L2: staging used to happen before the first cancel checkpoint.
	it("stages nothing when the deployment was cancelled while queued", async () => {
		mocks.deploymentStatus.mockResolvedValue({ status: "cancelled" });
		const runStep = vi.fn().mockResolvedValue(undefined);

		await expect(
			prepareComposeBuildServerDeploy({ entity, deployment, runStep }),
		).rejects.toMatchObject({ deploymentCancelled: true });

		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("stages nothing for the compose, env and mounts once a cancel landed", async () => {
		// Cancelled as soon as the raw source has been written.
		mocks.deploymentStatus.mockImplementation(async () => ({
			status: mocks.writeFileRemote.mock.calls.some((call) =>
				String(call[1]).includes("stage-raw"),
			)
				? "cancelled"
				: "running",
		}));
		const runStep = vi.fn().mockResolvedValue(undefined);

		await expect(
			prepareComposeBuildServerDeploy({ entity, deployment, runStep }),
		).rejects.toMatchObject({ deploymentCancelled: true });

		const staged = mocks.writeFileRemote.mock.calls.map((call) => call[1]);
		expect(staged).toEqual([
			"/etc/dokploy/compose/big-app/.dokploy-stage-raw-dep-9",
		]);
	});

	it("removes what is staged when a cancel lands between staging and running", async () => {
		// Cancelled right after the compose and the env have been staged.
		mocks.deploymentStatus.mockImplementation(async () => ({
			status: mocks.writeFileRemote.mock.calls.some((call) =>
				String(call[1]).includes("stage-env"),
			)
				? "cancelled"
				: "running",
		}));
		const runStep = vi.fn().mockResolvedValue(undefined);

		await expect(
			prepareComposeBuildServerDeploy({ entity, deployment, runStep }),
		).rejects.toMatchObject({ deploymentCancelled: true });

		const removal = mocks.execAsyncRemote.mock.calls.find(
			(call) => call[0] === "build-1" && String(call[1]).startsWith("rm -f "),
		);
		expect(removal).toBeDefined();
		const command = removal![1] as string;
		expect(command).toContain(
			"/etc/dokploy/compose/big-app/.dokploy-compose-dep-9.yml",
		);
		expect(command).toContain(
			"/etc/dokploy/compose/big-app/.dokploy-stage-env-dep-9",
		);
		// Nothing staged was installed, and the mounts were never staged.
		expect(
			remoteCommands().some(
				(c) =>
					c.includes("dokploy-compose-dep-9.yml >") ||
					c.includes("stage-env-dep-9 >"),
			),
		).toBe(false);
		expect(
			mocks.writeFileRemote.mock.calls.some((call) =>
				String(call[1]).includes("stage-mount"),
			),
		).toBe(false);
	});
});

describe("file mount services", () => {
	const content = bigText("MOUNTSECRET", 200);
	const row = (serverId: string | null) => ({
		mountId: "m1",
		type: "file",
		serviceType: "application",
		filePath: "conf/big.env",
		content,
		application: { serverId, appName: "web-app" },
	});

	it("createFileMount stages a >128 KB file on the server and keeps it out of the command", async () => {
		mocks.mountRow.mockResolvedValue(row("srv-1"));
		await createFileMount("m1");

		expect(mocks.writeFileRemote).toHaveBeenCalledTimes(1);
		const [serverId, path, written] = mocks.writeFileRemote.mock.calls[0]!;
		expect(serverId).toBe("srv-1");
		expect(path).toMatch(
			/^\/etc\/dokploy\/applications\/web-app\/\.dokploy-stage-mount-[0-9a-f-]{36}-0$/,
		);
		expect(written).toBe(content);
		const commands = remoteCommands();
		expectNoContentIn(commands, [content]);
		expect(
			commands.some((c) =>
				c.includes("/etc/dokploy/applications/web-app/files/conf/big.env"),
			),
		).toBe(true);
	});

	it("updateFileMount stages on the server, replacing a directory in the way", async () => {
		mocks.mountRow.mockResolvedValue(row("srv-1"));
		await updateFileMount("m1");

		const commands = remoteCommands();
		expectNoContentIn(commands, [content]);
		const script = commands.find((c) => c.includes("big.env"))!;
		expect(script).toContain(
			"if [ -d /etc/dokploy/applications/web-app/files/conf/big.env ]; then rm -rf",
		);
		expect(mocks.writeFileRemote.mock.calls[0]![2]).toBe(content);
	});

	it("updateFileMount removes the staged file when the script cannot run", async () => {
		mocks.mountRow.mockResolvedValue(row("srv-1"));
		mocks.execAsyncRemote
			.mockResolvedValueOnce({ stdout: "", stderr: "" }) // prepare
			.mockRejectedValueOnce(new Error("ssh dropped")) // the script
			.mockResolvedValue({ stdout: "", stderr: "" }); // the cleanup

		await expect(updateFileMount("m1")).rejects.toThrow("ssh dropped");

		const stagedPath = mocks.writeFileRemote.mock.calls[0]![1] as string;
		expect(remoteCommands().at(-1)).toBe(`rm -f ${stagedPath}`);
	});

	// path.resolve is posix here (see the node:path mock), which cannot place a
	// Windows temp dir; the fs staging itself is covered by the shell tests above.
	it.skipIf(process.platform === "win32")(
		"updateFileMount stages through fs for a service on the Dokploy host",
		async () => {
			mocks.mountRow.mockResolvedValue(row(null));
			await updateFileMount("m1");

			expect(mocks.writeFileRemote).not.toHaveBeenCalled();
			const [command] = mocks.execAsync.mock.calls[0]!;
			expect(bytes(command as string)).toBeLessThan(1024);
			expect(command).not.toContain("base64");
			const staged = stagedIn(`${tmp}/applications/web-app`);
			expect(staged).toHaveLength(1);
			expect(
				readFileSync(`${tmp}/applications/web-app/${staged[0]}`, "utf8"),
			).toBe(content);
		},
	);
});
