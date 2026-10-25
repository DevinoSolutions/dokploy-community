import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The override files of a custom command (`-f`), and the `.env` of the
// project directory, are read by Dokploy from the repository's checkout. Like
// the compose file (T-7857), they are read only inside the code directory: a
// link in the repository, or an absolute path, must not make Dokploy read a
// file of the host or of another compose (T-8413).

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

import { assertComposeVolumesBound } from "@dokploy/server/services/compose-volume-binding";
import {
	COMPOSE_FILE_LINK_MARKER,
	COMPOSE_FILE_LINK_MESSAGE,
	COMPOSE_FILE_NOT_REGULAR_MARKER,
	COMPOSE_FILE_NOT_REGULAR_MESSAGE,
	COMPOSE_FILE_OUTSIDE_MARKER,
	COMPOSE_FILE_OUTSIDE_MESSAGE,
	ComposeFileLinkError,
} from "@dokploy/server/utils/compose-file-guard";

const SPEC = "services:\n  web:\n    image: nginx\n";
const OVERRIDE = 'services:\n  web:\n    environment:\n      DEBUG: "1"\n';
const OUTSIDE_TEXT = "outside: untouched\n";
// What an override file of the host would put in a message if it were read.
const OUTSIDE_SECRET = "services:\n  web:\n    image: leaked-host-file\n";

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

// A FIFO has to be a real one: the cases run where `mkfifo` makes a file the
// shell sees as a pipe (Git Bash does; Node on Windows does not see it as one,
// so the local read is tested on Linux and macOS only).
const fifosWork = (() => {
	if (shells.length === 0) return false;
	const probe = mkdtempSync(`${tempBase()}/.dokploy-fifo-probe-`).replaceAll(
		"\\",
		"/",
	);
	try {
		return (
			spawnSync("mkfifo", [`${probe}/fifo`]).status === 0 &&
			spawnSync("sh", ["-c", '[ -p "$1/fifo" ]', "sh", probe]).status === 0
		);
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();
const itWithFifos = (remote: boolean) =>
	it.skipIf(!fifosWork || (!remote && process.platform === "win32"));

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
const itWithShell = it.skipIf(shells.length === 0);

const APP = "override-app";
let tmp = "";
const code = () => `${tmp}/compose/${APP}/code`;
const outside = () => `${tmp}/outside`;
const shellCode = () => `${shellPath(tmp)}/compose/${APP}/code`;

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

// A remote host that is the local shell.
const runInShell = async (_serverId: string, command: string) => {
	// A read that blocks (a FIFO) must fail the test, not hang it.
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

const withOverride = (file: string, serverId: string | null = null) => ({
	...baseCompose,
	serverId,
	command: `compose -p ${APP} -f docker-compose.yml -f ${file} up -d`,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsyncRemote.mockImplementation(runInShell);
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = mkdtempSync(`${tempBase()}/.dokploy-override-`).replaceAll("\\", "/");
	mocks.base.local = `${tmp}/compose`;
	mocks.base.remote = `${shellPath(tmp)}/compose`;
	mkdirSync(`${code()}/deploy`, { recursive: true });
	mkdirSync(outside(), { recursive: true });
	writeFileSync(`${outside()}/override.yml`, OUTSIDE_SECRET);
	writeFileSync(`${outside()}/.env`, OUTSIDE_TEXT);
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const refusal = async (
	promise: Promise<unknown>,
	message = COMPOSE_FILE_LINK_MESSAGE,
) => {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error, String((error as Error)?.message)).toBeInstanceOf(ComposeFileLinkError);
	// A clear refusal, and never what the file holds.
	expect((error as Error).message).toContain(message);
	expect((error as Error).message).not.toContain("leaked-host-file");
	expect((error as Error).message).not.toContain("untouched");
	return error as Error;
};

// ---------------------------------------------------------------------------
// The command a remote host is sent, with a mocked host
// ---------------------------------------------------------------------------

describe("an override file read on a remote host", () => {
	it("is read through the guarded read, and a link out is a refusal", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: COMPOSE_FILE_LINK_MARKER,
			stderr: "",
		});
		await refusal(
			assertComposeVolumesBound(withOverride("override.yml", "srv-1")),
		);
		const [serverId, command] = mocks.execAsyncRemote.mock.calls[0] as [
			string,
			string,
		];
		expect(serverId).toBe("srv-1");
		expect(command).toContain(
			`__dokploy_inside ${mocks.base.remote}/${APP}/code ${mocks.base.remote}/${APP}/code/override.yml`,
		);
		// The files directory of the compose is the second place.
		expect(command).toContain(
			`__dokploy_inside ${mocks.base.remote}/${APP}/files ${mocks.base.remote}/${APP}/code/override.yml`,
		);
		// Only a regular file is read.
		expect(command).toContain(
			`if [ -f ${mocks.base.remote}/${APP}/code/override.yml ]; then cat ${mocks.base.remote}/${APP}/code/override.yml;`,
		);
		expect(command).toContain(COMPOSE_FILE_LINK_MARKER);
		expect(command).toContain(COMPOSE_FILE_OUTSIDE_MARKER);
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.objectContaining({ composeId: "c1" }),
			expect.stringContaining("an override file leaves the code directory"),
		);
	});

	it("says where the file is when it is not a link", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: COMPOSE_FILE_OUTSIDE_MARKER,
			stderr: "",
		});
		const error = await refusal(
			assertComposeVolumesBound(withOverride("override.yml", "srv-1")),
			COMPOSE_FILE_OUTSIDE_MESSAGE,
		);
		expect(error.message).not.toContain("symbolic link");
	});

	it("says so when the file is not a regular file", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: COMPOSE_FILE_NOT_REGULAR_MARKER,
			stderr: "",
		});
		await refusal(
			assertComposeVolumesBound(withOverride("override.yml", "srv-1")),
			COMPOSE_FILE_NOT_REGULAR_MESSAGE,
		);
	});

	it("still reads an ordinary override file", async () => {
		mocks.execAsyncRemote.mockResolvedValue({ stdout: OVERRIDE, stderr: "" });
		await expect(
			assertComposeVolumesBound(withOverride("override.yml", "srv-1")),
		).resolves.toBeUndefined();
	});

	it("keeps the old refusal for a file that cannot be read", async () => {
		mocks.execAsyncRemote.mockRejectedValue(new Error("exit 1"));
		await expect(
			assertComposeVolumesBound(withOverride("override.yml", "srv-1")),
		).rejects.toThrow(/could not be read/);
	});
});

