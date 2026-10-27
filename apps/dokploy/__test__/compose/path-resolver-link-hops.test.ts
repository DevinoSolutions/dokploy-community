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

// The path resolver that deploy scripts carry (`getPathResolverLines`), on a
// host that has `readlink -f` and no `realpath -m` (minimal images): a link
// whose target is relative is read from the link's own directory, whatever the
// working directory is, a link chain is followed hop by hop with a cap, and
// anything that cannot be followed fails (T-9540).

// Each case starts a shell, which is slow on Windows and under load.
vi.setConfig({ testTimeout: 60_000 });

const shellWorks = spawnSync("sh", ["-c", "true"]).status === 0;

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

const run = (script: string, cwd?: string) =>
	spawnSync("sh", ["-c", `${MINIMAL}${lines}\n${script}`], {
		encoding: "utf8",
		timeout: 30_000,
		cwd,
	});

let tmp = "";
let sh = "";
let linksWork = false;

const link = (target: string, place: string) =>
	symlinkSync(target, `${tmp}/${place}`, "dir");

beforeAll(() => {
	tmp = mkdtempSync(`${tempBase()}/.dokploy-hops-`).replaceAll("\\", "/");
	sh = shellPath(tmp);
	for (const dir of [
		"own/code/real",
		"own/code/a/b",
		"own/code/sub",
		"other/code",
	]) {
		mkdirSync(`${tmp}/${dir}`, { recursive: true });
	}
	writeFileSync(`${tmp}/own/code/real/file`, "x");
	try {
		// Relative targets, as a checkout brings them.
		link("real", "own/code/rel_dir");
		link("../../other/code/secret", "own/code/dangle_out");
		link("../code/in_miss", "own/code/dangle_in");
		link("c2", "own/code/c1");
		link("../../other/code/miss", "own/code/c2");
		link("loop2", "own/code/loop1");
		link("loop1", "own/code/loop2");
		link("self", "own/code/self");
		link("miss/../x", "own/code/dotdot");
		link("../../../w/own/code/sub/m", "own/code/sub/up");
		// An absolute target.
		if (process.platform !== "win32") {
			link(`${sh}/other/code/abs_miss`, "own/code/abs");
		}
		linksWork =
			run(`[ -L '${sh}/own/code/dangle_out' ]`).status === 0 &&
			run(`[ -L '${sh}/own/code/rel_dir' ]`).status === 0;
	} catch {
		linksWork = false;
	}
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const itWithLinks = (name: string, fn: () => void) =>
	it(name, () => {
		// Links need a privilege on some Windows hosts.
		if (!shellWorks || !linksWork) return;
		fn();
	});

// What each input resolves to when the resolver is started in `cwd`.
const resolve = (inputs: string[], cwd: string) => {
	const body = inputs
		.map(
			(input) =>
				`if r=$(__dokploy_resolve '${input}'); then echo "$r"; else echo unresolved; fi`,
		)
		.join("\n");
	const result = run(body, cwd);
	expect(result.error).toBeUndefined();
	return result.stdout.trim().split("\n");
};

const verdicts = (inputs: string[], cwd: string) => {
	const body = inputs
		.map(
			(input) =>
				`if __dokploy_inside '${sh}/own' '${input}'; then echo in; else echo out; fi`,
		)
		.join("\n");
	return run(body, cwd).stdout.trim().split("\n");
};

// Working directories to start from: far from the links, and deep inside the
// compose's own directory (where a wrong reading would land inside it).
const cwds = () => [tmp, `${tmp}/own/code/a/b`, `${tmp}/other/code`];

describe("the readlink -f fallback of the path resolver", () => {
	itWithLinks(
		"follows a link to a missing target from the link's own directory",
		() => {
			for (const cwd of cwds()) {
				expect(
					resolve(
						[
							`${sh}/own/code/dangle_out`,
							`${sh}/own/code/dangle_out/more/deeper`,
							`${sh}/own/code/dangle_in`,
						],
						cwd,
					),
				).toEqual([
					`${sh}/other/code/secret`,
					`${sh}/other/code/secret/more/deeper`,
					`${sh}/own/code/in_miss`,
				]);
			}
		},
	);

	itWithLinks("follows a chain of links hop by hop", () => {
		for (const cwd of cwds()) {
			expect(
				resolve([`${sh}/own/code/c1`, `${sh}/own/code/c1/tail`], cwd),
			).toEqual([`${sh}/other/code/miss`, `${sh}/other/code/miss/tail`]);
		}
	});

	itWithLinks(
		"follows a link to an existing directory, and a link then ..",
		() => {
			for (const cwd of cwds()) {
				expect(
					resolve(
						[
							`${sh}/own/code/rel_dir`,
							`${sh}/own/code/rel_dir/file`,
							`${sh}/own/code/rel_dir/../a`,
							`${sh}/own/code/rel_dir/missing`,
						],
						cwd,
					),
				).toEqual([
					`${sh}/own/code/real`,
					`${sh}/own/code/real/file`,
					`${sh}/own/code/a`,
					`${sh}/own/code/real/missing`,
				]);
			}
		},
	);

	itWithLinks("follows a link to an absolute path", () => {
		if (process.platform === "win32") return; // an absolute link target is a Windows path there
		for (const cwd of cwds()) {
			expect(resolve([`${sh}/own/code/abs/x`], cwd)).toEqual([
				`${sh}/other/code/abs_miss/x`,
			]);
		}
	});

	itWithLinks("reads a target that climbs from the link's directory", () => {
		for (const cwd of cwds()) {
			// Three levels above own/code/sub is the temp directory, not the compose's.
			expect(resolve([`${sh}/own/code/sub/up`], cwd)).toEqual([
				`${sh}/w/own/code/sub/m`,
			]);
		}
	});

	itWithLinks(
		"fails on a link loop, a self link and a missing component before ..",
		() => {
			// One directory: each failing hop costs a few processes on some hosts.
			for (const cwd of cwds().slice(1, 2)) {
				expect(
					resolve(
						[
							`${sh}/own/code/loop1`,
							`${sh}/own/code/loop1/x`,
							`${sh}/own/code/self`,
							`${sh}/own/code/dotdot`,
							"relative/link",
						],
						cwd,
					),
				).toEqual(Array(5).fill("unresolved"));
			}
		},
	);

	itWithLinks(
		"gives the same inside and outside verdicts from every directory",
		() => {
			const cases: Array<[string, "in" | "out"]> = [
				["dangle_out", "out"],
				["dangle_out/x", "out"],
				["dangle_in", "in"],
				["c1", "out"],
				["rel_dir/file", "in"],
				["loop1", "out"],
				["sub/up", "out"],
				["not_there/at/all", "in"],
				...(process.platform === "win32"
					? []
					: [["abs", "out"] as [string, "in" | "out"]]),
			];
			// One start per call keeps this cheap on hosts where processes are slow.
			for (const cwd of cwds().slice(0, 2)) {
				expect(
					verdicts(
						cases.map(([path]) => `${sh}/own/code/${path}`),
						cwd,
					),
				).toEqual(cases.map(([, verdict]) => verdict));
			}
		},
	);

	it("prints a path below the root without a doubled slash", () => {
		if (!shellWorks) return;
		const result = run(
			"r=$(__dokploy_resolve '/definitely/not/there'); echo \"$r\"",
		);
		expect(result.stdout.trim()).toBe("/definitely/not/there");
	});
});

// The same checks on a real busybox, where the working-directory reading of a
// relative link target was seen. Runs only where docker and the alpine:3 image
// are already there.
const busybox = (() => {
	try {
		return (
			spawnSync("docker", ["image", "inspect", "alpine:3"], {
				timeout: 20_000,
			}).status === 0
		);
	} catch {
		return false;
	}
})();

describe.skipIf(!busybox)("on a real busybox (alpine:3)", () => {
	const script = `${lines}
mkdir -p /w/own/code/a/b /w/own/code/sub /w/other/code /w/c/d
ln -s ../../other/code/secret /w/own/code/dangle_out
ln -s c2 /w/own/code/c1; ln -s ../../other/code/miss /w/own/code/c2
ln -s loop2 /w/own/code/loop1; ln -s loop1 /w/own/code/loop2
ln -s ../../../w/own/code/sub/m /w/own/code/sub/up
ln -s ../x/y/file /w/own/code/filelink
for cwd in / /w/own/code/a/b /w/c/d; do
  cd "$cwd"
  for p in /w/own/code/dangle_out /w/own/code/dangle_out/more /w/own/code/c1 /w/own/code/sub/up /w/own/code/filelink /w/own/code/loop1; do
    if r=$(__dokploy_resolve "$p"); then echo "$p => $r"; else echo "$p => unresolved"; fi
  done
done`;

	it("resolves a link from its own directory wherever it runs", () => {
		const result = spawnSync(
			"docker",
			["run", "--rm", "-i", "alpine:3", "sh", "-s"],
			{ input: script, encoding: "utf8", timeout: 120_000 },
		);
		const out = result.stdout.trim().split("\n");
		expect(out).toHaveLength(18);
		const expected: Record<string, string> = {
			"/w/own/code/dangle_out": "/w/other/code/secret",
			"/w/own/code/dangle_out/more": "/w/other/code/secret/more",
			"/w/own/code/c1": "/w/other/code/miss",
			"/w/own/code/sub/up": "/w/w/own/code/sub/m",
			"/w/own/code/filelink": "/w/own/x/y/file",
			"/w/own/code/loop1": "unresolved",
		};
		for (const line of out) {
			const [path, value] = line.split(" => ") as [string, string];
			expect(value, line).toBe(expected[path]);
		}
	});
});
