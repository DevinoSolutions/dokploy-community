import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { getPathResolverLines } from "@dokploy/server/utils/path-containment";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Each case starts a shell, which is slow on Windows and under load.
vi.setConfig({ testTimeout: 60_000 });

// The path resolver that deploy scripts carry (`getPathResolverLines`) has a
// fallback for hosts with `readlink -f` and no `realpath -m` (minimal images).
// An input that is not an absolute path has to end there with the same failure
// the resolver already reports, and absolute inputs resolve as before (T-9475).

const shellWorks = spawnSync("sh", ["-c", "true"]).status === 0;
const itWithShell = it.skipIf(!shellWorks);

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

const lines = getPathResolverLines("__dokploy_resolve() { return 1; }").join(
	"\n",
);

// `realpath` hidden by a shell function: the resolver takes the `readlink -f`
// branch, as it does on a host that has no `realpath -m`.
const MINIMAL = "realpath() { return 1; }\n";

const run = (script: string, minimal: boolean) =>
	spawnSync("sh", ["-c", `${minimal ? MINIMAL : ""}${lines}\n${script}`], {
		encoding: "utf8",
		timeout: 30_000,
	});

// Prints "<resolved>" or "unresolved" for each input.
const resolve = (inputs: string[], minimal: boolean) => {
	const body = inputs
		.map(
			(input) =>
				`if r=$(__dokploy_resolve '${input}'); then echo "$r"; else echo unresolved; fi`,
		)
		.join("\n");
	const result = run(body, minimal);
	expect(result.error).toBeUndefined();
	return result.stdout.trim().split("\n");
};

let tmp = "";
let sh = "";
let linksWork = false;
beforeAll(() => {
	tmp = mkdtempSync(`${tempBase()}/.dokploy-resolver-`).replaceAll("\\", "/");
	sh = shellPath(tmp);
	mkdirSync(`${tmp}/own/code`, { recursive: true });
	mkdirSync(`${tmp}/other/code`, { recursive: true });
	writeFileSync(`${tmp}/own/code/file`, "x");
	try {
		symlinkSync(`${tmp}/other/code`, `${tmp}/own/code/elsewhere`, "junction");
		symlinkSync(`${tmp}/nowhere`, `${tmp}/own/code/dangling`, "junction");
		linksWork = run(`[ -L '${sh}/own/code/elsewhere' ]`, false).status === 0;
	} catch {
		linksWork = false;
	}
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe.each([
	["with realpath -m", false],
	["with only readlink -f", true],
] as const)("the path resolver %s", (_name, minimal) => {
	itWithShell("ends on a relative input", () => {
		const answers = resolve(["name", "dir/name", "./name", "../name"], minimal);
		expect(answers).toHaveLength(4);
		// Only the readlink -f fallback fails them; realpath -m reads them from
		// the working directory, as it always did.
		if (minimal) {
			expect(answers).toEqual(Array(4).fill("unresolved"));
		}
	});

	itWithShell("resolves absolute paths, also ones that are not there", () => {
		const [inside, missing, outside] = resolve(
			[
				`${sh}/own/code/file`,
				`${sh}/own/code/missing/deeper/file`,
				`${sh}/other/code`,
			],
			minimal,
		);
		expect(inside).toBe(`${sh}/own/code/file`);
		expect(missing).toBe(`${sh}/own/code/missing/deeper/file`);
		expect(outside).toBe(`${sh}/other/code`);
	});

	itWithShell("tells inside from outside", () => {
		const result = run(
			[
				`__dokploy_inside '${sh}/own' '${sh}/own/code/file' && echo in || echo out`,
				`__dokploy_inside '${sh}/own' '${sh}/other/code' && echo in || echo out`,
				`__dokploy_inside '${sh}/own' 'relative' && echo in || echo out`,
			].join("\n"),
			minimal,
		);
		expect(result.stdout.trim().split("\n")).toEqual(["in", "out", "out"]);
	});

	it.skipIf(!shellWorks)("follows a link, and a dangling one", () => {
		if (!linksWork) return; // links need a privilege on some Windows hosts
		const [out, dangling] = resolve(
			[`${sh}/own/code/elsewhere/x`, `${sh}/own/code/dangling/x`],
			minimal,
		);
		expect(out).toBe(`${sh}/other/code/x`);
		expect(dangling).toContain("nowhere");
	});
});

describe("the resolver with realpath -m", () => {
	itWithShell("prints exactly what realpath -m prints", () => {
		const inputs = [`${sh}/own/code/file`, `${sh}/own/code/../code/./file`];
		const direct = spawnSync(
			"sh",
			["-c", inputs.map((i) => `realpath -m -- '${i}'`).join("\n")],
			{ encoding: "utf8" },
		).stdout;
		expect(resolve(inputs, false).join("\n") + "\n").toBe(direct);
	});
});
