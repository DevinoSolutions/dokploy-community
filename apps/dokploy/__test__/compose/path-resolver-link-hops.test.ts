import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getPathResolverLines } from "@dokploy/server/utils/path-containment";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	boundedDockerSh,
	boundedSh,
	boundedShellAvailable,
	makeTempDir,
} from "./helpers/bounded-shell";

// The path resolver that deploy scripts carry (`getPathResolverLines`), on a
// host that has `readlink -f` and no `realpath -m` (minimal images): a link
// whose target is relative is read from the link's own directory, whatever the
// working directory is, a link chain is followed hop by hop with a cap, and
// anything that cannot be followed fails (T-9540), and so does a path with a
// control character in it.

// Each case starts a shell, which is slow on Windows and under load: every
// case runs its shell checks in one script, with room to spare.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const shellWorks = boundedShellAvailable;
const posix = process.platform !== "win32";

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

const run = (script: string) =>
	boundedSh(["-c", `${MINIMAL}${lines}\n${script}`], {
		encoding: "utf8",
		timeout: 150_000,
	});

const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

let tmp = "";
let sh = "";
let linksWork = false;

const link = (target: string, place: string) =>
	symlinkSync(target, `${tmp}/${place}`, "dir");

beforeAll(() => {
	tmp = makeTempDir(`${tempBase()}/.dokploy-hops-`).replaceAll("\\", "/");
	sh = shellPath(tmp);
	for (const dir of [
		"own/code/real",
		"own/code/a/b/c",
		"own/code/sub",
		"other/code",
	]) {
		mkdirSync(`${tmp}/${dir}`, { recursive: true });
	}
	writeFileSync(`${tmp}/own/code/real/file`, "x");
	try {
		// Relative targets, as a checkout brings them.
		link("real", "own/code/rel_dir");
		link("../../other/code/far_a", "own/code/dangle_out");
		link("../code/in_miss", "own/code/dangle_in");
		link("c2", "own/code/c1");
		link("../../other/code/far_b", "own/code/c2");
		link("loop2", "own/code/loop1");
		link("loop1", "own/code/loop2");
		link("self", "own/code/self");
		link("miss/../x", "own/code/dotdot");
		link("../../../v/own/code/sub/z", "own/code/sub/up");
		// An absolute target (a Windows path there, which has no meaning here).
		if (posix) {
			link(`${sh}/other/code/abs_miss`, "own/code/abs");
		}
		// Names that differ only by a trailing control character, and links through
		// them.
		if (posix) {
			mkdirSync(`${tmp}/own/code/nl\n`, { recursive: true });
			link("a/b/c", "own/code/nl");
			link("../../../far_c/x", "own/code/nl\n/l");
			link("nl\n/l", "own/code/start");
			link("end_target\n", "own/code/nlt");
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

// Working directories to start from: far from the links, and deep inside the
// compose's own directory.
const cwds = () => [tmp, `${tmp}/own/code/a/b`];

// One shell, every working directory: for each, the answer of `expression`
// (it sees the path as "$p") for every input, one line each.
const batch = (
	inputs: string[],
	expression: string,
	starts: string[] = cwds(),
) => {
	const script = starts
		.map(
			(cwd) =>
				`echo @@cwd\n( cd ${quoted(shellPath(cwd))} && for p in ${inputs.map(quoted).join(" ")}; do ${expression}; done )`,
		)
		.join("\n");
	const result = run(script);
	expect(result.error).toBeUndefined();
	return result.stdout
		.split("@@cwd\n")
		.slice(1)
		.map((part) => part.trim().split("\n"));
};

const resolveAll = (inputs: string[], starts?: string[]) =>
	batch(
		inputs,
		'if r=$(__dokploy_resolve "$p"); then echo "$r"; else echo unresolved; fi',
		starts,
	);

const verdictsAll = (inputs: string[], starts?: string[]) =>
	batch(
		inputs,
		`if __dokploy_inside ${quoted(`${sh}/own`)} "$p"; then echo in; else echo out; fi`,
		starts,
	);

const itWithLinks = (name: string, fn: () => void) =>
	it(name, () => {
		// Links need a privilege on some Windows hosts.
		if (!shellWorks || !linksWork) return;
		fn();
	});

const everywhere = (inputs: string[], expected: string[]) => {
	const answers = resolveAll(inputs);
	expect(answers).toHaveLength(2);
	for (const answer of answers) {
		expect(answer).toEqual(expected);
	}
};

describe("the readlink -f fallback of the path resolver", () => {
	itWithLinks(
		"follows a link to a missing target from the link's own directory",
		() => {
			everywhere(
				[
					`${sh}/own/code/dangle_out`,
					`${sh}/own/code/dangle_out/more/deeper`,
					`${sh}/own/code/dangle_in`,
				],
				[
					`${sh}/other/code/far_a`,
					`${sh}/other/code/far_a/more/deeper`,
					`${sh}/own/code/in_miss`,
				],
			);
		},
	);

	itWithLinks("follows a chain of links hop by hop", () => {
		everywhere(
			[`${sh}/own/code/c1`, `${sh}/own/code/c1/tail`],
			[`${sh}/other/code/far_b`, `${sh}/other/code/far_b/tail`],
		);
	});

	itWithLinks(
		"follows a link to an existing directory, and a link then ..",
		() => {
			everywhere(
				[
					`${sh}/own/code/rel_dir`,
					`${sh}/own/code/rel_dir/file`,
					`${sh}/own/code/rel_dir/../a`,
					`${sh}/own/code/rel_dir/missing`,
				],
				[
					`${sh}/own/code/real`,
					`${sh}/own/code/real/file`,
					`${sh}/own/code/a`,
					`${sh}/own/code/real/missing`,
				],
			);
		},
	);

	itWithLinks("follows a link to an absolute path", () => {
		if (!posix) return;
		everywhere([`${sh}/own/code/abs/x`], [`${sh}/other/code/abs_miss/x`]);
	});

	itWithLinks("reads a target that climbs from the link's directory", () => {
		// Three levels above own/code/sub is the temp directory, not the compose's.
		everywhere([`${sh}/own/code/sub/up`], [`${sh}/v/own/code/sub/z`]);
	});

	itWithLinks(
		"fails on a link loop, a self link and a missing component before ..",
		() => {
			// One directory: each failing hop costs a few processes on some hosts.
			const [answer] = resolveAll(
				[
					`${sh}/own/code/loop1`,
					`${sh}/own/code/self`,
					`${sh}/own/code/dotdot`,
					"relative/link",
				],
				[`${tmp}/own/code/a/b`],
			);
			expect(answer).toEqual(Array(4).fill("unresolved"));
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
				["sub/up", "out"],
				["not_there/at/all", "in"],
				...(posix ? [["abs", "out"] as [string, "in" | "out"]] : []),
			];
			const answers = verdictsAll(
				cases.map(([path]) => `${sh}/own/code/${path}`),
				cwds().slice(1, 2),
			);
			for (const answer of answers) {
				expect(answer).toEqual(cases.map(([, verdict]) => verdict));
			}
		},
	);

	it("prints a path below the root without a doubled slash", () => {
		if (!shellWorks) return;
		const [[answer]] = resolveAll(["/definitely/not/there"], [tmp]) as [
			string[],
		];
		expect(answer).toBe("/definitely/not/there");
	});

	it("refuses a path with a control character in it", () => {
		if (!shellWorks) return;
		// A carriage return in the text of a script is dropped on some hosts (the
		// ones that read a script as text), so those cases run where it is kept.
		const cr = posix ? [`${sh}/own/code/dir\rx`, `${sh}/own/code/dir\r`] : [];
		const [answer] = resolveAll(
			[`${sh}/own/code/dir\nx`, `${sh}/own/code/dir\n`, "/a\n/b", ...cr],
			[tmp],
		);
		// Each input is printed on lines of its own only when it resolves.
		expect(answer).toEqual(Array(3 + cr.length).fill("unresolved"));
		const verdicts = verdictsAll(
			[
				`${sh}/own/code/ok\nx`,
				...(posix ? [`${sh}/own/code/ok\rx`] : []),
				`${sh}/own/ok`,
			],
			[tmp],
		);
		expect(verdicts[0]).toEqual(posix ? ["out", "out", "in"] : ["out", "in"]);
	});

	(posix ? itWithLinks : it.skip)(
		"refuses a path through a directory with a control character in its name",
		() => {
			const inputs = [
				`${sh}/own/code/start`,
				`${sh}/own/code/nl\n/l`,
				`${sh}/own/code/nlt`,
				`${sh}/own/code/dangle_in`,
			];
			const [answer] = resolveAll(inputs, [tmp]);
			expect(answer).toEqual([
				"unresolved",
				"unresolved",
				"unresolved",
				`${sh}/own/code/in_miss`,
			]);
			const [verdict] = verdictsAll(inputs, [`${tmp}/own/code/a/b`]);
			expect(verdict).toEqual(["out", "out", "out", "in"]);
		},
	);
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
NL=$(printf '\\nx'); NL=\${NL%x}
mkdir -p /w/own/code/a/b/c /w/own/code/sub /w/other/code /w/c/d /w/far_c
ln -s ../../other/code/far_a /w/own/code/dangle_out
ln -s c2 /w/own/code/c1; ln -s ../../other/code/far_b /w/own/code/c2
ln -s loop2 /w/own/code/loop1; ln -s loop1 /w/own/code/loop2
ln -s ../../../v/own/code/sub/z /w/own/code/sub/up
ln -s ../x/y/file /w/own/code/filelink
ln -s ../ok_miss /w/own/code/in_dangle
mkdir "/w/own/code/nl$NL"
ln -s a/b/c /w/own/code/nl
ln -s ../../../far_c/x "/w/own/code/nl$NL/l"
ln -s "nl$NL/l" /w/own/code/start
ln -s "end_target$NL" /w/own/code/nlt
CR=$(printf '\\rx'); CR=\${CR%x}
ln -s "end_target$CR" /w/own/code/crt
for cwd in / /w/own/code/a/b /w/c/d; do
  cd "$cwd"
  for p in /w/own/code/dangle_out /w/own/code/dangle_out/more /w/own/code/c1 /w/own/code/sub/up /w/own/code/filelink /w/own/code/loop1 /w/own/code/in_dangle /w/own/code/start /w/own/code/nlt /w/own/code/crt "/w/own/code/nl$NL/l"; do
    n=$(printf '%s' "$p" | tr '\\n' '~')
    if r=$(__dokploy_resolve "$p"); then v=$r; else v=unresolved; fi
    if __dokploy_inside /w/own "$p"; then s=in; else s=out; fi
    echo "$n => $v => $s"
  done
done`;

	it("resolves a link from its own directory wherever it runs, and refuses control characters", () => {
		const result = boundedDockerSh("alpine:3", {
			input: script,
			encoding: "utf8",
			timeout: 150_000,
		});
		const out = result.stdout.trim().split("\n");
		expect(out).toHaveLength(33);
		const expected: Record<string, string> = {
			"/w/own/code/dangle_out": "/w/other/code/far_a => out",
			"/w/own/code/dangle_out/more": "/w/other/code/far_a/more => out",
			"/w/own/code/c1": "/w/other/code/far_b => out",
			"/w/own/code/sub/up": "/w/v/own/code/sub/z => out",
			"/w/own/code/filelink": "/w/own/x/y/file => in",
			"/w/own/code/loop1": "unresolved => out",
			"/w/own/code/in_dangle": "/w/own/ok_miss => in",
			// Names that differ only by a trailing control character.
			"/w/own/code/start": "unresolved => out",
			"/w/own/code/nlt": "unresolved => out",
			"/w/own/code/crt": "unresolved => out",
			"/w/own/code/nl~/l": "unresolved => out",
		};
		for (const line of out) {
			const [path, ...rest] = line.split(" => ") as [string, ...string[]];
			expect(rest.join(" => "), line).toBe(expected[path]);
		}
	});
});
