import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative } from "node:path";
import { parse } from "shell-quote";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The compose file, and the `.env` next to it, live in the repository's
// checkout, which is the repository's: a link in the place of either, or of a
// directory on their path, must never make Dokploy read or write a file
// outside the checkout (T-7857).

// Each case starts a few shells, which is slow on Windows.
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
		// Local (no serverId) paths point at a temp dir; remote ones stay fixed.
		paths: (isServer = false) =>
			isServer
				? actual.paths(true)
				: { ...actual.paths(true), COMPOSE_PATH: mocks.localBase.path },
	};
});
vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsyncRemote: mocks.execAsyncRemote,
	writeFileRemote: mocks.writeFileRemote,
}));
vi.mock("@dokploy/server/utils/vault", () => ({
	withResolvedVaultRefs: async (entity: unknown) => entity,
}));

import {
	getBackupCurrentDeploymentCommand,
	getComposeBackupDir,
	getCreateEnvFileCommand,
	getRestoreAfterFailedBuildCommand,
	LAST_GOOD_COMPOSE_BAK,
	LAST_GOOD_ENV_BAK,
	PRE_DEPLOY_COMPOSE_BAK,
	PRE_DEPLOY_ENV_BAK,
} from "@dokploy/server/utils/builders/compose";
import {
	COMPOSE_FILE_LINK_MARKER,
	COMPOSE_FILE_LINK_MESSAGE,
	ComposeFileLinkError,
	getComposeFileLinkError,
	getGuardedReadCommand,
} from "@dokploy/server/utils/compose-file-guard";
import {
	getInstallStagedComposeCommand,
	loadDockerCompose,
	loadDockerComposeRemote,
	readComposeFile,
	writeDomainsToCompose,
} from "@dokploy/server/utils/docker/domain";

const SPEC = "services:\n  web:\n    image: nginx\n";

const baseCompose = {
	appName: "link-app",
	composeId: "c1",
	sourceType: "github",
	composeFile: "",
	command: "",
	composePath: "docker-compose.yml",
	composeType: "docker-compose",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: null,
	env: "A=1",
	mounts: [],
	createEnvFile: false,
	buildServerId: null,
	domains: [],
	serviceNetworks: [],
	environment: { project: { env: "" }, env: "" },
} as any;

// ---------------------------------------------------------------------------
// Command text, on every platform
// ---------------------------------------------------------------------------

const REMOTE = "/etc/dokploy/compose/link-app";
const words = (command: string) => parse(command, (name) => `$${name}`);

