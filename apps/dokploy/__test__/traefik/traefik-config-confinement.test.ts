import { spawn } from "node:child_process";
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
// `<appName>.yml`, `middlewares.yml`, `traefik.yml`), local and on a remote
// server, stays inside the Traefik directory and never follows a symlink.

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
	readRemoteConfig,
	writeAppTraefikConfig,
	writeConfig,
	writeConfigRemote,
	writeTraefikConfig,
	writeTraefikConfigRemote,
} from "@dokploy/server/utils/traefik/application";
import {
	readConfinedFile,
	remoteConfinedReadCommand,
	remoteConfinedWriteCommand,
	resolveConfinedFile,
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
// commands need a POSIX sh and a Linux realpath, so they run on Linux only.
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
			fs.writeFileSync(file, "old");
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
				expect(() => resolveConfinedFile(dynamic, name)).toThrow(
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

			it.skipIf(onWindows)(
				"is not followed when it appears after the check",
				() => {
					// The check saw no file; by the time the file is opened a link sits there.
					// O_NOFOLLOW makes the open fail instead of writing through it.
					const racePath = path.join(dynamic, "race.yml");
					plantLink("race.yml");
					const realLstat = fs.lstatSync;
					const realRealpath = fs.realpathSync;
					vi.spyOn(fs, "realpathSync").mockImplementation(((p: fs.PathLike) =>
						String(p) === racePath ? racePath : realRealpath(p)) as never);
					vi.spyOn(fs, "lstatSync").mockImplementation(((
						p: fs.PathLike,
						options?: object,
					) =>
						String(p) === racePath
							? undefined
							: realLstat(p, options as never)) as never);

					expect(() => writeConfinedFile(dynamic, "race.yml", "pwned")).toThrow(
						expect.objectContaining(rejected),
					);
					expect(() => readConfinedFile(dynamic, "race.yml")).toThrow(
						expect.objectContaining(rejected),
					);
					expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
				},
			);

			it("does not stop the app config of a second app", () => {
				plantLink("app.yml");
				writeConfig("other-app", "ok");
				expect(readConfig("other-app")).toBe("ok");
			});
		},
	);

	describe.skipIf(!canSymlink)("local: symlinked directories", () => {
		it("writes into the real directory when the dynamic directory itself is a link", () => {
			const real = path.join(root, "real-dynamic");
			fs.rmSync(dynamic, { recursive: true, force: true });
			fs.mkdirSync(real, { recursive: true });
			fs.symlinkSync(real, dynamic);

			writeConfig("app", "ok");
			expect(fs.readFileSync(path.join(real, "app.yml"), "utf8")).toBe("ok");
			expect(readConfig("app")).toBe("ok");
			fs.rmSync(dynamic, { force: true });
			fs.rmSync(real, { recursive: true, force: true });
		});

		it("works when the Traefik directory is reached through a link", () => {
			const link = path.join(root, "traefik-link");
			fs.rmSync(link, { force: true });
			fs.symlinkSync(main, link);
			state.main = link;
			writeMainConfig("ok");
			expect(fs.readFileSync(path.join(main, "traefik.yml"), "utf8")).toBe(
				"ok",
			);
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
				const odd = path.join(root, "it's a dir");
				fs.mkdirSync(odd);
				state.dynamic = odd;
				await writeConfigRemote(serverId, "app", "ok");
				expect(fs.readFileSync(path.join(odd, "app.yml"), "utf8")).toBe("ok");
				expect(await readRemoteConfig(serverId, "app")).toBe("ok");
			});

			it("leaves no temp file behind and sets mode 644", async () => {
				await writeConfigRemote(serverId, "app", "one");
				await writeConfigRemote(serverId, "app", "two");
				expect(fs.readdirSync(dynamic)).toEqual(["app.yml"]);
				expect(fs.statSync(path.join(dynamic, "app.yml")).mode & 0o777).toBe(
					0o644,
				);
			});

			it("works when the dynamic directory itself is a link", async () => {
				const real = path.join(root, "real-dynamic");
				fs.rmSync(dynamic, { recursive: true, force: true });
				fs.mkdirSync(real, { recursive: true });
				fs.symlinkSync(real, dynamic);
				await writeConfigRemote(serverId, "app", "ok");
				expect(fs.readFileSync(path.join(real, "app.yml"), "utf8")).toBe("ok");
				fs.rmSync(dynamic, { force: true });
				fs.rmSync(real, { recursive: true, force: true });
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
				expect(() => remoteConfinedReadCommand(dynamic, "../x")).toThrow();
				expect(() => remoteConfinedWriteCommand(dynamic, "a/b")).toThrow();
			});

			it("does not follow a link planted between the check and the write", async () => {
				// A shim for `chmod` (it runs after the check and before the rename)
				// swaps the target for a link to the victim, as an attacker would.
				const bin = path.join(root, "bin");
				fs.mkdirSync(bin, { recursive: true });
				fs.writeFileSync(
					path.join(bin, "chmod"),
					`#!/bin/sh\nrm -f "$RACE_TARGET"\nln -s "$RACE_VICTIM" "$RACE_TARGET"\nexec /bin/chmod "$@"\n`,
					{ mode: 0o755 },
				);
				host.env = {
					PATH: `${bin}:${process.env.PATH}`,
					RACE_TARGET: path.join(dynamic, "app.yml"),
					RACE_VICTIM: victim,
				};

				await writeConfigRemote(serverId, "app", "payload");

				expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
				expect(
					fs.lstatSync(path.join(dynamic, "app.yml")).isSymbolicLink(),
				).toBe(false);
				expect(fs.readFileSync(path.join(dynamic, "app.yml"), "utf8")).toBe(
					"payload",
				);
				fs.rmSync(bin, { recursive: true, force: true });
			});

			it("runs the generated commands under a POSIX sh with no bash features", async () => {
				const run = (command: string, stdin = "") =>
					new Promise<number | null>((resolve) => {
						const child = spawn("sh", ["-c", command]);
						child.on("close", resolve);
						child.stdin.end(stdin);
					});
				expect(
					await run(remoteConfinedWriteCommand(dynamic, "p.yml"), "x"),
				).toBe(0);
				expect(await run(remoteConfinedReadCommand(dynamic, "p.yml"))).toBe(0);
				expect(await run(remoteConfinedReadCommand(dynamic, "none.yml"))).toBe(
					96,
				);
				plantLink("l.yml");
				expect(await run(remoteConfinedReadCommand(dynamic, "l.yml"))).toBe(97);
				expect(
					await run(remoteConfinedWriteCommand(dynamic, "l.yml"), "x"),
				).toBe(97);
			});
		},
	);
});
