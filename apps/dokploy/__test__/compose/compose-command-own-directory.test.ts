import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The own-directory check of the compose custom command paths resolves them on
// the deploy host, with one command per deploy (T-7845). The cases run with
// real links, a real shell as the "remote" host and the real filesystem as
// "this host".

// Each real-shell case starts a few shells, which is slow on Windows.
vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
	warn: vi.fn(),
	base: { local: "", remote: "" },
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
		// Both kinds of host point at a temp dir: the local one as Node sees it,
		// the remote one as the shell does.
		paths: (isServer = false) => ({
			...actual.paths(true),
			COMPOSE_PATH: isServer ? mocks.base.remote : mocks.base.local,
		}),
	};
});
vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsyncRemote: mocks.execAsyncRemote,
}));
vi.mock("@dokploy/server/lib/logger", () => ({
	logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@dokploy/server/utils/vault", () => ({
	withResolvedVaultRefs: async (entity: unknown) => entity,
}));

import {
	assertCommandPathsResolveInOwnDirectory,
	assertComposeVolumesBound,
	getReadableCommandOverrideFiles,
} from "@dokploy/server/services/compose-volume-binding";
import {
	getOwnDirectoryCheckCommand,
	parseOwnDirectoryVerdicts,
} from "@dokploy/server/utils/compose-own-directory";

const SPEC = "services:\n  web:\n    image: nginx\n";
const OVERRIDE = 'services:\n  web:\n    environment:\n      DEBUG: "1"\n';

const shells = ["sh"].filter(
	(shell) => spawnSync(shell, ["-c", "true"]).status === 0,
);
const tempBase = () =>
	(process.platform === "win32" ? process.cwd() : tmpdir()).replaceAll(
		"\\",
		"/",
	);
// The same directory as a POSIX shell names it (`/c/...` for Git Bash).
const shellPath = (path: string) =>
	process.platform === "win32"
		? path.replace(
				/^([A-Za-z]):/,
				(_, drive: string) => `/${drive.toLowerCase()}`,
			)
		: path;