describe("the commands that write the compose file", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.writeFileRemote.mockResolvedValue(undefined);
	});

	const install = async (composePath: string) => {
		const compose = {
			...baseCompose,
			sourceType: "raw",
			composeFile: SPEC,
			composePath,
			serverId: "srv-1",
		};
		return writeDomainsToCompose(compose, [], { deploymentId: "dep-1" });
	};

	it("checks the directory first, replaces a link in the file's place, then copies", async () => {
		const command = await install("docker-compose.yml");
		const guard = command.indexOf("__dokploy_dir_inside");
		const replace = command.indexOf(
			`if [ -L ${REMOTE}/code/docker-compose.yml ]`,
		);
		const copy = command.indexOf(
			`cat ${REMOTE}/.dokploy-compose-dep-1.yml > ${REMOTE}/code/docker-compose.yml`,
		);
		expect(guard).toBeGreaterThan(-1);
		expect(replace).toBeGreaterThan(guard);
		expect(copy).toBeGreaterThan(replace);
		expect(command).toContain(COMPOSE_FILE_LINK_MESSAGE);
		// The refusal removes the staged compose before it stops the script.
		expect(command).toMatch(
			new RegExp(`\\{ rm -f ${REMOTE}/\\.dokploy-compose-dep-1\\.yml; echo `),
		);
	});

	it("passes a path with spaces and shell characters as single words", () => {
		const file = `${REMOTE}/code/deploy/my stack [prod] #1.yml`;
		const command = getInstallStagedComposeCommand(
			`${REMOTE}/.dokploy-compose-dep-1.yml`,
			file,
			[],
			`${REMOTE}/code`,
		);
		const test = /if \[ -L (.*?) \]; then rm -f (.*?); fi/.exec(command);
		expect(test).not.toBeNull();
		expect(words(`echo ${test?.[1]}`)).toEqual(["echo", file]);
		expect(words(`echo ${test?.[2]}`)).toEqual(["echo", file]);
		const guard = /__dokploy_dir_inside (.*?) (.*?) \|\| /.exec(command);
		expect(words(`echo ${guard?.[1]}`)).toEqual(["echo", `${REMOTE}/code`]);
		expect(words(`echo ${guard?.[2]}`)).toEqual([
			"echo",
			`${REMOTE}/code/deploy`,
		]);
	});

	it("also guards the .env written next to the compose file", async () => {
		const command = await getCreateEnvFileCommand(
			{
				...baseCompose,
				composePath: "deploy/docker-compose.yml",
				createEnvFile: true,
				serverId: "srv-1",
			},
			{ deploymentId: "dep-1" },
		);
		const guard = command.indexOf(
			`__dokploy_dir_inside ${REMOTE}/code ${REMOTE}/code/deploy`,
		);
		const replace = command.indexOf(`if [ -L ${REMOTE}/code/deploy/.env ]`);
		expect(guard).toBeGreaterThan(-1);
		expect(replace).toBeGreaterThan(guard);
	});

	it("snapshots only a compose file and .env that resolve inside the checkout", () => {
		const command = getBackupCurrentDeploymentCommand({
			...baseCompose,
			serverId: "srv-1",
		});
		expect(command).toContain(
			`if [ -f ${REMOTE}/code/docker-compose.yml ] && __dokploy_inside ${REMOTE}/code ${REMOTE}/code/docker-compose.yml; then cp `,
		);
		expect(command).toContain(
			`if [ -f ${REMOTE}/code/.env ] && __dokploy_inside ${REMOTE}/code ${REMOTE}/code/.env; then cp `,
		);
	});

	it("restores through a link only after replacing it, and not at all out of the checkout", async () => {
		const command = await getRestoreAfterFailedBuildCommand({
			...baseCompose,
			serverId: "srv-1",
		});
		expect(command).toContain(
			`__dokploy_dir_inside ${REMOTE}/code ${REMOTE}/code`,
		);
		expect(command).toContain(
			`if [ -L ${REMOTE}/code/docker-compose.yml ]; then rm -f ${REMOTE}/code/docker-compose.yml; fi;`,
		);
		expect(command).toContain('if [ "$__dokploy_write_ok" = "1" ]; then');
		expect(command).toContain(COMPOSE_FILE_LINK_MESSAGE);
	});
});

describe("the commands that read the compose file", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("guards the remote read and passes the path as one word", () => {
		const file = "/etc/dokploy/compose/link-app/code/my stack [1].yml";
		const command = getGuardedReadCommand({
			codeDirectory: "/etc/dokploy/compose/link-app/code",
			file,
			read: "cat '/etc/dokploy/compose/link-app/code/my stack [1].yml'",
		});
		expect(command).toContain(COMPOSE_FILE_LINK_MARKER);
		// The file's path is one word of the check, quoted by shell-quote.
		const check =
			/__dokploy_inside (\S+) (.*?) \|\| \[ ! -e (.*?) \]; then/.exec(command);
		expect(check).not.toBeNull();
		expect(words(`echo ${check?.[2]}`)).toEqual(["echo", file]);
		expect(words(`echo ${check?.[3]}`)).toEqual(["echo", file]);
	});

	it("refuses a remote compose file the host reports as a link out", async () => {
		mocks.execAsyncRemote.mockResolvedValueOnce({
			stdout: COMPOSE_FILE_LINK_MARKER,
			stderr: "",
		});
		const error = await loadDockerComposeRemote({
			...baseCompose,
			serverId: "srv-1",
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ComposeFileLinkError);
		expect((error as Error).message).toContain(COMPOSE_FILE_LINK_MESSAGE);
	});

	it("still reads an ordinary remote compose file", async () => {
		mocks.execAsyncRemote.mockResolvedValueOnce({ stdout: SPEC, stderr: "" });
		const spec = await loadDockerComposeRemote({
			...baseCompose,
			serverId: "srv-1",
		});
		expect(spec?.services).toHaveProperty("web");
	});
});

