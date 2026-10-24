import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// T-7878: stored patches are checked again when they are applied, and the
// patch editor reads and lists the service's own patch repo.

vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
	execAsync: vi.fn(),
	writeFileRemote: vi.fn(),
	findPatches: vi.fn(),
	findPatch: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	localBase: { path: "" },
}));

// Forward slashes whatever OS runs the suite, as in the other patch tests.
vi.mock("node:path", async () => {
	const actual = await vi.importActual<typeof import("node:path")>("node:path");
	return { ...actual, ...actual.posix, default: actual.posix };
});
vi.mock("@dokploy/server/constants", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/constants")>();
	return {
		...actual,
		paths: (isServer = false) =>
			isServer
				? actual.paths(true)
				: {
						...actual.paths(true),
						COMPOSE_PATH: `${mocks.localBase.path}/compose`,
						APPLICATIONS_PATH: `${mocks.localBase.path}/applications`,
						PATCH_REPOS_PATH: `${mocks.localBase.path}/patch-repos`,
					},
	};
});
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	writeFileRemote: mocks.writeFileRemote,
}));
vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			patch: {
				findMany: (...args: unknown[]) => mocks.findPatches(...args),
				findFirst: (...args: unknown[]) => mocks.findPatch(...args),
			},
		},
	},
}));
vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: mocks.findApplicationById,
}));
vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: mocks.findComposeById,
}));

import {
	generateApplyPatchesCommand,
	markPatchForDeletion,
} from "@dokploy/server/services/patch";
import {
	readPatchRepoDirectory,
	readPatchRepoFile,
} from "@dokploy/server/services/patch-repo";

const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;
const hasGit = spawnSync("git", ["--version"]).status === 0;
/** The local execAsync, through a real `sh` (the deploy's shell). */
const shExec = async (command: string) => {
	const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`exit ${result.status}`);
	}
	return { stdout: result.stdout, stderr: result.stderr };
};

const row = (
	patchId: string,
	filePath: string,
	content: string,
	type: "create" | "update" | "delete" = "update",
	enabled = true,
) => ({ patchId, filePath, content, type, enabled });