describe("the .env of the project directory read on a remote host", () => {
	it("is read through the guarded read, and a link out is a refusal", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: COMPOSE_FILE_LINK_MARKER,
			stderr: "",
		});
		await refusal(
			assertComposeVolumesBound({ ...baseCompose, serverId: "srv-1" }),
		);
		const [, command] = mocks.execAsyncRemote.mock.calls[0] as [string, string];
		expect(command).toContain(
			`__dokploy_inside ${mocks.base.remote}/${APP}/code ${mocks.base.remote}/${APP}/code/.env`,
		);
		expect(command).toContain("head -c 1048577");
	});

	it("still reads an ordinary .env", async () => {
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "A=1\n", stderr: "" });
		await expect(
			assertComposeVolumesBound({ ...baseCompose, serverId: "srv-1" }),
		).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Real links, real shell (remote) and real filesystem (local)
// ---------------------------------------------------------------------------

describe.each([
	["a remote host", "srv-1"],
	["this host", null],
] as const)("on %s, with real links", (_name, serverId) => {
	// The absolute form a command names: a POSIX path, also on Windows.
	const posixPath = (path: string) => path.replace(/^[A-Za-z]:/, "");
	const where = () => (serverId ? shellCode() : posixPath(code()));
	
	itWithLinks("refuses an override file that is a link out", async () => {
		link(`${outside()}/override.yml`, "override.yml", "file");
		await refusal(
			assertComposeVolumesBound(withOverride("override.yml", serverId)),
		);
	});

	itWithLinks(
		"refuses an override file in a directory that is a link out",
		async () => {
			rmSync(`${code()}/deploy`, { recursive: true, force: true });
			link(outside(), "deploy", "junction");
			await refusal(
				assertComposeVolumesBound(
					withOverride("deploy/override.yml", serverId),
				),
			);
		},
	);

	it("reads an override file of the files directory of the compose", async () => {
		// Where Dokploy writes the file mounts, reached as `../files/...`.
		mkdirSync(`${code()}/../files`, { recursive: true });
		writeFileSync(`${code()}/../files/override.yml`, OVERRIDE);
		await expect(
			assertComposeVolumesBound(withOverride("../files/override.yml", serverId)),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(
				withOverride(`${where()}/../files/override.yml`, serverId),
			),
		).resolves.toBeUndefined();
	});

	itWithLinks(
		"refuses an override file of the files directory that is a link out",
		async () => {
			mkdirSync(`${code()}/../files`, { recursive: true });
			const place = `${code()}/../files/override.yml`;
			symlinkSync(
				relative(dirname(place), `${outside()}/override.yml`),
				place,
				"file",
			);
			await refusal(
				assertComposeVolumesBound(
					withOverride("../files/override.yml", serverId),
				),
			);
		},
	);

	itWithLinks(
		"refuses an override file in a directory of files/ that is a link out",
		async () => {
			mkdirSync(`${code()}/../files`, { recursive: true });
			symlinkSync(outside(), `${code()}/../files/linked`, "junction");
			await refusal(
				assertComposeVolumesBound(
					withOverride("../files/linked/override.yml", serverId),
				),
			);
		},
	);

	it("refuses an override file in the project directory, beside code/ and files/, and says so", async () => {
		writeFileSync(`${code()}/../override.yml`, OVERRIDE);
		const error = await refusal(
			assertComposeVolumesBound(withOverride("../override.yml", serverId)),
			COMPOSE_FILE_OUTSIDE_MESSAGE,
		);
		// No link is involved: the message must not send anyone looking for one.
		expect(error.message).not.toContain("symbolic link");
	});

	it("refuses an existing file when the code directory is not there", async () => {
		// The remote guard needs the directory to exist; this host agrees.
		writeFileSync(`${code()}/../override.yml`, OVERRIDE);
		rmSync(code(), { recursive: true, force: true });
		await refusal(
			assertComposeVolumesBound(withOverride("../override.yml", serverId)),
			COMPOSE_FILE_OUTSIDE_MESSAGE,
		);
	});

	it("reads from the files directory when the code directory is not there", async () => {
		rmSync(code(), { recursive: true, force: true });
		mkdirSync(`${code()}/../files`, { recursive: true });
		writeFileSync(`${code()}/../files/override.yml`, OVERRIDE);
		await expect(
			assertComposeVolumesBound(withOverride("../files/override.yml", serverId)),
		).resolves.toBeUndefined();
	});

	itWithFifos(!!serverId)("refuses an override file that is a FIFO", async () => {
		expect(spawnSync("mkfifo", [`${code()}/override.yml`]).status).toBe(0);
		await refusal(
			assertComposeVolumesBound(withOverride("override.yml", serverId)),
			COMPOSE_FILE_NOT_REGULAR_MESSAGE,
		);
	});

	itWithFifos(!!serverId)("does not wait on a .env that is a FIFO", async () => {
		expect(spawnSync("mkfifo", [`${code()}/.env`]).status).toBe(0);
		// A .env that is not a regular file is not known, not read: the check
		// goes on without blocking.
		await expect(
			assertComposeVolumesBound({ ...baseCompose, serverId }),
		).resolves.toBeUndefined();
	});

	itWithLinks(
		"reads an override file, and a link to a file of the checkout",
		async () => {
			writeFileSync(`${code()}/real.yml`, OVERRIDE);
			link(`${code()}/real.yml`, "override.yml", "file");
			await expect(
				assertComposeVolumesBound(withOverride("real.yml", serverId)),
			).resolves.toBeUndefined();
			await expect(
				assertComposeVolumesBound(withOverride("override.yml", serverId)),
			).resolves.toBeUndefined();
			await expect(
				assertComposeVolumesBound(
					withOverride(`${where()}/real.yml`, serverId),
				),
			).resolves.toBeUndefined();
		},
	);

	itWithShell(
		"lets a missing override file through to its own refusal",
		async () => {
			await expect(
				assertComposeVolumesBound(withOverride("missing.yml", serverId)),
			).rejects.toThrow(/could not be read/);
		},
	);

	itWithLinks("refuses a .env that is a link out", async () => {
		link(`${outside()}/.env`, ".env", "file");
		await refusal(assertComposeVolumesBound({ ...baseCompose, serverId }));
	});

	itWithLinks(
		"refuses a .env that is a link out in a project directory",
		async () => {
			writeFileSync(`${code()}/deploy/docker-compose.yml`, OVERRIDE);
			link(`${outside()}/.env`, "deploy/.env", "file");
			await refusal(
				assertComposeVolumesBound({
					...baseCompose,
					serverId,
					command: `compose -p ${APP} --project-directory deploy -f docker-compose.yml up -d`,
				}),
			);
		},
	);

	itWithLinks(
		"reads a .env that is a link to a file of the checkout",
		async () => {
			writeFileSync(`${code()}/shared.env`, "A=1\n");
			link(`${code()}/shared.env`, ".env", "file");
			await expect(
				assertComposeVolumesBound({ ...baseCompose, serverId }),
			).resolves.toBeUndefined();
		},
	);

	itWithShell("reads a plain .env", async () => {
		writeFileSync(`${code()}/.env`, "A=1\n");
		await expect(
			assertComposeVolumesBound({ ...baseCompose, serverId }),
		).resolves.toBeUndefined();
	});
});
