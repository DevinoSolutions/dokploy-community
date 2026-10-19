import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildRemoteReadDirectoryCommand,
	MAX_READ_DIRECTORY_DEPTH,
	parseRemoteReadDirectory,
	readDirectory,
} from "@dokploy/server/services/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

const nul = String.fromCharCode(0);
const records = (...paths: string[]) => paths.map((p) => p + nul).join("");
const output = (dirs: string[], links: string[], others: string[]) =>
	records(...dirs, "--") + records(...links, "--") + records(...others);

const hasSh = (() => {
	try {
		execFileSync("sh", ["-c", "find . -maxdepth 0"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const runLocally = async (_serverId: string, command: string) => ({
	stdout: execFileSync("sh", ["-c", command], { encoding: "utf8" }),
	stderr: "",
});

describe("readDirectory (remote)", () => {
	beforeEach(() => {
		mocks.execAsyncRemote.mockReset();
	});

	it("builds the tree with full-path ids, directories and files", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: output(
				["./dynamic", "./dynamic/sub"],
				[],
				["./traefik.yml", "./dynamic/a.yml", "./dynamic/sub/b.yml"],
			),
			stderr: "",
		});

		const tree = await readDirectory("/etc/dokploy/traefik", "server-1");

		expect(tree).toEqual([
			{
				id: "/etc/dokploy/traefik/dynamic",
				name: "dynamic",
				type: "directory",
				children: [
					{
						id: "/etc/dokploy/traefik/dynamic/a.yml",
						name: "a.yml",
						type: "file",
					},
					{
						id: "/etc/dokploy/traefik/dynamic/sub",
						name: "sub",
						type: "directory",
						children: [
							{
								id: "/etc/dokploy/traefik/dynamic/sub/b.yml",
								name: "b.yml",
								type: "file",
							},
						],
					},
				],
			},
			{
				id: "/etc/dokploy/traefik/traefik.yml",
				name: "traefik.yml",
				type: "file",
			},
		]);
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("server-1");
	});

	it("lists a symlink as a file and does not descend it", async () => {
		// `find -P` reports the link in the symlink section only, and nothing under it.
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: output([], ["./outside"], ["./a.yml"]),
			stderr: "",
		});

		const tree = await readDirectory("/etc/dokploy/traefik", "server-1");

		expect(tree).toEqual([
			{ id: "/etc/dokploy/traefik/a.yml", name: "a.yml", type: "file" },
			{ id: "/etc/dokploy/traefik/outside", name: "outside", type: "file" },
		]);
	});

	it("round-trips names with quotes, backslashes, spaces and newlines", () => {
		const names = ["it's.yml", 'say "hi".yml', "back\\slash.yml", "a b.yml"];
		const newline = "line1\nline2.yml";
		const sub = "$(touch pwned)";
		const tree = parseRemoteReadDirectory(
			"/base",
			output(
				[`./${sub}`],
				[],
				[...names, newline].map((n) => `./${n}`).concat(`./${sub}/${newline}`),
			),
		);

		expect(tree.map((item) => item.name).sort()).toEqual(
			[sub, ...names, newline].sort(),
		);
		for (const n of [...names, newline]) {
			expect(tree).toContainEqual({
				id: `/base/${n}`,
				name: n,
				type: "file",
			});
		}
		const dir = tree.find((item) => item.name === sub);
		expect(dir?.children).toEqual([
			{ id: `/base/${sub}/${newline}`, name: newline, type: "file" },
		]);
	});

	it("returns [] for an empty directory", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: output([], [], []),
			stderr: "",
		});
		expect(await readDirectory("/base", "server-1")).toEqual([]);
		expect(parseRemoteReadDirectory("/base", "")).toEqual([]);
	});

	it("lets a failing remote command propagate", async () => {
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh down"));
		await expect(readDirectory("/base", "server-1")).rejects.toThrow(
			"ssh down",
		);
	});

	describe("command", () => {
		it("never follows links, caps the depth and quotes the root", () => {
			const root = "/tmp/it's a dir; $(rm -rf /)";
			const command = buildRemoteReadDirectoryCommand(root);

			expect(command).toContain("find -P . ");
			expect(command).toContain(`-maxdepth ${MAX_READ_DIRECTORY_DEPTH}`);
			expect(command).toContain("-print0");
			expect(command).not.toMatch(/ -L | -H |-follow|\beval\b/);
			// The root only appears once, as the quoted value of `root=`.
			const rootLine = command.split("\n")[0] ?? "";
			expect(rootLine.startsWith("root=")).toBe(true);
			expect(rootLine).not.toBe(`root=${root}`);
			expect(command.match(/rm -rf/g)).toHaveLength(1);
			expect(command).toContain('cd -- "$root"');
		});

		it("cannot exit non-zero because a find pass failed", () => {
			const lines = buildRemoteReadDirectoryCommand("/base").split("\n");
			expect(lines[lines.length - 1]).toBe("exit 0");
		});

		it.skipIf(
			!hasSh || process.platform === "win32" || process.getuid?.() === 0,
		)("lists what is readable when a subdirectory is not", async () => {
			const base = mkdtempSync(join(tmpdir(), "readdir-denied-"));
			const locked = join(base, "locked");
			try {
				mkdirSync(locked);
				writeFileSync(join(base, "a.yml"), "x");
				writeFileSync(join(locked, "b.yml"), "x");
				chmodSync(locked, 0o000);
				mocks.execAsyncRemote.mockImplementation(runLocally);

				const tree = await readDirectory(base, "server-1");

				expect(tree).toContainEqual({
					id: join(base, "a.yml"),
					name: "a.yml",
					type: "file",
				});
				expect(tree.find((item) => item.name === "locked")?.children).toEqual(
					[],
				);
			} finally {
				chmodSync(locked, 0o700);
				rmSync(base, { recursive: true, force: true });
			}
		});

		it.skipIf(!hasSh)(
			"produces a listing that parses back exactly on a real tree",
			async () => {
				const base = mkdtempSync(join(tmpdir(), "readdir-remote-"));
				const root = join(base, "it's a dir");
				const outside = join(base, "outside");
				try {
					mkdirSync(root);
					mkdirSync(outside);
					writeFileSync(join(outside, "secret.yml"), "x");
					mkdirSync(join(root, "dynamic"));
					writeFileSync(join(root, "dynamic", "a.yml"), "x");
					writeFileSync(join(root, "it's.yml"), "x");
					writeFileSync(join(root, "sp ace.yml"), "x");
					// Quotes and backslashes are not valid in Windows file names.
					const special = ['q"uote.yml', "back\\slash.yml", "new\nline.yml"];
					const created: string[] = [];
					for (const name of special) {
						try {
							writeFileSync(join(root, name), "x");
							created.push(name);
						} catch {}
					}
					let linked = true;
					try {
						symlinkSync(outside, join(root, "link"), "dir");
						symlinkSync(root, join(root, "dynamic", "cycle"), "dir");
					} catch {
						linked = false;
					}
					mocks.execAsyncRemote.mockImplementation(runLocally);

					const tree = await readDirectory(root, "server-1");
					const names = tree.map((item) => item.name);

					expect(names).toEqual(expect.arrayContaining(["it's.yml", "sp ace.yml"]));
					for (const name of created) {
						expect(tree).toContainEqual({
							id: `${root}/${name}`,
							name,
							type: "file",
						});
					}
					const dynamic = tree.find((item) => item.name === "dynamic");
					expect(dynamic?.type).toBe("directory");
					if (linked) {
						expect(tree).toContainEqual({
							id: `${root}/link`,
							name: "link",
							type: "file",
						});
						expect(dynamic?.children).toContainEqual({
							id: `${root}/dynamic/cycle`,
							name: "cycle",
							type: "file",
						});
					}
					expect(JSON.stringify(tree)).not.toContain("secret.yml");
				} finally {
					rmSync(base, { recursive: true, force: true });
				}
			},
		);

		it.skipIf(!hasSh)("lists nothing for a missing directory", async () => {
			mocks.execAsyncRemote.mockImplementation(runLocally);
			expect(
				await readDirectory(join(tmpdir(), "does-not-exist-readdir"), "s"),
			).toEqual([]);
		});
	});
});

