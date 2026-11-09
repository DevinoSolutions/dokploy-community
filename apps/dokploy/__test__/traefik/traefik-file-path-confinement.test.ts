import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const remoteTraefikPath = "/etc/dokploy/traefik";

// The local Traefik directory moves between tests (a real temp dir, a symlink to
// it), so both the router and the input schema read it from here.
const state = vi.hoisted(() => ({ localBase: "" }));

const mocks = vi.hoisted(() => ({
	findServerById: vi.fn(),
	readDirectory: vi.fn(),
	readConfigInPath: vi.fn(),
	writeTraefikConfigInPath: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server/constants", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/constants")>()),
	paths: (isServer?: boolean) => ({
		MAIN_TRAEFIK_PATH: isServer ? "/etc/dokploy/traefik" : state.localBase,
	}),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	isRootOrganization: async () => true,
	paths: (isServer?: boolean) => ({
		MAIN_TRAEFIK_PATH: isServer ? "/etc/dokploy/traefik" : state.localBase,
	}),
	...mocks,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
}));

const { settingsRouter } = await import("@/server/api/routers/settings");

const caller = settingsRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "user@example.com", role: "member" },
} as Parameters<typeof settingsRouter.createCaller>[0]);

const write = (filePath: string, serverId?: string) =>
	caller.updateTraefikFile({
		path: filePath,
		traefikConfig: "http: {}",
		serverId,
	});

const read = (filePath: string, serverId?: string) =>
	caller.readTraefikFile({ path: filePath, serverId });

const rejected = { code: "BAD_REQUEST" };

// The remote command: a probe picks `realpath -m` (GNU) or plain `realpath`
// (BusyBox, BSD), both with the same two quoted arguments.
const probe = "if realpath -m / >/dev/null 2>&1; then realpath -m ";
const otherwise = "; else realpath ";
const end = "; fi";

// The quoted `<base> <target>` the command passes to realpath. Both branches
// must carry exactly the same arguments.
const remoteArgs = (command: string): string => {
	expect(command.startsWith(probe)).toBe(true);
	const rest = command.slice(probe.length);
	const args = rest.slice(0, (rest.length - otherwise.length - end.length) / 2);
	expect(rest).toBe(`${args}${otherwise}${args}${end}`);
	return args;
};

// The words a real shell makes of the command's realpath arguments, NUL
// separated so a word can hold a newline.
const shellWords = (command: string): string[] => {
	const printed = spawnSync(
		"sh",
		["-c", `printf '%s\\0' ${remoteArgs(command)}`],
		{ encoding: "utf8" },
	);
	return printed.stdout.split("\0").slice(0, -1);
};

// Runs the command in a real sh on a fake host, whose `realpath` is the shell
// function given. A non-zero exit becomes the ExecError the SSH helper throws.
const runOnHost = (hostRealpath: string, command: string) => {
	const ran = spawnSync("sh", ["-c", `${hostRealpath}\n${command}`], {
		encoding: "utf8",
	});
	if (ran.status !== 0) {
		throw Object.assign(new Error(ran.stderr), {
			name: "ExecError",
			exitCode: ran.status,
		});
	}
	return { stdout: ran.stdout, stderr: ran.stderr };
};

// GNU realpath -m: normalises, accepts a missing path.
const gnuRealpath = `realpath() { if [ "$1" = -m ]; then shift; else return 1; fi; for a in "$@"; do printf '%s\\n' "$a"; done; }`;
// BusyBox realpath: no -m and no --, so it reads them as file names and exits 1,
// but it still prints the paths it could resolve.
const busyboxRealpath = `realpath() { rc=0; for a in "$@"; do case "$a" in -*) echo "realpath: $a: No such file or directory" >&2; rc=1;; *) printf '%s\\n' "$a";; esac; done; return $rc; }`;
// A plain realpath that prints the given text, whatever it is asked.
const plainRealpathPrinting = (text: string) =>
	`realpath() { if [ "$1" = -m ]; then return 1; fi; printf '%b' '${text}'; }`;