// ---------------------------------------------------------------------------
// Real links, real shell
// ---------------------------------------------------------------------------

const shells = ["sh"].filter(
	(shell) => spawnSync(shell, ["-c", "true"]).status === 0,
);
const tempBase = () =>
	(process.platform === "win32" ? process.cwd() : tmpdir()).replaceAll(
		"\\",
		"/",
	);

// The links have to be real for the shell: a file link needs a privilege on
// Windows, and Git Bash does not always see it as one. The cases below run
// where both work (Linux, macOS), and are skipped elsewhere.
const linksWork = (() => {
	if (shells.length === 0) return false;
	const probe = mkdtempSync(`${tempBase()}/.dokploy-link-probe-`).replaceAll(
		"\\",
		"/",
	);
	try {
		mkdirSync(`${probe}/dir`);
		writeFileSync(`${probe}/dir/file`, "x");
		symlinkSync(`${probe}/dir/file`, `${probe}/file-link`, "file");
		symlinkSync(`${probe}/dir`, `${probe}/dir-link`, "junction");
		const result = spawnSync(
			"sh",
			[
				"-c",
				'[ -L "$1/file-link" ] && [ -L "$1/dir-link" ] && [ "$(cd -P "$1/dir-link" && pwd -P)" = "$(cd -P "$1/dir" && pwd -P)" ]',
				"sh",
				probe,
			],
			{ encoding: "utf8" },
		);
		return result.status === 0;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();
const itWithLinks = it.skipIf(!linksWork);

let tmp = "";
const app = () => `${tmp}/compose/link-app`;
const code = () => `${app()}/code`;
const outside = () => `${tmp}/outside`;
const OUTSIDE_TEXT = "outside: untouched\n";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.writeFileRemote.mockResolvedValue(undefined);
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = mkdtempSync(`${tempBase()}/.dokploy-link-`).replaceAll("\\", "/");
	mocks.localBase.path = `${tmp}/compose`;
	mkdirSync(`${code()}/deploy`, { recursive: true });
	mkdirSync(outside(), { recursive: true });
	writeFileSync(`${outside()}/target.yml`, OUTSIDE_TEXT);
	writeFileSync(`${outside()}/.env`, OUTSIDE_TEXT);
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// A file link is relative, as a checkout brings it; a directory link
// (a junction on Windows) has to be absolute.
const link = (target: string, name: string, type: "file" | "junction") => {
	const place = `${code()}/${name}`;
	symlinkSync(
		type === "file" ? relative(dirname(place), target) : target,
		place,
		type,
	);
};
const isLink = (path: string) => lstatSync(path).isSymbolicLink();
const run = (script: string) =>
	spawnSync("sh", ["-c", `set -e\n${script}`], { encoding: "utf8" });
const staged = () =>
	existsSync(app())
		? (
				spawnSync("sh", ["-c", `ls -A '${app()}'`], { encoding: "utf8" })
					.stdout ?? ""
			)
				.split("\n")
				.filter((name) => name.startsWith(".dokploy-"))
		: [];

const rawCompose = (composePath = "docker-compose.yml") => ({
	...baseCompose,
	sourceType: "raw",
	composeFile: SPEC,
	composePath,
});

describe("writing the compose file in a real shell", () => {
	itWithLinks(
		"replaces a link to a file outside the checkout, and leaves that file alone",
		async () => {
			link(`${outside()}/target.yml`, "docker-compose.yml", "file");
			const snippet = await writeDomainsToCompose(rawCompose(), [], {
				deploymentId: "dep-1",
			});
			expect(staged()).toHaveLength(1);

			const result = run(`{ ${snippet}\necho installed; }`);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("installed");
			expect(readFileSync(`${outside()}/target.yml`, "utf8")).toBe(
				OUTSIDE_TEXT,
			);
			expect(isLink(`${code()}/docker-compose.yml`)).toBe(false);
			expect(readFileSync(`${code()}/docker-compose.yml`, "utf8")).toContain(
				"image: nginx",
			);
			expect(staged()).toEqual([]);
		},
	);

	itWithLinks(
		"replaces a link to a dangling target instead of creating the target",
		async () => {
			link(`${outside()}/created-by-write.yml`, "docker-compose.yml", "file");
			const snippet = await writeDomainsToCompose(rawCompose(), [], {
				deploymentId: "dep-1",
			});

			const result = run(`{ ${snippet}\necho installed; }`);

			expect(result.status, result.stderr).toBe(0);
			expect(existsSync(`${outside()}/created-by-write.yml`)).toBe(false);
			expect(isLink(`${code()}/docker-compose.yml`)).toBe(false);
		},
	);

	itWithLinks(
		"replaces a link to another file of the checkout, which stays as it was",
		async () => {
			writeFileSync(`${code()}/real.yml`, "real: true\n");
			link(`${code()}/real.yml`, "docker-compose.yml", "file");
			const snippet = await writeDomainsToCompose(rawCompose(), [], {
				deploymentId: "dep-1",
			});

			const result = run(`{ ${snippet}\necho installed; }`);

			expect(result.status, result.stderr).toBe(0);
			expect(readFileSync(`${code()}/real.yml`, "utf8")).toBe("real: true\n");
			expect(isLink(`${code()}/docker-compose.yml`)).toBe(false);
		},
	);

	const stageForInstall = (name: string) => {
		const stagedPath = `${app()}/${name}`;
		mkdirSync(app(), { recursive: true });
		writeFileSync(stagedPath, SPEC);
		return stagedPath;
	};

	itWithLinks(
		"refuses a compose file whose directory is a link out of the checkout",
		() => {
			rmSync(`${code()}/deploy`, { recursive: true, force: true });
			link(outside(), "deploy", "junction");
			writeFileSync(`${outside()}/docker-compose.yml`, OUTSIDE_TEXT);
			const snippet = getInstallStagedComposeCommand(
				stageForInstall(".dokploy-compose-dep-1.yml"),
				`${code()}/deploy/docker-compose.yml`,
				[],
				code(),
			);
			expect(staged()).toHaveLength(1);

			const result = run(`{ ${snippet}\necho should-not-run; }`);

			expect(result.status).toBe(1);
			expect(result.stdout).not.toContain("should-not-run");
			expect(result.stderr).toContain(COMPOSE_FILE_LINK_MESSAGE);
			expect(readFileSync(`${outside()}/docker-compose.yml`, "utf8")).toBe(
				OUTSIDE_TEXT,
			);
			expect(staged()).toEqual([]);
		},
	);

	itWithLinks(
		"allows a directory that is a link to another directory of the checkout",
		() => {
			mkdirSync(`${code()}/real-deploy`);
			rmSync(`${code()}/deploy`, { recursive: true, force: true });
			link(`${code()}/real-deploy`, "deploy", "junction");
			const snippet = getInstallStagedComposeCommand(
				stageForInstall(".dokploy-compose-dep-1.yml"),
				`${code()}/deploy/docker-compose.yml`,
				[],
				code(),
			);

			const result = run(`{ ${snippet}\necho installed; }`);

			expect(result.status, result.stderr).toBe(0);
			expect(
				readFileSync(`${code()}/real-deploy/docker-compose.yml`, "utf8"),
			).toContain("image: nginx");
		},
	);

	itWithLinks(
		"refuses a .env whose directory is a link out of the checkout",
		async () => {
			rmSync(`${code()}/deploy`, { recursive: true, force: true });
			link(outside(), "deploy", "junction");
			const snippet = await getCreateEnvFileCommand(
				{
					...rawCompose("deploy/docker-compose.yml"),
					createEnvFile: true,
				},
				{ deploymentId: "dep-1" },
			);

			const result = run(`{ ${snippet}\necho should-not-run; }`);

			expect(result.status).toBe(1);
			expect(result.stdout).not.toContain("should-not-run");
			expect(result.stderr).toContain(COMPOSE_FILE_LINK_MESSAGE);
			expect(readFileSync(`${outside()}/.env`, "utf8")).toBe(OUTSIDE_TEXT);
			expect(staged()).toEqual([]);
		},
	);

	itWithLinks("replaces a .env that is a link, as before", async () => {
		link(`${outside()}/.env`, ".env", "file");
		const snippet = await getCreateEnvFileCommand(
			{ ...rawCompose(), createEnvFile: true },
			{ deploymentId: "dep-1" },
		);

		const result = run(`{ ${snippet}\necho installed; }`);

		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(`${outside()}/.env`, "utf8")).toBe(OUTSIDE_TEXT);
		expect(isLink(`${code()}/.env`)).toBe(false);
		expect(readFileSync(`${code()}/.env`, "utf8")).toContain("link-app");
	});
});

describe("the snapshot and the restore in a real shell", () => {
	const backupDir = () => getComposeBackupDir(baseCompose);

	itWithLinks(
		"does not snapshot a compose file or .env that lead out of the checkout",
		() => {
			link(`${outside()}/target.yml`, "docker-compose.yml", "file");
			link(`${outside()}/.env`, ".env", "file");

			const result = run(getBackupCurrentDeploymentCommand(baseCompose));

			expect(result.status, result.stderr).toBe(0);
			expect(existsSync(`${backupDir()}/${PRE_DEPLOY_COMPOSE_BAK}`)).toBe(
				false,
			);
			expect(existsSync(`${backupDir()}/${PRE_DEPLOY_ENV_BAK}`)).toBe(false);
		},
	);

	itWithLinks(
		"snapshots a compose file that is a link to a file of the checkout",
		() => {
			writeFileSync(`${code()}/real.yml`, "real: true\n");
			link(`${code()}/real.yml`, "docker-compose.yml", "file");

			const result = run(getBackupCurrentDeploymentCommand(baseCompose));

			expect(result.status, result.stderr).toBe(0);
			expect(
				readFileSync(`${backupDir()}/${PRE_DEPLOY_COMPOSE_BAK}`, "utf8"),
			).toBe("real: true\n");
		},
	);

	const seedSnapshots = () => {
		mkdirSync(backupDir(), { recursive: true });
		writeFileSync(`${backupDir()}/${LAST_GOOD_COMPOSE_BAK}`, "good: true\n");
		writeFileSync(`${backupDir()}/${LAST_GOOD_ENV_BAK}`, "GOOD=1\n");
	};

	itWithLinks("restores over a link without writing through it", async () => {
		seedSnapshots();
		link(`${outside()}/target.yml`, "docker-compose.yml", "file");
		link(`${outside()}/.env`, ".env", "file");
		const restore = await getRestoreAfterFailedBuildCommand(baseCompose);

		run(restore);

		expect(readFileSync(`${outside()}/target.yml`, "utf8")).toBe(OUTSIDE_TEXT);
		expect(readFileSync(`${outside()}/.env`, "utf8")).toBe(OUTSIDE_TEXT);
		expect(isLink(`${code()}/docker-compose.yml`)).toBe(false);
		expect(readFileSync(`${code()}/docker-compose.yml`, "utf8")).toBe(
			"good: true\n",
		);
		expect(readFileSync(`${code()}/.env`, "utf8")).toBe("GOOD=1\n");
	});

	itWithLinks(
		"writes nothing when the directory of the compose file leads out of the checkout",
		async () => {
			seedSnapshots();
			rmSync(`${code()}/deploy`, { recursive: true, force: true });
			link(outside(), "deploy", "junction");
			writeFileSync(`${outside()}/docker-compose.yml`, OUTSIDE_TEXT);
			const restore = await getRestoreAfterFailedBuildCommand({
				...baseCompose,
				composePath: "deploy/docker-compose.yml",
			});

			const result = run(restore);

			expect(result.stdout).toContain(COMPOSE_FILE_LINK_MESSAGE);
			expect(readFileSync(`${outside()}/docker-compose.yml`, "utf8")).toBe(
				OUTSIDE_TEXT,
			);
			expect(readFileSync(`${outside()}/.env`, "utf8")).toBe(OUTSIDE_TEXT);
		},
	);
});

describe("reading the compose file with real links", () => {
	const guardedRead = (file: string) =>
		run(
			getGuardedReadCommand({
				codeDirectory: code(),
				file,
				read: `cat '${file}'`,
			}),
		);

	itWithLinks("refuses a link out of the checkout", () => {
		link(`${outside()}/target.yml`, "docker-compose.yml", "file");
		const result = guardedRead(`${code()}/docker-compose.yml`);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(COMPOSE_FILE_LINK_MARKER);
	});

	itWithLinks(
		"refuses a file in a directory that links out of the checkout",
		() => {
			rmSync(`${code()}/deploy`, { recursive: true, force: true });
			link(outside(), "deploy", "junction");
			writeFileSync(`${outside()}/docker-compose.yml`, OUTSIDE_TEXT);
			const result = guardedRead(`${code()}/deploy/docker-compose.yml`);
			expect(result.stdout).toBe(COMPOSE_FILE_LINK_MARKER);
		},
	);

	itWithLinks("reads a file, and a link to a file of the checkout", () => {
		writeFileSync(`${code()}/real.yml`, SPEC);
		link(`${code()}/real.yml`, "docker-compose.yml", "file");
		expect(guardedRead(`${code()}/real.yml`).stdout).toBe(SPEC);
		expect(guardedRead(`${code()}/docker-compose.yml`).stdout).toBe(SPEC);
	});

	itWithLinks("lets a missing file through to the read", () => {
		const result = guardedRead(`${code()}/missing.yml`);
		expect(result.stdout).not.toContain(COMPOSE_FILE_LINK_MARKER);
	});

	itWithLinks(
		"loadDockerCompose and readComposeFile refuse a link out",
		async () => {
			link(`${outside()}/target.yml`, "docker-compose.yml", "file");
			await expect(loadDockerCompose(baseCompose)).rejects.toBeInstanceOf(
				ComposeFileLinkError,
			);
			await expect(readComposeFile(baseCompose)).rejects.toBeInstanceOf(
				ComposeFileLinkError,
			);
		},
	);

	itWithLinks(
		"loadDockerCompose reads a link to a file of the checkout",
		async () => {
			writeFileSync(`${code()}/real.yml`, SPEC);
			link(`${code()}/real.yml`, "docker-compose.yml", "file");
			const spec = await loadDockerCompose(baseCompose);
			expect(spec?.services).toHaveProperty("web");
			expect(await readComposeFile(baseCompose)).toBe(SPEC);
		},
	);

	itWithLinks("getComposeFileLinkError tells a link out from the rest", () => {
		writeFileSync(`${code()}/real.yml`, SPEC);
		link(`${outside()}/target.yml`, "out.yml", "file");
		link(`${code()}/real.yml`, "in.yml", "file");
		expect(getComposeFileLinkError(code(), `${code()}/out.yml`)).toBe(
			COMPOSE_FILE_LINK_MESSAGE,
		);
		expect(getComposeFileLinkError(code(), `${code()}/in.yml`)).toBeNull();
		expect(getComposeFileLinkError(code(), `${code()}/real.yml`)).toBeNull();
		expect(getComposeFileLinkError(code(), `${code()}/missing.yml`)).toBeNull();
	});
});