describe("readDirectory (local)", () => {
	let base: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "readdir-local-"));
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it("lists a symlink to a directory as a file and does not descend it", async () => {
		const root = join(base, "root");
		const outside = join(base, "outside");
		mkdirSync(root);
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.yml"), "x");
		writeFileSync(join(root, "a.yml"), "x");
		try {
			symlinkSync(outside, join(root, "link"), "dir");
		} catch {
			return; // Creating symlinks needs privileges on Windows.
		}

		const tree = await readDirectory(root);

		expect(tree).toContainEqual({
			id: join(root, "link"),
			name: "link",
			type: "file",
		});
		expect(JSON.stringify(tree)).not.toContain("secret.yml");
	});

	it("stops listing below the depth cap", async () => {
		let dir = join(base, "deep");
		mkdirSync(dir);
		for (let i = 1; i < MAX_READ_DIRECTORY_DEPTH + 2; i++) {
			dir = join(dir, `d${i}`);
			mkdirSync(dir);
		}

		let level = await readDirectory(join(base, "deep"));
		let depth = 0;
		while (level[0]?.children?.length) {
			depth++;
			level = level[0].children;
		}
		// The first level is depth 1; the deepest directory listed is at the cap.
		expect(depth + 1).toBe(MAX_READ_DIRECTORY_DEPTH);
	});
});
