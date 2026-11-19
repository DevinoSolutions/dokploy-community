import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// T-6771: every read and write of a Traefik config file (the app's
// `<appName>.yml`, `middlewares.yml`, `traefik.yml`, and the files of the
// Traefik files editor), local and on a remote server, stays inside the Traefik
// directory and never follows a symlink, including a link swapped in while the
// request runs.

const state = vi.hoisted(() => ({ main: "", dynamic: "" }));

vi.mock("@dokploy/server/constants", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/constants")>()),
	paths: () => ({
		MAIN_TRAEFIK_PATH: state.main,
		DYNAMIC_TRAEFIK_PATH: state.dynamic,
	}),
}));

// The remote host is a real `sh` on this machine: the commands the helpers
// build run for real, with stdin, and a non-zero exit becomes the ExecError the
// SSH helper throws.
const host = vi.hoisted(() => ({ env: {} as Record<string, string> }));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const { spawn: spawnProcess } = await import("node:child_process");
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	return {
		...actual,
		execAsyncRemote: vi.fn(
			(
				_serverId: string,
				command: string,
				_onData?: unknown,
				options?: { stdin?: string },
			) =>
				new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
					const child = spawnProcess("sh", ["-c", command], {
						env: { ...process.env, ...host.env },
					});
					let stdout = "";
					let stderr = "";
					child.stdout.on("data", (d) => {
						stdout += d;
					});
					child.stderr.on("data", (d) => {
						stderr += d;
					});
					child.on("close", (code) => {
						if (code === 0) resolve({ stdout, stderr });
						else {
							reject(
								Object.assign(new Error(stderr), {
									name: "ExecError",
									exitCode: code,
								}),
							);
						}
					});
					child.stdin.end(options?.stdin ?? "");
				}),
		),
	};
});

import {
	createTraefikConfig,
	loadOrCreateConfig,
	loadOrCreateConfigRemote,
	readConfig,
	readConfigInPath,
	readRemoteConfig,
	writeAppTraefikConfig,
	writeConfig,
	writeConfigRemote,
	writeTraefikConfig,
	writeTraefikConfigInPath,
	writeTraefikConfigRemote,
} from "@dokploy/server/utils/traefik/application";
import {
	dynamicTraefikFile,
	readConfinedFile,
	remoteConfinedReadCommand,
	remoteConfinedWriteCommand,
	writeConfinedFile,
} from "@dokploy/server/utils/traefik/confine";
import {
	loadMiddlewares,
	loadRemoteMiddlewares,
	writeMiddleware,
} from "@dokploy/server/utils/traefik/middleware";
import {
	getCertificateResolvers,
	readMainConfig,
	updateLetsEncryptEmail,
	writeMainConfig,
} from "@dokploy/server/utils/traefik/web-server";

const rejected = { code: "BAD_REQUEST" };
// Windows runs the local checks where it can plant symlinks; the remote
// commands need a POSIX sh and /proc, and a real O_NOFOLLOW, so those run on
// Linux only.
const onWindows = process.platform === "win32";
const canSymlink = (() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "traefik-symlink-probe-"));
	try {
		fs.writeFileSync(path.join(dir, "a"), "");
		fs.symlinkSync(path.join(dir, "a"), path.join(dir, "b"));
		return true;
	} catch {
		return false;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
})();

