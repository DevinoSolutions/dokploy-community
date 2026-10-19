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

// The words a real shell makes of a command line (the test paths hold no newline).
const shellWords = (command: string): string[] => {
	const printed = spawnSync("sh", ["-c", `printf '%s\n' ${command}`], {
		encoding: "utf8",
	});
	return printed.stdout.split("\n").slice(0, -1);
};

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
						.slice(3)
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

		// What `realpath -m -- <base> <target>` prints on a host where the given
		// directories are symlinks.
		const hostWithSymlinks = (links: Record<string, string>) => {
			mocks.execAsyncRemote.mockImplementation(
				async (_serverId: string, command: string) => {
					const real = shellWords(command)
						.slice(3)
						.map((arg) => {
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
				`realpath -m -- ${remoteTraefikPath} ${target}`,
			);
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
			expect(command.startsWith("realpath -m -- ")).toBe(true);
			const printed = spawnSync(
				"sh",
				["-c", `printf '[%s]' ${command.slice("realpath -m -- ".length)}`],
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
