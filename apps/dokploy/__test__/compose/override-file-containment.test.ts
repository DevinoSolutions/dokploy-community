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
	const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
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

const refusal = async (promise: Promise<unknown>) => {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error, String((error as Error)?.message)).toBeInstanceOf(ComposeFileLinkError);
	// A clear refusal, and never what the file holds.
	expect((error as Error).message).toContain(COMPOSE_FILE_LINK_MESSAGE);
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
		expect(command).toContain(
			`cat ${mocks.base.remote}/${APP}/code/override.yml`,
		);
		expect(command).toContain(COMPOSE_FILE_LINK_MARKER);
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.objectContaining({ composeId: "c1" }),
			expect.stringContaining("an override file leaves the code directory"),
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

	itWithLinks(
		"refuses an absolute override path outside the code directory",
		async () => {
			// Inside the compose's own directory, which the command rules allow.
			mkdirSync(`${code()}/../files`, { recursive: true });
			writeFileSync(`${code()}/../files/override.yml`, OVERRIDE);
			await refusal(
				assertComposeVolumesBound(
					withOverride(`${where()}/../files/override.yml`, serverId),
				),
			);
		},
	);

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