// The links have to be real for the shell: a file link needs a privilege on
// Windows, and Git Bash does not always see it as one. The cases below run
// where both work (Linux, macOS, and a Windows with links allowed), and are
// skipped elsewhere.
const linksWork = (() => {
	if (shells.length === 0) return false;
	const probe = mkdtempSync(`${tempBase()}/.dokploy-link-probe-`).replaceAll(
		"\\",
		"/",
	);
	try {
		mkdirSync(`${probe}/dir`);
		writeFileSync(`${probe}/dir/file`, "x");
		symlinkSync(`${probe}/dir`, `${probe}/dir-link`, "junction");
		const result = spawnSync(
			"sh",
			[
				"-c",
				'[ -L "$1/dir-link" ] && [ "$(realpath -m -- "$1/dir-link/file")" = "$(realpath -m -- "$1/dir/file")" ]',
				"sh",
				shellPath(probe),
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
const itWithShell = it.skipIf(shells.length === 0);

const APP = "own-app";
const OTHER = "other-app";
let tmp = "";
const code = () => `${tmp}/compose/${APP}/code`;
const otherCode = () => `${tmp}/compose/${OTHER}/code`;

// A directory link (a junction on Windows) has to be absolute.
const dirLink = (target: string, name: string) =>
	symlinkSync(target, `${code()}/${name}`, "junction");

// A remote host that is the local shell.
const runInShell = async (_serverId: string, command: string) => {
	const result = spawnSync("sh", ["-c", command], {
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.status !== 0) {
		throw new Error(`exit ${result.status}: ${result.stderr}`);
	}
	return { stdout: result.stdout, stderr: result.stderr };
};

const baseCompose = {
	appName: APP,
	composeId: "c1",
	sourceType: "raw",
	composeFile: SPEC,
	composePath: "docker-compose.yml",
	composeType: "docker-compose",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: null,
	env: "",
	mounts: [],
	createEnvFile: false,
	buildServerId: null,
	command: "",
	domains: [],
	serviceNetworks: [],
	environment: { project: { env: "" }, env: "" },
} as any;

const withCommand = (options: string, serverId: string | null) => ({
	...baseCompose,
	serverId,
	command: `compose -p ${APP} -f docker-compose.yml ${options} up -d`,
});

// How many times the host was asked to resolve paths.
const resolutions = () =>
	mocks.execAsyncRemote.mock.calls.filter(([, command]) =>
		String(command).includes("__dokploy_verdict"),
	).length;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsyncRemote.mockImplementation(runInShell);
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = mkdtempSync(`${tempBase()}/.dokploy-own-`).replaceAll("\\", "/");
	mocks.base.local = `${tmp}/compose`;
	mocks.base.remote = `${shellPath(tmp)}/compose`;
	mkdirSync(`${code()}/real/sub`, { recursive: true });
	mkdirSync(`${code()}/../files`, { recursive: true });
	mkdirSync(otherCode(), { recursive: true });
	writeFileSync(`${otherCode()}/.env`, "SECRET=another-compose\n");
	writeFileSync(`${otherCode()}/override.yml`, OVERRIDE);
	writeFileSync(`${code()}/real/.env`, "A=1\n");
	writeFileSync(`${code()}/real/sub/.env`, "B=2\n");
	writeFileSync(`${code()}/.env`, "C=3\n");
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe.each([
	["a remote host", "srv-1"],
	["this host", null],
] as const)(
	"the custom command paths on %s, with real links",
	(_name, serverId) => {
		itWithLinks(
			"refuses an env file whose resolved path is outside the own directory",
			async () => {
				dirLink(`${tmp}/compose/${OTHER}`, "elsewhere");
				await expect(
					assertComposeVolumesBound(
						withCommand("--env-file elsewhere/code/.env", serverId),
					),
				).rejects.toThrow(
					/--env-file "elsewhere\/code\/.env" leads outside this compose's own directory .* through a symbolic link/,
				);
			},
		);

		itWithLinks("refuses a project directory behind a link out", async () => {
			dirLink(otherCode(), "elsewhere");
			// Asked directly: the deploy's own checks of the files come first.
			await expect(
				assertCommandPathsResolveInOwnDirectory(
					withCommand("--project-directory elsewhere", serverId),
				),
			).rejects.toThrow(/leads outside this compose's own directory/);
		});

		itWithLinks("refuses an override file behind a link out", async () => {
			dirLink(otherCode(), "elsewhere");
			await expect(
				assertComposeVolumesBound(
					withCommand("-f elsewhere/override.yml", serverId),
				),
			).rejects.toThrow(/refused/);
		});

		itWithLinks(
			"refuses a link in the directory of an absolute path",
			async () => {
				dirLink(otherCode(), "elsewhere");
				// Absolute for the host: a POSIX path, also on Windows.
				const absolute = `${(serverId ? mocks.base.remote : mocks.base.local).replace(/^[A-Za-z]:/, "")}/${APP}/code/elsewhere/.env`;
				await expect(
					assertComposeVolumesBound(
						withCommand(`--env-file ${absolute}`, serverId),
					),
				).rejects.toThrow(/leads outside this compose's own directory/);
			},
		);

		itWithLinks(
			"allows a link that stays inside the compose's own directory",
			async () => {
				dirLink(`${code()}/real`, "alias");
				dirLink(`${code()}/../files`, "mounts");
				await expect(
					assertComposeVolumesBound(
						withCommand(
							"--env-file alias/.env --env-file mounts/.env",
							serverId,
						),
					),
				).resolves.toBeUndefined();
				await expect(
					assertCommandPathsResolveInOwnDirectory(
						withCommand("--project-directory alias", serverId),
					),
				).resolves.toBeUndefined();
			},
		);

		// This host is only tested where the kernel resolves paths the POSIX way.
		it.skipIf(!linksWork || (!serverId && process.platform === "win32"))(
			"refuses a path whose resolved form differs from its written form",
			async () => {
				dirLink(`${code()}/real/sub`, "hop");
				await expect(
					assertComposeVolumesBound(
						withCommand("--env-file hop/../.env", serverId),
					),
				).rejects.toThrow(
					/--env-file "hop\/\.\.\/\.env" does not resolve to the place it is written as/,
				);
			},
		);

		it("allows plain paths of the compose's own directory, also ones that are not there yet", async () => {
			await expect(
				assertComposeVolumesBound(
					withCommand(
						"--env-file real/.env --env-file not-there/.env",
						serverId,
					),
				),
			).resolves.toBeUndefined();
		});
	},
);

describe("this host", () => {
	itWithLinks(
		"refuses a link whose target is missing, which cannot be resolved",
		async () => {
			dirLink(`${tmp}/nowhere`, "dangling");
			await expect(
				assertComposeVolumesBound(
					withCommand("--env-file dangling/.env", null),
				),
			).rejects.toThrow(/could not be resolved on the host/);
		},
	);
});

describe("a remote host", () => {
	itWithShell("is asked once per deploy, for every path", async () => {
		await assertComposeVolumesBound(
			withCommand(
				"--env-file real/.env --env-file real/sub/.env --env-file .env",
				"srv-1",
			),
		);
		expect(resolutions()).toBe(1);
		const command = String(
			mocks.execAsyncRemote.mock.calls.find(([, text]) =>
				String(text).includes("__dokploy_verdict"),
			)?.[1],
		);
		// Every path is quoted by the same quoting the other remote commands use.
		expect(command).toContain(
			`__dokploy_verdict ${mocks.base.remote}/${APP}/code/real/.env ${mocks.base.remote}/${APP}/code/real/.env`,
		);
		expect(
			mocks.execAsyncRemote.mock.calls.every(([id]) => id === "srv-1"),
		).toBe(true);
	});

	itWithShell("quotes a path with spaces and shell characters", () => {
		// A directory name with spaces and shell characters.
		const name = "it's a $(touch pwned) dir; x";
		mkdirSync(`${tmp}/compose/${name}/code`, { recursive: true });
		const odd = `${shellPath(tmp)}/compose/${name}`;
		const reading = (path: string) => ({ raw: path, normal: path });
		const result = spawnSync(
			"sh",
			[
				"-c",
				getOwnDirectoryCheckCommand(odd, [
					reading(`${odd}/code/.env`),
					reading(`${odd}/../out`),
				]),
			],
			{ encoding: "utf8", cwd: tmp },
		);
		expect(result.stdout.split("\n").slice(0, 3)).toEqual([
			"own:ok",
			"in",
			"out",
		]);
		// Nothing was run.
		expect(existsSync(`${tmp}/pwned`)).toBe(false);
	});

	it("refuses when the host cannot be asked", async () => {
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh down"));
		await expect(
			assertComposeVolumesBound(withCommand("--env-file real/.env", "srv-1")),
		).rejects.toThrow(
			/could not be resolved on the host this compose deploys on/,
		);
	});

	it("refuses when the host answers something else", async () => {
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "hello\n", stderr: "" });
		await expect(
			assertComposeVolumesBound(withCommand("--env-file real/.env", "srv-1")),
		).rejects.toThrow(
			/could not be resolved on the host this compose deploys on/,
		);
	});

	it("refuses when the host prints a banner before the verdicts", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "Welcome\nown:ok\nin\n",
			stderr: "",
		});
		await expect(
			assertCommandPathsResolveInOwnDirectory(
				withCommand("--env-file real/.env", "srv-1"),
			),
		).rejects.toThrow(/could not be resolved/);
		expect(parseOwnDirectoryVerdicts("Welcome\nown:ok\nin\n", 2)).toEqual([
			"unresolved",
			"unresolved",
		]);
	});

	it("refuses when the host answers with a verdict for one path only", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "own:ok\nin\n",
			stderr: "",
		});
		await expect(
			assertCommandPathsResolveInOwnDirectory(
				withCommand("--env-file real/.env --env-file .env", "srv-1"),
			),
		).rejects.toThrow(/could not be resolved/);
	});

	it("refuses an answer that says a path is outside", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "own:ok\nin\nout\nin\nin\nin\nin\n",
			stderr: "",
		});
		await expect(
			assertCommandPathsResolveInOwnDirectory(
				withCommand("--env-file real/.env --env-file .env", "srv-1"),
			),
		).rejects.toThrow(/leads outside this compose's own directory/);
	});

	it("asks for nothing when the command names no path", async () => {
		await assertCommandPathsResolveInOwnDirectory({
			...baseCompose,
			serverId: "srv-1",
			command: `compose -p ${APP} ps`,
		});
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});

