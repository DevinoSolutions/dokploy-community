import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// A single argument to `sh -c` is capped at 128 KB (MAX_ARG_STRLEN) on Linux
// and the deploy scripts travel as exactly one such argument, so patch
// contents (which are whole files) are staged through SFTP / fs and the script
// only references the staged files.
const MAX_ARG_STRLEN = 128 * 1024;

// Spawning a real shell is slow when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	findPatches: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	localBase: { path: "" },
}));

// Same layout as every other test: forward slashes whatever OS runs the suite.
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
				: {
						...actual.paths(true),
						COMPOSE_PATH: `${mocks.localBase.path}/compose`,
						APPLICATIONS_PATH: `${mocks.localBase.path}/applications`,
					},
	};
});
vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	return {
		...actual,
		execAsyncRemote: mocks.execAsyncRemote,
		writeFileRemote: mocks.writeFileRemote,
	};
});
vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			patch: { findMany: (...args: unknown[]) => mocks.findPatches(...args) },
		},
	},
}));
vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: mocks.findApplicationById,
}));
vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: mocks.findComposeById,
}));

import { generateApplyPatchesCommand } from "@dokploy/server/services/patch";

const bigText = (label: string, kb: number) => {
	const lines: string[] = [];
	let size = 0;
	for (let i = 0; size < kb * 1024; i++) {
		const line = `${label}_SECRET_${i}=hunter2-${label}-${i}-${"x".repeat(48)}`;
		lines.push(line);
		size += line.length + 1;
	}
	return `${lines.join("\n")}\n`;
};
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const base64Of = (text: string) => Buffer.from(text, "utf8").toString("base64");

const patchRow = (
	filePath: string,
	content: string,
	type: "create" | "update" | "delete" = "update",
	enabled = true,
) => ({ filePath, content, type, enabled });

const patchA = bigText("PATCHA", 90);
const patchB = bigText("PATCHB", 90);
const patchC = bigText("PATCHC", 20);