let tmp = "";
beforeEach(() => {
	vi.clearAllMocks();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = mkdtempSync(`${tmpdir()}/dokploy-patch-path-`).replaceAll("\\", "/");
	mocks.localBase.path = tmp;
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.writeFileRemote.mockResolvedValue(undefined);
	mocks.findApplicationById.mockResolvedValue({
		appName: "web-app",
		serverId: "srv-app",
		buildServerId: null,
	});
	mocks.findComposeById.mockResolvedValue({
		appName: "big-app",
		serverId: "srv-1",
	});
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("generateApplyPatchesCommand with a stored row from before the rules", () => {
	it.each(["../../../../../x", ".git/HEAD", ".GIT/objects/x", "/abs/x", "."])(
		"stops the deploy on %j, names the patch, stages nothing",
		async (path) => {
			mocks.findPatches.mockResolvedValue([
				row("p-good", "src/a.ts", "fine"),
				row("p-bad", path, "PATCH-CONTENT"),
			]);
			const run = generateApplyPatchesCommand(
				{ id: "c1", type: "compose", serverId: "srv-1" },
				{ deploymentId: "dep-1" },
			);
			await expect(run).rejects.toThrow(/Patch p-bad has a file path outside/);
			await run.catch((error: Error) => {
				expect(error.message).not.toContain("PATCH-CONTENT");
			});
			expect(mocks.writeFileRemote).not.toHaveBeenCalled();
			expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		},
	);

	it("ignores a disabled row, whatever its path", async () => {
		mocks.findPatches.mockResolvedValue([
			row("p-good", "src/a.ts", "fine"),
			row("p-off", "../../outside-file", "x", "update", false),
		]);
		const command = await generateApplyPatchesCommand(
			{ id: "c1", type: "compose", serverId: "srv-1" },
			{ deploymentId: "dep-1" },
		);
		expect(command).toContain("/etc/dokploy/compose/big-app/code/src/a.ts");
		expect(command).not.toContain("outside-file");
	});
});

describe("a stored patch on more than one service", () => {
	it("stops the deploy naming only the patch, stages nothing", async () => {
		mocks.findPatches.mockResolvedValue([
			row("p-good", "src/a.ts", "fine"),
			{
				...row("p-two", "docker-compose.yml", "PATCH-CONTENT"),
				applicationId: "app-other",
				composeId: "c1",
			},
		]);
		const run = generateApplyPatchesCommand(
			{ id: "c1", type: "compose", serverId: "srv-1" },
			{ deploymentId: "dep-1" },
		);
		await expect(run).rejects.toThrow(
			/Patch p-two is attached to more than one service/,
		);
		await run.catch((error: Error) => {
			expect(error.message).not.toContain("app-other");
			expect(error.message).not.toContain("PATCH-CONTENT");
		});
		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("is not turned into a delete patch", async () => {
		mocks.findPatch.mockResolvedValue({
			...row("p-two", "docker-compose.yml", "x"),
			applicationId: "app-other",
			composeId: "c1",
		});
		await expect(
			markPatchForDeletion("docker-compose.yml", "c1", "compose"),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

const runScript = (script: string) =>
	spawnSync("sh", ["-c", `set -e\n${script}`], { encoding: "utf8" });

describe.skipIf(!hasSh)("applying patches with a real shell", () => {
	const setUp = () => {
		const code = `${tmp}/compose/big-app/code`;
		const outside = `${tmp}/outside`;
		mkdirSync(code, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(`${outside}/kept`, "kept\n");
		return { code, outside };
	};
	const apply = async (rows: ReturnType<typeof row>[]) => {
		mocks.findPatches.mockResolvedValue(rows);
		const command = await generateApplyPatchesCommand(
			{ id: "c1", type: "compose", serverId: null },
			{ deploymentId: "dep-9" },
		);
		return runScript(command);
	};
	const staged = () =>
		readdirSync(`${tmp}/compose/big-app`).filter((name) =>
			name.startsWith(".dokploy-"),
		);

	it("writes and deletes ordinary nested paths", async () => {
		const { code } = setUp();
		writeFileSync(`${code}/old.txt`, "old\n");
		const result = await apply([
			row("p1", "src/a.ts", "a\n"),
			row("p2", "docker-compose.yml", "services: {}\n", "create"),
			row("p3", "a/.github/x", "x\n", "create"),
			row("p4", ".env.example", "A=1\n"),
			row("p5", "old.txt", "", "delete"),
		]);
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(readFileSync(`${code}/src/a.ts`, "utf8")).toBe("a\n");
		expect(readFileSync(`${code}/docker-compose.yml`, "utf8")).toBe(
			"services: {}\n",
		);
		expect(readFileSync(`${code}/a/.github/x`, "utf8")).toBe("x\n");
		expect(readFileSync(`${code}/.env.example`, "utf8")).toBe("A=1\n");
		expect(existsSync(`${code}/old.txt`)).toBe(false);
		expect(staged()).toEqual([]);
	});

	// Symbolic links need privileges on Windows; the CI runners have them.
	const canLink = (() => {
		if (!hasSh) return false;
		const probe = mkdtempSync(`${tmpdir()}/dokploy-link-probe-`);
		try {
			symlinkSync(probe, `${probe}/l`);
			return true;
		} catch {
			return false;
		} finally {
			rmSync(probe, { recursive: true, force: true });
		}
	})();

	it.skipIf(!canLink)(
		"refuses a write through a linked directory in the checkout",
		async () => {
			const { code, outside } = setUp();
			symlinkSync(outside, `${code}/link`, "dir");
			const result = await apply([
				row("p1", "src/a.ts", "a\n"),
				row("p-link", "link/new", "new\n", "create"),
			]);
			expect(result.status).not.toBe(0);
			expect(result.stdout).toContain(
				"Patch p-link goes through a symbolic link",
			);
			expect(existsSync(`${outside}/new`)).toBe(false);
			expect(staged()).toEqual([]);
		},
	);

	it.skipIf(!canLink)(
		"refuses a write onto a linked file, and a delete through a linked directory",
		async () => {
			const { code, outside } = setUp();
			symlinkSync(`${outside}/kept`, `${code}/f`, "file");
			const write = await apply([row("p-file", "f", "new\n")]);
			expect(write.status).not.toBe(0);
			expect(readFileSync(`${outside}/kept`, "utf8")).toBe("kept\n");

			symlinkSync(outside, `${code}/dir`, "dir");
			const del = await apply([row("p-del", "dir/kept", "", "delete")]);
			expect(del.status).not.toBe(0);
			expect(existsSync(`${outside}/kept`)).toBe(true);
		},
	);
});

describe("patch repo reads", () => {
	it("lists the service's own patch repo, on the host that holds it", async () => {
		await readPatchRepoDirectory("c1", "compose");
		const [serverId, command] = mocks.execAsyncRemote.mock.calls[0] ?? [];
		expect(serverId).toBe("srv-1");
		expect(command).toBe(
			"git --git-dir=/etc/dokploy/patch-repos/compose/big-app/.git ls-tree -r --name-only HEAD",
		);

		// An application's patch repo lives on its build server, where
		// ensureRepo cloned it.
		mocks.findApplicationById.mockResolvedValue({
			appName: "web-app",
			serverId: "srv-app",
			buildServerId: "build-1",
		});
		await readPatchRepoDirectory("a1", "application");
		const [appServer, appCommand] = mocks.execAsyncRemote.mock.calls[1] ?? [];
		expect(appServer).toBe("build-1");
		expect(appCommand).toContain(
			"/etc/dokploy/patch-repos/application/web-app/.git",
		);
	});

	it.each(["../../../../x", ".git/config", "/abs/x"])(
		"refuses to read %j and runs nothing",
		async (path) => {
			await expect(
				readPatchRepoFile("c1", "compose", path),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		},
	);

	it("reads the committed blob of an ordinary path", async () => {
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "content", stderr: "" });
		await expect(
			readPatchRepoFile("c1", "compose", "a/.github/x"),
		).resolves.toBe("content");
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"srv-1",
			"git --git-dir=/etc/dokploy/patch-repos/compose/big-app/.git cat-file blob HEAD\\:a/.github/x",
		);
	});
});

describe.skipIf(!hasSh || !hasGit)("patch repo reads (real sh + git)", () => {
	const git = (cwd: string, ...args: string[]) => {
		const result = spawnSync(
			"git",
			[
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"-c",
				"commit.gpgsign=false",
				"-c",
				"core.symlinks=true",
				...args,
			],
			{ cwd, encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);
	};

	beforeEach(() => {
		mocks.findComposeById.mockResolvedValue({
			appName: "big-app",
			serverId: null,
		});
		mocks.execAsync.mockImplementation(shExec);
	});

	it("shows a committed link as its target, never the file it points at", async () => {
		writeFileSync(`${tmp}/target`, "TARGET-CONTENT\n");
		const repo = `${tmp}/patch-repos/compose/big-app`;
		mkdirSync(repo, { recursive: true });
		git(repo, "init", "-q");
		writeFileSync(`${repo}/a.txt`, "a\n");
		git(repo, "add", "a.txt");
		// A link blob, without needing link privileges on the host.
		const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
			cwd: repo,
			input: `${tmp}/target`,
			encoding: "utf8",
		}).stdout.trim();
		git(repo, "update-index", "--add", "--cacheinfo", `120000,${blob},linked`);
		git(repo, "commit", "-q", "-m", "init");

		await expect(readPatchRepoFile("c1", "compose", "a.txt")).resolves.toBe(
			"a\n",
		);
		const linked = await readPatchRepoFile("c1", "compose", "linked");
		expect(linked).not.toContain("TARGET-CONTENT");
		expect(linked).toBe(`${tmp}/target`);
	});

	it("never falls back to a repository above a missing or failed clone", async () => {
		// An ancestor repository that tracks a file at the same relative path.
		git(tmp, "init", "-q");
		writeFileSync(`${tmp}/x`, "ANCESTOR\n");
		git(tmp, "add", "x");
		git(tmp, "commit", "-q", "-m", "ancestor");
		// The failed clone left an empty directory.
		mkdirSync(`${tmp}/patch-repos/compose/big-app`, { recursive: true });

		await expect(readPatchRepoFile("c1", "compose", "x")).rejects.toThrow();
		await expect(readPatchRepoDirectory("c1", "compose")).rejects.toThrow();
	});
});