describe("the shell that resolves the paths", () => {
	const run = (command: string) =>
		spawnSync("sh", ["-c", command], { encoding: "utf8" }).stdout.split("\n");

	itWithLinks("tells in, out and moved apart, with real links", () => {
		const own = `${shellPath(tmp)}/compose/${APP}`;
		dirLink(otherCode(), "elsewhere");
		dirLink(`${code()}/real/sub`, "hop");
		dirLink(`${code()}/real`, "alias");
		const reading = (path: string, normal = path) => ({
			raw: `${own}/code/${path}`,
			normal: `${own}/code/${normal}`,
		});
		const lines = run(
			getOwnDirectoryCheckCommand(own, [
				reading(".env"),
				reading("alias/.env"),
				reading("elsewhere/.env"),
				reading("hop/../.env", ".env"),
				reading("missing/deeper/.env"),
				reading("../../${OTHER}/code/.env".replace("${OTHER}", OTHER)),
			]),
		);
		expect(lines.slice(0, 7)).toEqual([
			"own:ok",
			"in",
			"in",
			"out",
			"moved",
			"in",
			"out",
		]);
	});

	itWithShell(
		"treats a host with neither realpath nor readlink as unresolved",
		() => {
			// No tool to resolve with: the functions of the shell only.
			const lines = run(
				`PATH=/nonexistent; ${getOwnDirectoryCheckCommand("/own", [
					{ raw: "/own/a", normal: "/own/a" },
				])}`,
			);
			expect(lines.slice(0, 2)).toEqual(["own:unresolved", "unresolved"]);
		},
	);

	itWithShell(
		"refuses a relative path without looping, with only readlink available",
		() => {
			// realpath is hidden, so the readlink -f fallback is the resolver.
			const result = spawnSync(
				"sh",
				[
					"-c",
					`realpath() { return 1; }; ${getOwnDirectoryCheckCommand("/own", [
						{ raw: "relative/path", normal: "relative/path" },
					])}`,
				],
				{ encoding: "utf8", timeout: 5000 },
			);
			expect(result.stdout.split("\n").slice(0, 2)).toEqual([
				"own:ok",
				"unresolved",
			]);
		},
	);

	it("reads the verdicts in order, and anything missing is unresolved", () => {
		expect(parseOwnDirectoryVerdicts("own:ok\nin\nout\nmoved\n", 5)).toEqual([
			"in",
			"out",
			"moved",
			"unresolved",
			"unresolved",
		]);
		expect(parseOwnDirectoryVerdicts("own:ok\nrm -rf /\n", 1)).toEqual([
			"unresolved",
		]);
		expect(parseOwnDirectoryVerdicts("", 0)).toEqual([]);
	});
});