let tmp = "";
beforeEach(() => {
	vi.clearAllMocks();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = mkdtempSync(`${tmpdir()}/dokploy-patches-`).replaceAll("\\", "/");
	mocks.localBase.path = tmp;
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.writeFileRemote.mockResolvedValue(undefined);
	mocks.findApplicationById.mockResolvedValue({ appName: "web-app" });
	mocks.findComposeById.mockResolvedValue({ appName: "big-app" });
	mocks.findPatches.mockResolvedValue([
		patchRow("src/a.env", patchA),
		patchRow("src/deep/b.cfg", patchB, "create"),
		patchRow("old.txt", "", "delete"),
		patchRow("c.cfg", patchC),
		patchRow("disabled.cfg", "nope", "update", false),
	]);
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const remoteCommands = () =>
	mocks.execAsyncRemote.mock.calls.map((call) => call[1] as string);

describe("generateApplyPatchesCommand", () => {
	it("applies patches that are together past the argv limit without embedding any", async () => {
		const command = await generateApplyPatchesCommand(
			{ id: "c1", type: "compose", serverId: "srv-1" },
			{ deploymentId: "dep-1" },
		);

		expect(bytes(patchA) + bytes(patchB) + bytes(patchC)).toBeGreaterThan(
			MAX_ARG_STRLEN,
		);
		expect(bytes(base64Of(patchA))).toBeGreaterThan(MAX_ARG_STRLEN * 0.6);
		expect(bytes(command)).toBeLessThan(4096);
		for (const text of [command, ...remoteCommands()]) {
			expect(bytes(text)).toBeLessThan(MAX_ARG_STRLEN / 8);
			expect(text).not.toContain("base64");
			for (const patch of [patchA, patchB, patchC]) {
				expect(text).not.toContain(patch.slice(0, 64));
			}
			expect(text).not.toContain("hunter2");
		}
		expect(command).toContain("Applying 4 patch(es)...");

		// Staged next to code/ (a clone wipes code/), one file per written patch.
		expect(mocks.writeFileRemote.mock.calls).toEqual([
			[
				"srv-1",
				"/etc/dokploy/compose/big-app/.dokploy-stage-patch-dep-1-0",
				patchA,
			],
			[
				"srv-1",
				"/etc/dokploy/compose/big-app/.dokploy-stage-patch-dep-1-1",
				patchB,
			],
			[
				"srv-1",
				"/etc/dokploy/compose/big-app/.dokploy-stage-patch-dep-1-2",
				patchC,
			],
		]);
		// One prepare round trip, files created 0600 before SFTP fills them.
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		expect(remoteCommands()[0]).toContain("umask 077");

		const codePath = "/etc/dokploy/compose/big-app/code";
		expect(command).toContain(
			`cat /etc/dokploy/compose/big-app/.dokploy-stage-patch-dep-1-0 > ${codePath}/src/a.env`,
		);
		expect(command).toContain(`mkdir -p ${codePath}/src/deep`);
		expect(command).toContain(`rm -f ${codePath}/old.txt;`);
	});

	it("stages application patches next to the application's code directory", async () => {
		await generateApplyPatchesCommand(
			{ id: "a1", type: "application", serverId: "srv-1" },
			{ deploymentId: "dep-2" },
		);
		expect(mocks.writeFileRemote.mock.calls[0]![1]).toBe(
			"/etc/dokploy/applications/web-app/.dokploy-stage-patch-dep-2-0",
		);
	});

	it("reports the staged paths so a caller can clean up", async () => {
		const onStaged = vi.fn();
		await generateApplyPatchesCommand(
			{ id: "c1", type: "compose", serverId: "srv-1" },
			{ deploymentId: "dep-1", onStaged },
		);
		expect(onStaged).toHaveBeenCalledTimes(1);
		expect(onStaged.mock.calls[0]![0]).toHaveLength(3);
	});

	it("stages nothing and returns an empty command without enabled patches", async () => {
		mocks.findPatches.mockResolvedValue([
			patchRow("disabled.cfg", "nope", "update", false),
		]);
		const command = await generateApplyPatchesCommand({
			id: "c1",
			type: "compose",
			serverId: "srv-1",
		});
		expect(command).toBe("");
		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("stages nothing when every patch is a delete", async () => {
		mocks.findPatches.mockResolvedValue([patchRow("old.txt", "", "delete")]);
		const command = await generateApplyPatchesCommand({
			id: "c1",
			type: "compose",
			serverId: "srv-1",
		});
		expect(command).toContain(
			"rm -f /etc/dokploy/compose/big-app/code/old.txt;",
		);
		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("keeps a user controlled file path a single shell word", async () => {
		mocks.findPatches.mockResolvedValue([
			patchRow("a b/$(touch pwned).txt", "x\n", "create"),
		]);
		const command = await generateApplyPatchesCommand(
			{ id: "c1", type: "compose", serverId: "srv-1" },
			{ deploymentId: "dep-1" },
		);
		expect(command).toContain(
			"> '/etc/dokploy/compose/big-app/code/a b/$(touch pwned).txt'",
		);
		expect(command).toContain(
			"mkdir -p '/etc/dokploy/compose/big-app/code/a b'",
		);
	});

	it("keeps a hostile delete path a single shell word", async () => {
		mocks.findPatches.mockResolvedValue([
			patchRow('x";touch /tmp/pwned;"', "", "delete"),
		]);
		const command = await generateApplyPatchesCommand({
			id: "c1",
			type: "compose",
			serverId: "srv-1",
		});
		expect(command).toContain(
			`rm -f '/etc/dokploy/compose/big-app/code/x";touch /tmp/pwned;"';`,
		);
		expect(command).not.toContain('rm -f "');
	});

	it("removes what it staged and rethrows when an upload fails", async () => {
		mocks.writeFileRemote
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("sftp down"));
		await expect(
			generateApplyPatchesCommand(
				{ id: "c1", type: "compose", serverId: "srv-1" },
				{ deploymentId: "dep-1" },
			),
		).rejects.toThrow("sftp down");
		expect(remoteCommands().at(-1)).toBe(
			"rm -f /etc/dokploy/compose/big-app/.dokploy-stage-patch-dep-1-0 /etc/dokploy/compose/big-app/.dokploy-stage-patch-dep-1-1 /etc/dokploy/compose/big-app/.dokploy-stage-patch-dep-1-2",
		);
	});

	it("stages through fs, 0600, for a service on the Dokploy host", async () => {
		const command = await generateApplyPatchesCommand(
			{ id: "c1", type: "compose", serverId: null },
			{ deploymentId: "dep-3" },
		);
		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
		expect(bytes(command)).toBeLessThan(4096);
		const staged = `${tmp}/compose/big-app/.dokploy-stage-patch-dep-3-0`;
		expect(readFileSync(staged, "utf8")).toBe(patchA);
		if (process.platform !== "win32") {
			expect(statSync(staged).mode & 0o777).toBe(0o600);
		}
	});
});

// Runs the generated script in a real shell, as the deploy does.
const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;
const itWithSh = hasSh ? it : it.skip;
const run = (script: string) =>
	spawnSync("sh", ["-c", `set -e\n${script}`], { encoding: "utf8" });
const stagedIn = (directory: string) =>
	readdirSync(directory).filter((name) => name.startsWith(".dokploy-"));

describe("applying the staged patches with a real shell", () => {
	itWithSh(
		"writes every patch byte for byte, deletes, and leaves no staged file",
		async () => {
			const code = `${tmp}/compose/big-app/code`;
			mkdirSync(code, { recursive: true });
			writeFileSync(`${code}/old.txt`, "to delete");
			const command = await generateApplyPatchesCommand(
				{ id: "c1", type: "compose", serverId: null },
				{ deploymentId: "dep-sh" },
			);

			const result = run(command);

			expect(result.status).toBe(0);
			expect(readFileSync(`${code}/src/a.env`, "utf8")).toBe(patchA);
			expect(readFileSync(`${code}/src/deep/b.cfg`, "utf8")).toBe(patchB);
			expect(readFileSync(`${code}/c.cfg`, "utf8")).toBe(patchC);
			expect(existsSync(`${code}/old.txt`)).toBe(false);
			expect(existsSync(`${code}/disabled.cfg`)).toBe(false);
			expect(stagedIn(`${tmp}/compose/big-app`)).toEqual([]);
		},
	);

	itWithSh(
		"a hostile delete path removes nothing else and runs nothing",
		async () => {
			const code = `${tmp}/compose/big-app/code`;
			mkdirSync(code, { recursive: true });
			const bait = `${tmp}/pwned`;
			mocks.findPatches.mockResolvedValue([
				patchRow(`x";touch ${bait};"`, "", "delete"),
				patchRow("$(touch " + bait + ")", "", "delete"),
			]);
			const command = await generateApplyPatchesCommand(
				{ id: "c1", type: "compose", serverId: null },
				{ deploymentId: "dep-evil" },
			);

			const result = run(command);

			expect(result.status).toBe(0);
			expect(existsSync(bait)).toBe(false);
		},
	);

	itWithSh(
		"survives a clone that wipes the code directory between staging and applying",
		async () => {
			const command = await generateApplyPatchesCommand(
				{ id: "c1", type: "compose", serverId: null },
				{ deploymentId: "dep-clone" },
			);
			const code = `${tmp}/compose/big-app/code`;

			// What every clone command starts with.
			const result = run(`rm -rf '${code}'; mkdir -p '${code}';\n${command}`);

			expect(result.status).toBe(0);
			expect(readFileSync(`${code}/src/a.env`, "utf8")).toBe(patchA);
			expect(stagedIn(`${tmp}/compose/big-app`)).toEqual([]);
		},
	);

	itWithSh(
		"stops at a patch that cannot be written and removes every staged file",
		async () => {
			const code = `${tmp}/compose/big-app/code`;
			mkdirSync(code, { recursive: true });
			// A regular file where the second patch needs a directory.
			writeFileSync(`${code}/src`, "x");
			const command = await generateApplyPatchesCommand(
				{ id: "c1", type: "compose", serverId: null },
				{ deploymentId: "dep-fail" },
			);
			expect(stagedIn(`${tmp}/compose/big-app`)).toHaveLength(3);

			const result = run(`${command}\necho should-not-run`);

			expect(result.status).toBe(1);
			expect(result.stdout).toContain("Could not write a patch file");
			expect(result.stdout).not.toContain("should-not-run");
			expect(result.stdout).not.toContain("hunter2");
			expect(existsSync(`${code}/c.cfg`)).toBe(false);
			expect(stagedIn(`${tmp}/compose/big-app`)).toEqual([]);
		},
	);
});