describe("traefik file endpoints are confined to the Traefik config directory", () => {
	let root: string;
	let base: string;
	let realBase: string;
	let outside: string;
	let baseLink: string;
	let canSymlinkFiles = true;

	beforeAll(() => {
		root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "traefik-realpath-")),
		);
		base = path.join(root, "traefik");
		outside = path.join(root, "outside");
		baseLink = path.join(root, "traefik-link");
		fs.mkdirSync(path.join(base, "dynamic"), { recursive: true });
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(base, "dynamic/app.yml"), "http: {}");
		fs.writeFileSync(path.join(outside, "secret.yml"), "secret");
		realBase = fs.realpathSync(base);
		// Junctions need no privileges on Windows; on posix they are plain symlinks.
		fs.symlinkSync(outside, path.join(base, "escape"), "junction");
		fs.symlinkSync(
			path.join(base, "dynamic"),
			path.join(base, "alias"),
			"junction",
		);
		fs.symlinkSync(base, baseLink, "junction");
		try {
			fs.symlinkSync(
				path.join(outside, "secret.yml"),
				path.join(base, "file-link.yml"),
				"file",
			);
			fs.symlinkSync(
				path.join(outside, "missing.yml"),
				path.join(base, "dangling.yml"),
				"file",
			);
		} catch {
			// Windows without the symlink privilege: the file-symlink cases are skipped.
			canSymlinkFiles = false;
		}
	});

	afterAll(() => {
		// rmSync on a junction removes the link, not its target.
		for (const link of ["escape", "alias"]) {
			fs.rmSync(path.join(base, link), { recursive: true, force: true });
		}
		fs.rmSync(baseLink, { recursive: true, force: true });
		fs.rmSync(root, { recursive: true, force: true });
	});

	beforeEach(() => {
		vi.clearAllMocks();
		state.localBase = base;
		mocks.findServerById.mockImplementation(async (serverId: string) => ({
			serverId,
			organizationId: "org-a",
		}));
		mocks.readConfigInPath.mockResolvedValue("http: {}");
		// A remote host without symlinks: realpath -m only normalises.
		mocks.execAsyncRemote.mockImplementation(
			async (_serverId: string, command: string) => {
				return {
					stdout: `${shellWords(command)
						.map((arg) => path.posix.normalize(arg))
						.join("\n")}\n`,
					stderr: "",
				};
			},
		);
	});

	describe("local server", () => {
		it.each([
			"/etc/dokploy/.env",
			"/root/.ssh/authorized_keys",
			"../../outside.yml",
			"..",
		])("rejects writing %s and never writes", async (target) => {
			await expect(write(target)).rejects.toMatchObject(rejected);
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
		});

		it("rejects sibling directories that share the prefix and parent traversal", async () => {
			for (const target of [
				`${base}-evil/app.yml`,
				`${base}/../outside.yml`,
				path.join(outside, "secret.yml"),
			]) {
				await expect(write(target)).rejects.toMatchObject(rejected);
				await expect(read(target)).rejects.toMatchObject(rejected);
			}
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
			expect(mocks.readConfigInPath).not.toHaveBeenCalled();
		});

		it.each(["/etc/dokploy/.env", "../../outside.yml", ".."])(
			"rejects reading %s and never reads",
			async (target) => {
				await expect(read(target)).rejects.toMatchObject(rejected);
				expect(mocks.readConfigInPath).not.toHaveBeenCalled();
			},
		);

		it("passes the real path for a file inside the directory", async () => {
			const inside = path.join(base, "dynamic/app.yml");
			const expected = path.join(realBase, "dynamic/app.yml");
			await write(inside);
			await read(inside);
			await write("dynamic/app.yml");
			await read("dynamic/app.yml");

			expect(mocks.writeTraefikConfigInPath).toHaveBeenNthCalledWith(
				1,
				expected,
				"http: {}",
				undefined,
			);
			expect(mocks.readConfigInPath).toHaveBeenNthCalledWith(
				1,
				expected,
				undefined,
			);
			expect(mocks.writeTraefikConfigInPath).toHaveBeenNthCalledWith(
				2,
				expected,
				"http: {}",
				undefined,
			);
			expect(mocks.readConfigInPath).toHaveBeenNthCalledWith(
				2,
				expected,
				undefined,
			);
		});

		it("allows creating a new file under a real parent directory", async () => {
			await write("dynamic/brand-new.yml");
			await write("not/created/yet.yml");

			expect(mocks.writeTraefikConfigInPath).toHaveBeenNthCalledWith(
				1,
				path.join(realBase, "dynamic/brand-new.yml"),
				"http: {}",
				undefined,
			);
			expect(mocks.writeTraefikConfigInPath).toHaveBeenNthCalledWith(
				2,
				path.join(realBase, "not/created/yet.yml"),
				"http: {}",
				undefined,
			);
		});

		it("follows a symlink that stays inside the directory", async () => {
			await read("alias/app.yml");

			expect(mocks.readConfigInPath).toHaveBeenCalledWith(
				path.join(realBase, "dynamic/app.yml"),
				undefined,
			);
		});

		it("works when the Traefik directory itself is a symlink", async () => {
			state.localBase = baseLink;
			await write("dynamic/app.yml");
			await read(path.join(baseLink, "dynamic/app.yml"));

			const expected = path.join(realBase, "dynamic/app.yml");
			expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
				expected,
				"http: {}",
				undefined,
			);
			expect(mocks.readConfigInPath).toHaveBeenCalledWith(expected, undefined);
		});

		describe("a symlink inside the directory that points outside", () => {
			it.each([
				"escape/secret.yml",
				"escape/new-file.yml",
				"escape/not/yet/there.yml",
				"escape",
			])("rejects writing %s and never writes", async (target) => {
				await expect(write(target)).rejects.toMatchObject(rejected);
				expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
			});

			it.each(["escape/secret.yml", "escape"])(
				"rejects reading %s and never reads",
				async (target) => {
					await expect(read(target)).rejects.toMatchObject(rejected);
					expect(mocks.readConfigInPath).not.toHaveBeenCalled();
				},
			);

			it("rejects a symlinked file and a dangling symlink", async (ctx) => {
				if (!canSymlinkFiles) ctx.skip();
				await expect(read("file-link.yml")).rejects.toMatchObject(rejected);
				await expect(write("file-link.yml")).rejects.toMatchObject(rejected);
				await expect(write("dangling.yml")).rejects.toMatchObject(rejected);
				expect(mocks.readConfigInPath).not.toHaveBeenCalled();
				expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
			});
		});

		it.each([".", "dynamic/.."])(
			"rejects writing the directory itself via %j",
			async (target) => {
				await expect(write(target)).rejects.toMatchObject(rejected);
				expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
			},
		);

		it("rejects writing and reading the directory by its absolute path or through its symlink", async () => {
			for (const target of [base, `${base}${path.sep}`, baseLink]) {
				await expect(write(target)).rejects.toMatchObject(rejected);
			}
			state.localBase = baseLink;
			await expect(write(".")).rejects.toMatchObject(rejected);
			await expect(read(baseLink)).rejects.toMatchObject(rejected);
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
			expect(mocks.readConfigInPath).not.toHaveBeenCalled();
		});

		it("rejects a NUL byte in the path for both endpoints", async () => {
			await expect(write("dynamic/app.yml\0.png")).rejects.toMatchObject(
				rejected,
			);
			await expect(read("dynamic/app.yml\0.png")).rejects.toMatchObject(
				rejected,
			);
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
			expect(mocks.readConfigInPath).not.toHaveBeenCalled();
		});
	});

	describe("remote server", () => {
		const server = "server-a";
		const target = `${remoteTraefikPath}/dynamic/app.yml`;

		// What `realpath -m <base> <target>` prints on a host where the given
		// directories are symlinks.
		const hostWithSymlinks = (links: Record<string, string>) => {
			mocks.execAsyncRemote.mockImplementation(
				async (_serverId: string, command: string) => {
					const real = shellWords(command).map((arg) => {
						const link = Object.keys(links).find(
							(from) => arg === from || arg.startsWith(`${from}/`),
						);
						return link ? `${links[link]}${arg.slice(link.length)}` : arg;
					});
					return { stdout: `${real.join("\n")}\n`, stderr: "" };
				},
			);
		};

		it.each([
			"/etc/dokploy/.env",
			"/root/.ssh/authorized_keys",
			`${remoteTraefikPath}-evil/app.yml`,
			`${remoteTraefikPath}/../.env`,
			"../.env",
			"..",
		])("rejects writing %s and never writes", async (path_) => {
			await expect(write(path_, server)).rejects.toMatchObject(rejected);
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
		});

		it.each(["../.env", "..", `${remoteTraefikPath}/../.env`])(
			"rejects reading %s and never reads",
			async (path_) => {
				await expect(read(path_, server)).rejects.toMatchObject(rejected);
				expect(mocks.readConfigInPath).not.toHaveBeenCalled();
			},
		);

		it("passes the resolved posix path for a file inside the directory", async () => {
			await write("dynamic/app.yml", server);
			await read("dynamic/app.yml", server);

			expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
				target,
				"http: {}",
				server,
			);
			expect(mocks.readConfigInPath).toHaveBeenCalledWith(target, server);
		});

		it("accepts an absolute path under the remote directory for writes and reads", async () => {
			// The input schema compares absolute reads with the local directory,
			// which is the same path in production.
			state.localBase = remoteTraefikPath;
			await write(target, server);
			await read(target, server);

			expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
				target,
				"http: {}",
				server,
			);
			expect(mocks.readConfigInPath).toHaveBeenCalledWith(target, server);
		});

		it("rejects absolute reads outside the remote directory without a round trip", async () => {
			state.localBase = remoteTraefikPath;
			for (const outsidePath of [
				"/etc/dokploy/.env",
				"/root/.ssh/authorized_keys",
				`${remoteTraefikPath}-evil/app.yml`,
			]) {
				await expect(read(outsidePath, server)).rejects.toMatchObject(rejected);
			}
			expect(mocks.readConfigInPath).not.toHaveBeenCalled();
			expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		});

		it("resolves the base and the target in one realpath round trip", async () => {
			await write("dynamic/app.yml", server);

			expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
			expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
				server,
				`${probe}${remoteTraefikPath} ${target}${otherwise}${remoteTraefikPath} ${target}${end}`,
			);
		});

		it("builds a command without the -- end-of-options marker", async () => {
			await write("dynamic/app.yml", server);
			await read("dynamic/app.yml", server);

			for (const [, command] of mocks.execAsyncRemote.mock.calls as [
				string,
				string,
			][]) {
				expect(command).not.toMatch(/(^|\s)--(\s|$)/);
			}
		});

		it("quotes the path so it cannot reach the remote shell", async () => {
			const hostile = "dynamic/it's $(touch pwned); `id` | cat & x.yml";
			await write(hostile, server);

			const [, command] = mocks.execAsyncRemote.mock.calls[0] as [
				string,
				string,
			];
			// Let a real shell split the arguments: they must come back as exactly the
			// two paths, with no operator or substitution taking effect.
			const printed = spawnSync(
				"sh",
				["-c", `printf '[%s]' ${remoteArgs(command)}`],
				{ encoding: "utf8" },
			);
			expect(printed.status).toBe(0);
			expect(printed.stdout).toBe(
				`[${remoteTraefikPath}][${remoteTraefikPath}/${hostile}]`,
			);
			expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
				`${remoteTraefikPath}/${hostile}`,
				"http: {}",
				server,
			);
		});

		it("rejects a symlink inside the directory that points outside", async () => {
			hostWithSymlinks({ [`${remoteTraefikPath}/escape`]: "/root/.ssh" });

			await expect(
				write("escape/authorized_keys", server),
			).rejects.toMatchObject(rejected);
			await expect(
				read("escape/authorized_keys", server),
			).rejects.toMatchObject(rejected);
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
			expect(mocks.readConfigInPath).not.toHaveBeenCalled();
		});

		it("works when the remote Traefik directory is a symlink", async () => {
			hostWithSymlinks({ [remoteTraefikPath]: "/data/traefik" });

			await write("dynamic/app.yml", server);
			await read("dynamic/app.yml", server);

			expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
				"/data/traefik/dynamic/app.yml",
				"http: {}",
				server,
			);
			expect(mocks.readConfigInPath).toHaveBeenCalledWith(
				"/data/traefik/dynamic/app.yml",
				server,
			);
		});

		it("rejects writing the directory itself", async () => {
			await expect(write(".", server)).rejects.toMatchObject(rejected);
			await expect(write(remoteTraefikPath, server)).rejects.toMatchObject(
				rejected,
			);
			hostWithSymlinks({ [`${remoteTraefikPath}/loop`]: remoteTraefikPath });
			await expect(write("loop", server)).rejects.toMatchObject(rejected);
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
		});

		it.each([
			["nothing", ""],
			["only one path", `${remoteTraefikPath}\n`],
			["three lines", `${remoteTraefikPath}\n${target}\n/extra\n`],
			["a relative result", `${remoteTraefikPath}\ndynamic/app.yml\n`],
			[
				"an empty line between the paths",
				`${remoteTraefikPath}\n\n${target}\n`,
			],
			["a second trailing newline", `${remoteTraefikPath}\n${target}\n\n`],
		])("fails closed when the host prints %s", async (_label, stdout) => {
			mocks.execAsyncRemote.mockResolvedValue({ stdout, stderr: "" });

			await expect(write("dynamic/app.yml", server)).rejects.toMatchObject(
				rejected,
			);
			await expect(read("dynamic/app.yml", server)).rejects.toMatchObject(
				rejected,
			);
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
			expect(mocks.readConfigInPath).not.toHaveBeenCalled();
		});

		it("rejects a target whose name ends in a newline instead of stripping it", async () => {
			// realpath prints "<base>\n<target>\n\n", which is not two lines.
			await expect(write("dynamic/app.yml\n", server)).rejects.toMatchObject(
				rejected,
			);
			await expect(read("dynamic/app.yml\n", server)).rejects.toMatchObject(
				rejected,
			);
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
			expect(mocks.readConfigInPath).not.toHaveBeenCalled();
		});

		it("accepts output without a trailing newline", async () => {
			mocks.execAsyncRemote.mockResolvedValue({
				stdout: `${remoteTraefikPath}\n${target}`,
				stderr: "",
			});
			await write("dynamic/app.yml", server);

			expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
				target,
				"http: {}",
				server,
			);
		});

		it("explains a host without a usable realpath and still fails closed", async () => {
			const execError = Object.assign(new Error("realpath: not found"), {
				name: "ExecError",
				exitCode: 127,
			});
			mocks.execAsyncRemote.mockRejectedValue(execError);

			for (const run of [
				() => write("dynamic/app.yml", server),
				() => read("dynamic/app.yml", server),
			]) {
				await expect(run()).rejects.toMatchObject({
					code: "PRECONDITION_FAILED",
					message: expect.stringContaining("no usable realpath"),
				});
			}
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
			expect(mocks.readConfigInPath).not.toHaveBeenCalled();
		});

		describe("on a host shell with its own realpath", () => {
			const runWith = (hostRealpath: string) =>
				mocks.execAsyncRemote.mockImplementation(
					async (_serverId: string, command: string) =>
						runOnHost(hostRealpath, command),
				);

			it("uses GNU realpath -m when the host has it", async () => {
				runWith(gnuRealpath);

				await write("dynamic/app.yml", server);
				await read("dynamic/app.yml", server);

				expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
					target,
					"http: {}",
					server,
				);
				expect(mocks.readConfigInPath).toHaveBeenCalledWith(target, server);
				expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(2);
			});

			it("falls back to plain realpath on BusyBox in the same round trip", async () => {
				runWith(busyboxRealpath);

				await write("dynamic/app.yml", server);
				await read("dynamic/app.yml", server);

				expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
					target,
					"http: {}",
					server,
				);
				expect(mocks.readConfigInPath).toHaveBeenCalledWith(target, server);
				// One SSH command per check: no retry round trip.
				expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(2);
			});

			it("fails closed when neither realpath form works", async () => {
				runWith(
					`realpath() { echo "realpath: No such file or directory" >&2; return 1; }`,
				);

				for (const run of [
					() => write("dynamic/app.yml", server),
					() => read("dynamic/app.yml", server),
				]) {
					await expect(run()).rejects.toMatchObject({
						code: "PRECONDITION_FAILED",
						message: expect.stringContaining("no usable realpath"),
					});
				}
				expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
				expect(mocks.readConfigInPath).not.toHaveBeenCalled();
			});

			it("rejects a dangling or deeper missing path that plain realpath refuses", async () => {
				// BusyBox exits 1 when the target's parent does not exist.
				runWith(
					`realpath() { for a in "$@"; do case "$a" in -*|*/missing/*) return 1;; esac; done; printf '%s\\n' "$@"; }`,
				);

				await expect(
					write("missing/deeper/new.yml", server),
				).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
				expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
			});

			it.each([
				["one line", `${remoteTraefikPath}\\n`],
				["a relative result", `${remoteTraefikPath}\\ndynamic/app.yml\\n`],
				[
					"a result outside the directory",
					`${remoteTraefikPath}\\n/root/.ssh/authorized_keys\\n`,
				],
			])("rejects plain realpath printing %s", async (_label, printed) => {
				runWith(plainRealpathPrinting(printed));

				await expect(write("dynamic/app.yml", server)).rejects.toMatchObject(
					rejected,
				);
				await expect(read("dynamic/app.yml", server)).rejects.toMatchObject(
					rejected,
				);
				expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
				expect(mocks.readConfigInPath).not.toHaveBeenCalled();
			});
		});

		it("lets a connection failure through and still never reads or writes", async () => {
			mocks.execAsyncRemote.mockRejectedValue(new Error("connect ETIMEDOUT"));

			await expect(write("dynamic/app.yml", server)).rejects.toThrow(
				"connect ETIMEDOUT",
			);
			await expect(read("dynamic/app.yml", server)).rejects.toThrow(
				"connect ETIMEDOUT",
			);
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
			expect(mocks.readConfigInPath).not.toHaveBeenCalled();
		});

		it("does not touch the local filesystem checks for a remote path", async () => {
			state.localBase = path.join(root, "does-not-exist");
			await write("dynamic/app.yml", server);

			expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
				target,
				"http: {}",
				server,
			);
		});
	});
});