describe("the override files that stay readable", () => {
	const OVERRIDES = (name: string) =>
		({
			...baseCompose,
			serverId: null,
			command: `compose -p ${APP} -f docker-compose.yml -f ${name} up -d`,
		}) as any;

	itWithLinks(
		"skips a file outside the directory and one behind a link",
		async () => {
			dirLink(otherCode(), "elsewhere");
			const link = await getReadableCommandOverrideFiles(
				OVERRIDES("elsewhere/override.yml"),
			);
			expect(link).toEqual({ files: [], skipped: 1 });
			const lexical = await getReadableCommandOverrideFiles(
				OVERRIDES(`../../${OTHER}/code/override.yml`),
			);
			expect(lexical).toEqual({ files: [], skipped: 1 });
		},
	);

	it("keeps a file of the compose's own directory", async () => {
		writeFileSync(`${code()}/override.yml`, OVERRIDE);
		expect(
			await getReadableCommandOverrideFiles(OVERRIDES("override.yml")),
		).toEqual({
			files: [
				`${mocks.base.local.replace(/^[A-Za-z]:/, "")}/${APP}/code/override.yml`,
			],
			skipped: 0,
		});
	});

	it("keeps a link to a file of the checkout, and the files directory", async () => {
		writeFileSync(`${code()}/real/o.yml`, OVERRIDE);
		dirLink(`${code()}/real`, "alias");
		const kept = await getReadableCommandOverrideFiles(
			OVERRIDES("alias/o.yml"),
			1,
		);
		expect(kept.skipped).toBe(0);
		expect(kept.files).toHaveLength(1);
		const files = await getReadableCommandOverrideFiles(
			OVERRIDES("../files/o.yml"),
		);
		expect(files.skipped).toBe(0);
	});

	it("counts the files that cannot be resolved as skipped", async () => {
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh down"));
		const result = await getReadableCommandOverrideFiles({
			...OVERRIDES("override.yml"),
			serverId: "srv-1",
		});
		expect(result).toEqual({ files: [], skipped: 1 });
	});
});
