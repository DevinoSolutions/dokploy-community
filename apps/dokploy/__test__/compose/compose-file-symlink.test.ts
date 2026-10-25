import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
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
	getBuildComposeCommand,
	getComposeBackupDir,
	getCreateEnvFileCommand,
	getRestoreAfterFailedBuildCommand,
	LAST_GOOD_COMPOSE_BAK,
	LAST_GOOD_ENV_BAK,
	PRE_DEPLOY_COMPOSE_BAK,
	PRE_DEPLOY_ENV_BAK,
} from "@dokploy/server/utils/builders/compose";
import {
	ATOMIC_PUT_FUNCTION,
	COMPOSE_FILE_LINK_MARKER,
	COMPOSE_FILE_LINK_MESSAGE,
	ComposeFileLinkError,
	getComposeFileLinkError,
	getGuardedReadCommand,
	MV_REFUSAL_MESSAGE,
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

	it("renames a temporary file over the compose file instead of writing it in place", async () => {
		const command = await install("docker-compose.yml");
		expect(command).toContain("__dokploy_put() {");
		expect(command).toContain(
			`__dokploy_put ${REMOTE}/.dokploy-compose-dep-1.yml ${REMOTE}/code/docker-compose.yml ${REMOTE}/code`,
		);
		// No redirect into the file, no `rm` of a link beforehand (both race).
		expect(command).not.toContain(`> ${REMOTE}/code/docker-compose.yml`);
		expect(command).not.toContain("[ -L");
		expect(command).toContain(COMPOSE_FILE_LINK_MESSAGE);
		// The staged compose is removed when the write fails.
		expect(command).toMatch(
			new RegExp(`|| { rm -f ${REMOTE}/.dokploy-compose-dep-1.yml; echo `),
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
		const put = /__dokploy_put (?!\(\))(.*?) (.*?) (\S+) &&/.exec(command);
		expect(put).not.toBeNull();
		expect(words(`echo ${put?.[1]}`)).toEqual([
			"echo",
			`${REMOTE}/.dokploy-compose-dep-1.yml`,
		]);
		expect(words(`echo ${put?.[2]}`)).toEqual(["echo", file]);
		expect(put?.[3]).toBe(`${REMOTE}/code`);
	});

	it("writes the .env next to the compose file the same way", async () => {
		const command = await getCreateEnvFileCommand(
			{
				...baseCompose,
				composePath: "deploy/docker-compose.yml",
				createEnvFile: true,
				serverId: "srv-1",
			},
			{ deploymentId: "dep-1" },
		);
		expect(command).toContain(
			`__dokploy_put ${REMOTE}/.dokploy-stage-env-dep-1 ${REMOTE}/code/deploy/.env ${REMOTE}/code`,
		);
		expect(command).not.toContain(`> ${REMOTE}/code/deploy/.env`);
	});

	it("snapshots only a compose file and .env that resolve inside the checkout", () => {
		const command = getBackupCurrentDeploymentCommand({
			...baseCompose,
			serverId: "srv-1",
		});
		expect(command).toContain(
			`if [ -f ${REMOTE}/code/docker-compose.yml ]; then if __dokploy_inside ${REMOTE}/code ${REMOTE}/code/docker-compose.yml; then cp `,
		);
		expect(command).toContain(
			`if [ -f ${REMOTE}/code/.env ]; then if __dokploy_inside ${REMOTE}/code ${REMOTE}/code/.env; then cp `,
		);
	});

	it("keeps the previous snapshot when the host cannot resolve links", () => {
		const command = getBackupCurrentDeploymentCommand({
			...baseCompose,
			serverId: "srv-1",
		});
		// The unresolvable branch is checked before the one that drops a backup.
		expect(command).toContain("__dokploy_no_resolve=1");
		expect(command).toMatch(
			/elif \[ "\$__dokploy_no_resolve" = "1" \]; then echo .*the previous snapshot is kept.*; else echo "No previous compose file found"; rm -f /,
		);
	});

	it("persists the last-good .env only when it resolves inside the checkout", async () => {
		const command = await getBuildComposeCommand({
			...baseCompose,
			serverId: "srv-1",
		});
		expect(command).toContain(
			`[ -f ${REMOTE}/code/.env ] && __dokploy_inside ${REMOTE}/code ${REMOTE}/code/.env && cp ${REMOTE}/code/.env ${REMOTE}/.deploy-backup/last-good-env.bak`,
		);
		expect(command).toContain('[ "$__dokploy_no_resolve" = "1" ] || rm -f ');
	});

	it("restores through a renamed temporary file, and not at all out of the checkout", async () => {
		const command = await getRestoreAfterFailedBuildCommand({
			...baseCompose,
			serverId: "srv-1",
		});
		expect(command).toContain(
			`__dokploy_dir_inside ${REMOTE}/code ${REMOTE}/code`,
		);
		expect(command).toContain(
			`__dokploy_put ${REMOTE}/.deploy-backup/last-good-docker-compose.yml.bak ${REMOTE}/code/docker-compose.yml ${REMOTE}/code`,
		);
		expect(command).not.toContain(`cp ${REMOTE}/.deploy-backup/last-good`);
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

// ---------------------------------------------------------------------------
// A link swapped in while the file is written
// ---------------------------------------------------------------------------

describe("writing while a link is swapped in", () => {
	// A container that has the code directory mounted read-write can re-create
	// the link at any moment, also between a check and the write. The writes
	// rename a temporary file over the name, so none of them reaches the target.
	// A Windows shell starts processes slowly, so it runs fewer trials.
	const TRIALS = process.platform === "win32" ? 15 : 100;
	const RESTORE_TRIALS = process.platform === "win32" ? 6 : 100;
	const raceEnv = { ...process.env, MSYS: "winsymlinks:nativestrict" };
	const raceScript = (write: string, trials: number) => `
D=${JSON.stringify(tmp)}
code="$D/compose/link-app/code"; out="$D/outside"
printf 'staged: true\\n' > "$D/staged.yml"
( while :; do ln -sf "$out/target.yml" "$code/docker-compose.yml"; done ) >/dev/null 2>&1 &
attacker=$!
trap 'kill "$attacker" 2>/dev/null' EXIT
hits=0; i=0
while [ "$i" -lt ${trials} ]; do
  printf 'outside: untouched\\n' > "$out/target.yml"
  ${write}
  [ "$(cat "$out/target.yml")" = 'outside: untouched' ] || hits=$((hits + 1))
  i=$((i + 1))
done
kill "$attacker" 2>/dev/null
echo "HITS=$hits"
`;
	const runRace = (write: string, trials = TRIALS) => {
		const file = `${tmp}/race.sh`;
		writeFileSync(file, raceScript(write, trials));
		return spawnSync("sh", [file], {
			encoding: "utf8",
			env: raceEnv,
			timeout: 120_000,
		});
	};

	// `ln -sf` makes a copy, not a link, in Git Bash without developer mode.
	const raceWorks = (() => {
		if (!linksWork) return false;
		const probe = mkdtempSync(`${tempBase()}/.dokploy-race-probe-`).replaceAll(
			"\\",
			"/",
		);
		try {
			writeFileSync(`${probe}/a`, "x");
			const result = spawnSync(
				"sh",
				["-c", 'ln -sf "$1/a" "$1/b" && [ -L "$1/b" ]', "sh", probe],
				{ encoding: "utf8", env: raceEnv },
			);
			return result.status === 0;
		} catch {
			return false;
		} finally {
			rmSync(probe, { recursive: true, force: true });
		}
	})();
	const itRace = (name: string, fn: () => void | Promise<void>) =>
		it.skipIf(!raceWorks)(name, { timeout: 120_000 }, fn);

	itRace("the compose file install never writes through the link", () => {
		const snippet = getInstallStagedComposeCommand(
			`${tmp}/staged.yml`,
			`${code()}/docker-compose.yml`,
			[],
			code(),
		);
		// The snippet removes its staged file, so the script keeps a copy of it.
		const result = runRace(
			`cp "$D/staged.yml" "$D/staged.keep"\n{\n${snippet}\n} 2>/dev/null\ncp "$D/staged.keep" "$D/staged.yml"`,
		);
		expect(result.stdout, result.stderr).toContain("HITS=0");
	});

	itRace("the restore never writes through the link", async () => {
		const backup = getComposeBackupDir(baseCompose);
		mkdirSync(backup, { recursive: true });
		writeFileSync(`${backup}/${LAST_GOOD_COMPOSE_BAK}`, "good: true\n");
		const restore = await getRestoreAfterFailedBuildCommand(baseCompose);
		// A stub stands in for docker: only the file writes are of interest.
		const stubs = `${tmp}/stubs`;
		mkdirSync(stubs, { recursive: true });
		writeFileSync(`${stubs}/docker`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const result = runRace(
			`export PATH='${stubs}':"$PATH"\n( ${restore}\n) >/dev/null 2>&1`,
			RESTORE_TRIALS,
		);
		expect(result.stdout, result.stderr).toContain("HITS=0");
	});

	// The destination name flips between a non-empty real directory (which makes
	// `mv -T` fail) and a link to a directory outside the checkout (which a plain
	// `mv` would move the file into). Nothing may land outside, and no temporary
	// file may stay behind.
	itRace(
		"a name flipping between a directory and a link out leaves nothing outside",
		() => {
			const snippet = getInstallStagedComposeCommand(
				`${tmp}/staged.yml`,
				`${code()}/docker-compose.yml`,
				[],
				code(),
			);
			const trials = process.platform === "win32" ? 12 : 100;
			const file = `${tmp}/flip.sh`;
			writeFileSync(
				file,
				[
					`D=${JSON.stringify(tmp)}`,
					`code="$D/compose/link-app/code"; out="$D/outside"`,
					`printf 'staged: true\\n' > "$D/staged.yml"`,
					`rm -f "$code/docker-compose.yml"`,
					"( while :; do",
					`    rm -rf "$code/docker-compose.yml"; mkdir -p "$code/docker-compose.yml/keep"`,
					`    rm -rf "$code/docker-compose.yml"; ln -sfn "$out" "$code/docker-compose.yml"`,
					"  done ) >/dev/null 2>&1 &",
					"attacker=$!",
					`trap 'kill "$attacker" 2>/dev/null' EXIT`,
					"i=0",
					`while [ "$i" -lt ${trials} ]; do`,
					`  cp "$D/staged.yml" "$D/staged.keep"`,
					// A failed install ends its script with `exit 1`: run it in a subshell.
					"  (",
					snippet,
					"  ) >/dev/null 2>&1",
					`  cp "$D/staged.keep" "$D/staged.yml"`,
					"  i=$((i + 1))",
					"done",
					`kill "$attacker" 2>/dev/null`,
					`echo "OUTSIDE=$(ls -A "$out" | tr '\\n' ' ')"`,
					`echo "TEMPS=$(ls -A "$code" | grep -c '^\\.dokploy-put-')"`,
				].join("\n"),
			);
			const result = spawnSync("sh", [file], {
				encoding: "utf8",
				env: raceEnv,
				timeout: 120_000,
			});
			expect(result.stdout, result.stderr).toContain("OUTSIDE=.env target.yml");
			expect(result.stdout, result.stderr).toContain("TEMPS=0");
		},
	);

	// The old sequence can be hit, but only by chance, so the control retries a
	// few rounds until it is.
	itRace(
		"the in-place sequence they replace does go through the link (control)",
		() => {
			let hits = 0;
			for (let round = 0; round < 6 && hits === 0; round++) {
				const result = runRace(
					`{ if [ -L "$code/docker-compose.yml" ]; then rm -f "$code/docker-compose.yml"; fi && cat "$D/staged.yml" > "$code/docker-compose.yml"; } 2>/dev/null`,
				);
				hits = Number(/HITS=(\d+)/.exec(result.stdout)?.[1] ?? "0");
			}
			expect(hits).toBeGreaterThan(0);
		},
	);
});

describe("putting a file in place in a real shell", () => {
	const put = (source: string, destination: string, codeDirectory = code()) =>
		run(
			`${ATOMIC_PUT_FUNCTION}\n__dokploy_put '${source}' '${destination}' '${codeDirectory}'`,
		);
	const leftovers = () =>
		readdirSync(code()).filter((name) => name.startsWith(".dokploy-put-"));
	const itWithShell = it.skipIf(shells.length === 0);

	itWithShell("keeps no temporary file behind", () => {
		writeFileSync(`${tmp}/staged.yml`, SPEC);
		const result = put(`${tmp}/staged.yml`, `${code()}/docker-compose.yml`);
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(`${code()}/docker-compose.yml`, "utf8")).toBe(SPEC);
		expect(leftovers()).toEqual([]);
	});

	itWithShell(
		"leaves the old file and no temporary file when the source cannot be read",
		() => {
			writeFileSync(`${code()}/docker-compose.yml`, "old: true\n");
			const result = put(`${tmp}/missing.yml`, `${code()}/docker-compose.yml`);
			expect(result.status).not.toBe(0);
			expect(readFileSync(`${code()}/docker-compose.yml`, "utf8")).toBe(
				"old: true\n",
			);
			expect(leftovers()).toEqual([]);
		},
	);

	it.skipIf(shells.length === 0 || process.platform === "win32")(
		"gives the new file the mode of the one it replaces, 644 otherwise",
		() => {
			writeFileSync(`${tmp}/staged.yml`, SPEC);
			writeFileSync(`${code()}/docker-compose.yml`, "old: true\n");
			chmodSync(`${code()}/docker-compose.yml`, 0o640);
			put(`${tmp}/staged.yml`, `${code()}/docker-compose.yml`);
			expect(statSync(`${code()}/docker-compose.yml`).mode & 0o777).toBe(0o640);
			put(`${tmp}/staged.yml`, `${code()}/fresh.yml`);
			expect(statSync(`${code()}/fresh.yml`).mode & 0o777).toBe(0o644);
		},
	);

	itWithLinks("refuses a destination directory that leads out", () => {
		rmSync(`${code()}/deploy`, { recursive: true, force: true });
		link(outside(), "deploy", "junction");
		writeFileSync(`${tmp}/staged.yml`, SPEC);
		const result = put(
			`${tmp}/staged.yml`,
			`${code()}/deploy/docker-compose.yml`,
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(COMPOSE_FILE_LINK_MESSAGE);
		expect(existsSync(`${outside()}/docker-compose.yml`)).toBe(false);
	});

	itWithLinks("refuses a name that is a link to a directory", () => {
		writeFileSync(`${tmp}/staged.yml`, SPEC);
		link(outside(), "docker-compose.yml", "junction");
		const result = put(`${tmp}/staged.yml`, `${code()}/docker-compose.yml`);
		expect(result.status).not.toBe(0);
		expect(readdirSync(outside()).sort()).toEqual([".env", "target.yml"]);
	});

	// A host whose `mv` cannot rename over the name (here: one without `-T`) is
	// refused, never served by a plain `mv`, which would follow a directory link.
	itWithShell("refuses when mv -T fails, and leaves no temporary file", () => {
		writeFileSync(`${tmp}/staged.yml`, SPEC);
		writeFileSync(`${code()}/docker-compose.yml`, "old: true\n");
		const stubs = `${tmp}/mvstub`;
		mkdirSync(stubs, { recursive: true });
		// Any mv that is given -T fails; a plain mv would work, and must not run.
		writeFileSync(
			`${stubs}/mv`,
			'#!/bin/sh\nfor a in "$@"; do [ "$a" = "-T" ] && exit 1; done\necho PLAIN_MV >> "$0.log"\nexec /bin/mv "$@"\n',
			{ mode: 0o755 },
		);
		const result = run(
			`PATH='${stubs.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`)}':"$PATH"\n${ATOMIC_PUT_FUNCTION}\n__dokploy_put '${tmp}/staged.yml' '${code()}/docker-compose.yml' '${code()}'`,
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(MV_REFUSAL_MESSAGE);
		expect(readFileSync(`${code()}/docker-compose.yml`, "utf8")).toBe(
			"old: true\n",
		);
		expect(leftovers()).toEqual([]);
		expect(existsSync(`${stubs}/mv.log`)).toBe(false);
	});
});

describe("a whole deploy script with a link as the .env", () => {
	// The script runs in a real shell with a stub in place of docker.
	const deploy = async (overrides: Record<string, unknown> = {}) => {
		const stubs = `${tmp}/stubs`;
		mkdirSync(stubs, { recursive: true });
		writeFileSync(`${stubs}/docker`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const command = await getBuildComposeCommand(
			{ ...baseCompose, ...overrides },
			{ deploymentId: "dep-1" },
		);
		const file = `${tmp}/deploy.sh`;
		writeFileSync(file, `set -e\n${command}`);
		return spawnSync("sh", [file], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
		});
	};
	const backupDir = () => getComposeBackupDir(baseCompose);

	itWithLinks(
		"does not copy a .env that leads out of the checkout into the last-good snapshot",
		async () => {
			writeFileSync(`${code()}/docker-compose.yml`, SPEC);
			link(`${outside()}/.env`, ".env", "file");

			const result = await deploy({ createEnvFile: false });

			expect(result.stdout, result.stderr).toContain("Docker Compose Deployed");
			expect(
				readFileSync(`${backupDir()}/${LAST_GOOD_COMPOSE_BAK}`, "utf8"),
			).toContain("image: nginx");
			expect(existsSync(`${backupDir()}/${LAST_GOOD_ENV_BAK}`)).toBe(false);
			expect(readFileSync(`${outside()}/.env`, "utf8")).toBe(OUTSIDE_TEXT);
		},
	);

	itWithLinks("snapshots an ordinary .env as before", async () => {
		writeFileSync(`${code()}/docker-compose.yml`, SPEC);
		writeFileSync(`${code()}/.env`, "KEEP=1\n");

		const result = await deploy({ createEnvFile: false });

		expect(result.stdout, result.stderr).toContain("Docker Compose Deployed");
		expect(readFileSync(`${backupDir()}/${LAST_GOOD_ENV_BAK}`, "utf8")).toBe(
			"KEEP=1\n",
		);
	});
});

describe("the snapshot on a host that cannot resolve links", () => {
	const WITHOUT_EITHER = "realpath() { return 1; }\nreadlink() { return 1; }";
	const backupDir = () => getComposeBackupDir(baseCompose);

	it.skipIf(shells.length === 0)(
		"keeps the previous snapshot and says so",
		() => {
			writeFileSync(`${code()}/docker-compose.yml`, "new: true\n");
			mkdirSync(backupDir(), { recursive: true });
			writeFileSync(
				`${backupDir()}/${PRE_DEPLOY_COMPOSE_BAK}`,
				"previous: true\n",
			);

			const result = run(
				`${WITHOUT_EITHER}\n${getBackupCurrentDeploymentCommand(baseCompose)}`,
			);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("the previous snapshot is kept");
			expect(
				readFileSync(`${backupDir()}/${PRE_DEPLOY_COMPOSE_BAK}`, "utf8"),
			).toBe("previous: true\n");
		},
	);
});