describe("confined Traefik config files", () => {
	let root: string;
	let main: string;
	let dynamic: string;
	let outside: string;
	let victim: string;

	beforeAll(() => {
		root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "traefik-confine-")),
		);
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	beforeEach(() => {
		main = path.join(root, "traefik");
		dynamic = path.join(main, "dynamic");
		outside = path.join(root, "outside");
		victim = path.join(outside, "victim.txt");
		fs.rmSync(main, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
		fs.mkdirSync(dynamic, { recursive: true });
		fs.mkdirSync(outside);
		fs.writeFileSync(victim, "untouched");
		state.main = main;
		state.dynamic = dynamic;
		host.env = {};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const plantLink = (name: string, target = victim, dir = dynamic) =>
		fs.symlinkSync(target, path.join(dir, name));

	// A second process that keeps swapping `<dynamic>/app.yml` between a regular
	// file and a symlink to `linkTarget`, as an attacker with write access to the
	// directory would. Real links, real timing.
	const startSwapper = (linkTarget: string): ChildProcess => {
		const t = path.join(dynamic, "app.yml");
		return spawn(
			"sh",
			[
				"-c",
				`while :; do rm -f "$1"; ln -s "$2" "$1"; rm -f "$1"; echo regular > "$1"; done`,
				"swapper",
				t,
				linkTarget,
			],
			{ stdio: "ignore" },
		);
	};

	describe("a normal install", () => {
		it("reads and writes an app config, the middlewares and the main config", () => {
			writeConfig("my-app", "http: {}\n");
			expect(readConfig("my-app")).toBe("http: {}\n");
			expect(fs.readFileSync(path.join(dynamic, "my-app.yml"), "utf8")).toBe(
				"http: {}\n",
			);

			writeMiddleware({ http: { middlewares: {} } });
			expect(loadMiddlewares()).toEqual({ http: { middlewares: {} } });

			writeMainConfig("entryPoints: {}\n");
			expect(readMainConfig()).toBe("entryPoints: {}\n");
			expect(fs.readFileSync(path.join(main, "traefik.yml"), "utf8")).toBe(
				"entryPoints: {}\n",
			);
		});

		it("overwrites an existing file in place, keeping its inode", () => {
			// traefik.yml is bind-mounted as a single file into the Traefik container
			const file = path.join(main, "traefik.yml");
			fs.writeFileSync(file, "old content that is longer");
			const before = fs.statSync(file).ino;
			writeMainConfig("new");
			expect(fs.readFileSync(file, "utf8")).toBe("new");
			expect(fs.statSync(file).ino).toBe(before);
		});

		it("creates the file on a fresh install and reads a missing one as absent", () => {
			expect(readConfig("brand-new")).toBeNull();
			expect(readMainConfig()).toBeNull();
			expect(() => loadMiddlewares()).toThrow("File not found");
			expect(loadOrCreateConfig("brand-new")).toEqual({
				http: { routers: {}, services: {} },
			});

			writeTraefikConfig({ http: { routers: {}, services: {} } }, "brand-new");
			expect(fs.existsSync(path.join(dynamic, "brand-new.yml"))).toBe(true);
		});

		it("works before the Traefik directory exists (createTraefikConfig creates it)", () => {
			fs.rmSync(main, { recursive: true, force: true });
			expect(readConfig("fresh")).toBeNull();
			createTraefikConfig("fresh");
			expect(fs.existsSync(path.join(dynamic, "fresh.yml"))).toBe(true);
		});

		it("updates the Let's Encrypt email in traefik.yml", () => {
			fs.writeFileSync(
				path.join(main, "traefik.yml"),
				"certificatesResolvers:\n  letsencrypt:\n    acme:\n      email: old@example.com\n",
			);
			updateLetsEncryptEmail("new@example.com");
			expect(fs.readFileSync(path.join(main, "traefik.yml"), "utf8")).toContain(
				"new@example.com",
			);
		});

		it("rejects a file name that is not a single path component", () => {
			for (const name of ["../x.yml", "a/b.yml", "..", ".", "", "a\\b.yml"]) {
				expect(() => dynamicTraefikFile(name)).toThrow(
					expect.objectContaining(rejected),
				);
			}
			expect(() => readConfig("../../etc/passwd")).toThrow(
				expect.objectContaining(rejected),
			);
			expect(() => writeConfig("../escape", "x")).toThrow(
				expect.objectContaining(rejected),
			);
			expect(fs.existsSync(path.join(main, "escape.yml"))).toBe(false);
		});
	});

	describe("the Traefik files editor, local", () => {
		it("reads and writes a file of the directory, creating it when missing", async () => {
			const file = path.join(dynamic, "edited.yml");
			await writeTraefikConfigInPath(file, "a: 1\n");
			expect(await readConfigInPath(file)).toBe("a: 1\n");
			expect(
				await readConfigInPath(path.join(dynamic, "absent.yml")),
			).toBeNull();
		});

		it("refuses a path outside the directory, written as the attacker wrote it", async () => {
			// Raw strings, not path.join: nothing normalises the traversal away.
			const escapes = [
				`${main}/../outside/victim.txt`,
				`${dynamic}/../../outside/victim.txt`,
				`${main}-evil/x.yml`,
				victim,
			];
			for (const target of escapes) {
				await expect(readConfigInPath(target)).rejects.toMatchObject(rejected);
				await expect(
					writeTraefikConfigInPath(target, "pwned"),
				).rejects.toMatchObject(rejected);
			}
			expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
		});

		it.skipIf(!canSymlink)(
			"refuses a symlinked file and a directory link leaving the tree",
			async () => {
				plantLink("link.yml");
				plantLink("out-dir", outside, main);
				for (const target of [
					path.join(dynamic, "link.yml"),
					`${main}/out-dir/victim.txt`,
				]) {
					await expect(readConfigInPath(target)).rejects.toMatchObject(
						rejected,
					);
					await expect(
						writeTraefikConfigInPath(target, "pwned"),
					).rejects.toMatchObject(rejected);
				}
				expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
			},
		);

		it.skipIf(onWindows)(
			"does not follow a link swapped in while the editor reads and writes",
			async () => {
				const swapper = startSwapper(victim);
				try {
					for (let i = 0; i < 300; i++) {
						const text = await readConfigInPath(
							path.join(dynamic, "app.yml"),
						).catch(() => "refused");
						expect(text).not.toBe("untouched");
						await writeTraefikConfigInPath(
							path.join(dynamic, "app.yml"),
							"pwned",
						).catch(() => undefined);
					}
				} finally {
					swapper.kill("SIGKILL");
				}
				expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
			},
			60_000,
		);
	});

	describe.skipIf(!canSymlink)(
		"local: a symlink planted in the directory",
		() => {
			it.each([
				["outside the directory", () => victim],
				["inside the directory", () => path.join(dynamic, "other.yml")],
			])("is refused for the app config, pointing %s", (_label, target) => {
				fs.writeFileSync(path.join(dynamic, "other.yml"), "other");
				plantLink("app.yml", target());

				expect(() => readConfig("app")).toThrow(
					expect.objectContaining(rejected),
				);
				expect(() => writeConfig("app", "pwned")).toThrow(
					expect.objectContaining(rejected),
				);
				expect(() => writeTraefikConfig({ http: {} }, "app")).toThrow(
					expect.objectContaining(rejected),
				);
				expect(() => loadOrCreateConfig("app")).toThrow(
					expect.objectContaining(rejected),
				);
				expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
				expect(fs.readFileSync(path.join(dynamic, "other.yml"), "utf8")).toBe(
					"other",
				);
			});

			it("names the file in the error", () => {
				plantLink("middlewares.yml");
				expect(() => loadMiddlewares()).toThrow(
					/middlewares\.yml is a symbolic link/,
				);
			});

			it("is refused for middlewares.yml, the web server config and traefik.yml", () => {
				plantLink("middlewares.yml");
				plantLink("dokploy.yml");
				plantLink("traefik.yml", victim, main);

				expect(() => loadMiddlewares()).toThrow(
					expect.objectContaining(rejected),
				);
				expect(() => writeMiddleware({ http: {} })).toThrow(
					expect.objectContaining(rejected),
				);
				expect(() => readConfig("dokploy")).toThrow(
					expect.objectContaining(rejected),
				);
				expect(() => writeConfig("dokploy", "pwned")).toThrow(
					expect.objectContaining(rejected),
				);
				expect(() => readMainConfig()).toThrow(
					expect.objectContaining(rejected),
				);
				expect(() => writeMainConfig("pwned")).toThrow(
					expect.objectContaining(rejected),
				);
				expect(() => updateLetsEncryptEmail("a@example.com")).toThrow(
					expect.objectContaining(rejected),
				);
				expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
			});

			it("is refused on creation of an app config and on the empty-config path", async () => {
				plantLink("created.yml");
				expect(() => createTraefikConfig("created")).toThrow(
					expect.objectContaining(rejected),
				);
				await writeAppTraefikConfig(
					{ http: { routers: { r: { rule: "x", service: "s" } } } },
					"created",
				).catch(() => undefined);
				expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
			});

			it("is refused when dangling", () => {
				plantLink("dangling.yml", path.join(outside, "not-there.txt"));
				expect(() => writeConfig("dangling", "pwned")).toThrow(
					expect.objectContaining(rejected),
				);
				expect(fs.existsSync(path.join(outside, "not-there.txt"))).toBe(false);
			});

			it("does not stop the app config of a second app", () => {
				plantLink("app.yml");
				writeConfig("other-app", "ok");
				expect(readConfig("other-app")).toBe("ok");
			});

			it.skipIf(onWindows)(
				"is not followed when it appears after the check",
				() => {
					// The check saw no file; by the time the file is opened a link sits there.
					// O_NOFOLLOW makes the open fail instead of writing through it.
					const file = dynamicTraefikFile("race.yml");
					plantLink("race.yml");
					const realLstat = fs.lstatSync;
					const realRealpath = fs.realpathSync;
					vi.spyOn(fs, "realpathSync").mockImplementation(((p: fs.PathLike) =>
						String(p) === file.target
							? file.target
							: realRealpath(p)) as never);
					vi.spyOn(fs, "lstatSync").mockImplementation(((
						p: fs.PathLike,
						options?: object,
					) =>
						String(p) === file.target
							? undefined
							: realLstat(p, options as never)) as never);

					expect(() => writeConfinedFile(file, "pwned")).toThrow(
						expect.objectContaining(rejected),
					);
					expect(() => readConfinedFile(file)).toThrow(
						expect.objectContaining(rejected),
					);
					expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
				},
			);

			it.skipIf(onWindows)(
				"survives a real concurrent swap of the file for a link",
				() => {
					const swapper = startSwapper(victim);
					try {
						for (let i = 0; i < 300; i++) {
							let read: string | null = null;
							try {
								read = readConfig("app");
							} catch {
								// refused
							}
							expect(read).not.toBe("untouched");
							try {
								writeConfig("app", "pwned");
							} catch {
								// refused
							}
						}
					} finally {
						swapper.kill("SIGKILL");
					}
					expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
				},
				60_000,
			);
		},
	);

	describe.skipIf(!canSymlink)("local: symlinked directories", () => {
		it("accepts a dynamic directory that is a link staying inside the Traefik tree", () => {
			const real = path.join(main, "real-dynamic");
			fs.rmSync(dynamic, { recursive: true, force: true });
			fs.mkdirSync(real);
			fs.symlinkSync(real, dynamic);

			writeConfig("app", "ok");
			expect(fs.readFileSync(path.join(real, "app.yml"), "utf8")).toBe("ok");
			expect(readConfig("app")).toBe("ok");
		});

		it("refuses a dynamic directory that is a link leaving the Traefik tree", () => {
			const real = path.join(root, "real-dynamic");
			fs.rmSync(dynamic, { recursive: true, force: true });
			fs.mkdirSync(real, { recursive: true });
			fs.symlinkSync(real, dynamic);

			expect(() => writeConfig("app", "pwned")).toThrow(
				expect.objectContaining(rejected),
			);
			expect(() => readConfig("app")).toThrow(
				expect.objectContaining(rejected),
			);
			expect(fs.readdirSync(real)).toEqual([]);
			fs.rmSync(real, { recursive: true, force: true });
		});

		it("works when the Traefik directory is reached through a link", () => {
			const link = path.join(root, "traefik-link");
			fs.rmSync(link, { force: true });
			fs.symlinkSync(main, link);
			state.main = link;
			state.dynamic = path.join(link, "dynamic");
			writeMainConfig("ok");
			writeConfig("app", "ok");
			expect(fs.readFileSync(path.join(main, "traefik.yml"), "utf8")).toBe(
				"ok",
			);
			expect(fs.readFileSync(path.join(dynamic, "app.yml"), "utf8")).toBe("ok");
			fs.rmSync(link, { force: true });
		});
	});

	describe.skipIf(onWindows)(
		"remote server: the command runs on the host",
		() => {
			const serverId = "server-1";

			it("reads and writes an app config, creating it when missing", async () => {
				await writeConfigRemote(serverId, "my-app", "http: {}\n");
				expect(fs.readFileSync(path.join(dynamic, "my-app.yml"), "utf8")).toBe(
					"http: {}\n",
				);
				expect(await readRemoteConfig(serverId, "my-app")).toBe("http: {}\n");
				expect(await readRemoteConfig(serverId, "absent")).toBeNull();

				await writeTraefikConfigRemote(
					{ http: { routers: { r: { rule: "x", service: "s" } } } },
					"other-app",
					serverId,
				);
				expect(
					fs.readFileSync(path.join(dynamic, "other-app.yml"), "utf8"),
				).toContain("rule: x");
				expect(
					(await loadOrCreateConfigRemote(serverId, "other-app")).http?.routers,
				).toBeDefined();
			});

			it("keeps quotes, newlines and shell syntax in the content verbatim", async () => {
				const content =
					"a: 'x'\nb: \"$(touch /tmp/pwn)\"\nc: `id`\n$HOME \\ end\n";
				await writeConfigRemote(serverId, "quoting", content);
				expect(readConfig("quoting")).toBe(content);
			});

			it("works for a directory name with spaces and a quote", async () => {
				const odd = path.join(main, "it's a dir");
				fs.mkdirSync(odd);
				state.dynamic = odd;
				await writeConfigRemote(serverId, "app", "ok");
				expect(fs.readFileSync(path.join(odd, "app.yml"), "utf8")).toBe("ok");
				expect(await readRemoteConfig(serverId, "app")).toBe("ok");
			});

			it("writes in place: same inode, same mode, no temp file", async () => {
				const file = path.join(dynamic, "app.yml");
				fs.writeFileSync(file, "a much longer old content", { mode: 0o600 });
				fs.chmodSync(file, 0o600);
				const before = fs.statSync(file).ino;

				await writeConfigRemote(serverId, "app", "two");

				expect(fs.readFileSync(file, "utf8")).toBe("two");
				expect(fs.statSync(file).ino).toBe(before);
				expect(fs.statSync(file).mode & 0o777).toBe(0o600);
				expect(fs.readdirSync(dynamic)).toEqual(["app.yml"]);
			});

			it("accepts a dynamic directory that is a link inside the tree, refuses one leaving it", async () => {
				const inside = path.join(main, "real-dynamic");
				fs.rmSync(dynamic, { recursive: true, force: true });
				fs.mkdirSync(inside);
				fs.symlinkSync(inside, dynamic);
				await writeConfigRemote(serverId, "app", "ok");
				expect(fs.readFileSync(path.join(inside, "app.yml"), "utf8")).toBe(
					"ok",
				);

				fs.rmSync(dynamic, { force: true });
				fs.symlinkSync(outside, dynamic);
				fs.writeFileSync(path.join(outside, "app.yml"), "outside");
				await expect(
					writeConfigRemote(serverId, "app", "pwned"),
				).rejects.toMatchObject(rejected);
				await expect(readRemoteConfig(serverId, "app")).rejects.toMatchObject(
					rejected,
				);
				expect(fs.readFileSync(path.join(outside, "app.yml"), "utf8")).toBe(
					"outside",
				);
				expect(fs.readdirSync(outside).sort()).toEqual([
					"app.yml",
					"victim.txt",
				]);
			});

			it.each([
				["outside the directory", () => victim],
				["inside the directory", () => path.join(dynamic, "other.yml")],
				["a missing file outside", () => path.join(outside, "missing.txt")],
			])("refuses a symlinked target pointing %s", async (_l, target) => {
				fs.writeFileSync(path.join(dynamic, "other.yml"), "other");
				plantLink("app.yml", target());

				await expect(
					writeConfigRemote(serverId, "app", "pwned"),
				).rejects.toMatchObject(rejected);
				await expect(
					writeTraefikConfigRemote({ http: {} }, "app", serverId),
				).rejects.toMatchObject(rejected);
				await expect(readRemoteConfig(serverId, "app")).rejects.toMatchObject(
					rejected,
				);
				await expect(
					loadOrCreateConfigRemote(serverId, "app"),
				).rejects.toMatchObject(rejected);
				await expect(
					writeConfigRemote(serverId, "app", "pwned"),
				).rejects.toThrow(/app\.yml is a symbolic link/);
				expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
				expect(fs.readFileSync(path.join(dynamic, "other.yml"), "utf8")).toBe(
					"other",
				);
				expect(fs.existsSync(path.join(outside, "missing.txt"))).toBe(false);
			});

			it("refuses a symlinked middlewares.yml and main config", async () => {
				plantLink("middlewares.yml");
				plantLink("traefik.yml", victim, main);
				await expect(loadRemoteMiddlewares(serverId)).rejects.toMatchObject(
					rejected,
				);
				await expect(
					writeTraefikConfigRemote({ http: {} }, "middlewares", serverId),
				).rejects.toMatchObject(rejected);
				// Not an error to the caller: no certificate resolvers are listed.
				expect(await getCertificateResolvers(serverId)).toEqual([]);
				expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
			});

			it("refuses a target that is a directory", async () => {
				fs.mkdirSync(path.join(dynamic, "app.yml"));
				await expect(
					writeConfigRemote(serverId, "app", "x"),
				).rejects.toMatchObject(rejected);
				expect(fs.readdirSync(path.join(dynamic, "app.yml"))).toEqual([]);
			});

			it("refuses a name that is not a plain file name before running anything", async () => {
				await expect(
					writeConfigRemote(serverId, "../escape", "x"),
				).rejects.toMatchObject(rejected);
				expect(fs.existsSync(path.join(main, "escape.yml"))).toBe(false);
				expect(() => dynamicTraefikFile("../x")).toThrow();
			});

			it("the editor reads and writes through the same confined commands", async () => {
				const file = path.join(dynamic, "edited.yml");
				await writeTraefikConfigInPath(file, "a: 1\n", serverId);
				expect(await readConfigInPath(file, serverId)).toBe("a: 1\n");
				plantLink("link.yml");
				await expect(
					readConfigInPath(path.join(dynamic, "link.yml"), serverId),
				).rejects.toMatchObject(rejected);
				await expect(
					writeTraefikConfigInPath(
						path.join(dynamic, "link.yml"),
						"x",
						serverId,
					),
				).rejects.toMatchObject(rejected);
				await expect(
					readConfigInPath(`${main}/../outside/victim.txt`, serverId),
				).rejects.toMatchObject(rejected);
				expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
			});

			// A shim for `readlink` (the command that asks the kernel what the opened
			// descriptor is) swaps the target for a link first, as an attacker would
			// between the checks and the use.
			const swapDuringCheck = (linkTarget: string) => {
				const bin = path.join(root, "bin");
				fs.mkdirSync(bin, { recursive: true });
				fs.writeFileSync(
					path.join(bin, "readlink"),
					`#!/bin/sh\nrm -f "$RACE_TARGET"\nln -s "$RACE_LINK" "$RACE_TARGET"\nexec /bin/readlink "$@"\n`,
					{ mode: 0o755 },
				);
				host.env = {
					PATH: `${bin}:${process.env.PATH}`,
					RACE_TARGET: path.join(dynamic, "app.yml"),
					RACE_LINK: linkTarget,
				};
				return () => fs.rmSync(bin, { recursive: true, force: true });
			};

			it("does not print a file a link is swapped for between the check and the read", async () => {
				fs.writeFileSync(path.join(dynamic, "app.yml"), "regular");
				const cleanup = swapDuringCheck(victim);
				await expect(readRemoteConfig(serverId, "app")).rejects.toMatchObject(
					rejected,
				);
				cleanup();
				expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
			});

			it("does not write through a link swapped in between the check and the write", async () => {
				fs.writeFileSync(path.join(dynamic, "app.yml"), "regular");
				const cleanup = swapDuringCheck(victim);
				await expect(
					writeConfigRemote(serverId, "app", "payload"),
				).rejects.toMatchObject(rejected);
				cleanup();
				expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
			});

			it("does not drop the content into a directory the target is swapped for a link to", async () => {
				fs.writeFileSync(path.join(dynamic, "app.yml"), "regular");
				const cleanup = swapDuringCheck(outside);
				await expect(
					writeConfigRemote(serverId, "app", "payload"),
				).rejects.toMatchObject(rejected);
				cleanup();
				expect(fs.readdirSync(outside)).toEqual(["victim.txt"]);
				expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
			});

			it("survives a real concurrent swap of the file for a link, on read and on write", async () => {
				const swapper = startSwapper(victim);
				const dirSwapper = startSwapper(outside);
				try {
					for (let i = 0; i < 150; i++) {
						const text = await readRemoteConfig(serverId, "app").catch(
							() => "refused",
						);
						expect(text).not.toBe("untouched");
						await writeConfigRemote(serverId, "app", "payload").catch(
							() => undefined,
						);
					}
				} finally {
					swapper.kill("SIGKILL");
					dirSwapper.kill("SIGKILL");
				}
				expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
				expect(fs.readdirSync(outside)).toEqual(["victim.txt"]);
			}, 120_000);

			it("runs the generated commands under a POSIX sh with the documented exit codes", async () => {
				const run = (command: string, stdin = "") =>
					new Promise<number | null>((resolve) => {
						const child = spawn("sh", ["-c", command]);
						child.on("close", resolve);
						child.stdin.end(stdin);
					});
				// the remote paths are the real temp ones here
				const local = (name: string) => ({
					root: main,
					target: path.join(dynamic, name),
				});
				expect(await run(remoteConfinedWriteCommand(local("p.yml")), "x")).toBe(
					0,
				);
				expect(await run(remoteConfinedReadCommand(local("p.yml")))).toBe(0);
				expect(await run(remoteConfinedReadCommand(local("none.yml")))).toBe(
					96,
				);
				plantLink("l.yml");
				expect(await run(remoteConfinedReadCommand(local("l.yml")))).toBe(97);
				expect(await run(remoteConfinedWriteCommand(local("l.yml")), "x")).toBe(
					97,
				);
			});
		},
	);
});
