import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
	checkReadingsInOwnDirectoryLocal,
	getOwnDirectoryCheckCommand,
	parseOwnDirectoryVerdicts,
} from "@dokploy/server/utils/compose-own-directory";
import { getPathResolverLines } from "@dokploy/server/utils/path-containment";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The path resolver that deploy scripts carry (`getPathResolverLines`) and the
// own-directory check refuse a path with a line feed or a carriage return in
// it on every host, whichever tool resolves paths there (T-9558).

// Each case starts a shell, which is slow on Windows and under load.
vi.setConfig({ testTimeout: 180_000 });

const shellWorks = spawnSync("sh", ["-c", "true"]).status === 0;
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

// "host": the tool the host has (`realpath -m` where it is there). "readlink":
// `realpath` hidden by a shell function, as on a host that has only `readlink -f`.
const MODES = [
	["with the host's own resolver", ""],
	["with only readlink -f", "realpath() { return 1; }\n"],
] as const;

const run = (prefix: string, script: string) =>
	spawnSync("sh", ["-c", `${prefix}${script}`], {
		encoding: "utf8",
		timeout: 150_000,
	});

// A path as the shell script spells it: a line feed or a carriage return is
// written as an escape that printf expands, because some hosts drop them from
// the text of a script and from arguments. (The paths here have no quote,
// percent sign or backslash.)
const spelled = (value: string) =>
	value.replaceAll("\n", "\\n").replaceAll("\r", "\\r");

let tmp = "";
let sh = "";
let linksWork = false;

beforeAll(() => {
	tmp = mkdtempSync(`${tempBase()}/.dokploy-lb-`).replaceAll("\\", "/");
	sh = shellPath(tmp);
	mkdirSync(`${tmp}/compose/app/code`, { recursive: true });
	mkdirSync(`${tmp}/compose/other/code`, { recursive: true });
	writeFileSync(`${tmp}/compose/app/code/file`, "x");
	if (!posix) return;
	try {
		// Names that differ from the compose's own directory only by a trailing
		// control character, and links to them, as a repository can bring.
		mkdirSync(`${tmp}/compose/app\n`);
		mkdirSync(`${tmp}/compose/app\r`);
		symlinkSync("../../app\n", `${tmp}/compose/app/code/lnk_a`);
		symlinkSync("../../app\n/x", `${tmp}/compose/app/code/lnk_a_x`);
		symlinkSync("../../app\r", `${tmp}/compose/app/code/lnk_b`);
		symlinkSync("../../app/code/ok_miss", `${tmp}/compose/app/code/lnk_ok`);
		symlinkSync("../../other/code/gone", `${tmp}/compose/app/code/lnk_far`);
		linksWork = true;
	} catch {
		linksWork = false;
	}
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// For each input, what the resolver prints (or "unresolved"), then whether it
// is inside the own directory, in one shell.
const probe = (prefix: string, inputs: string[], own = `${sh}/compose/app`) => {
	const script = [
		'lit() { __v=$(printf "$1"); __v=${__v%x}; }',
		`lit '${spelled(own)}x'; own=$__v`,
		...inputs.flatMap((input) => [
			`lit '${spelled(input)}x'`,
			'if r=$(__dokploy_resolve "$__v"); then echo "resolve $r"; else echo "resolve unresolved"; fi; if __dokploy_inside "$own" "$__v"; then echo inside in; else echo inside out; fi',
		]),
	].join("\n");
	const result = run(prefix, `${lines}\n${script}`);
	expect(result.error).toBeUndefined();
	const out = result.stdout.trim().split("\n");
	return inputs.map((_, i) => ({
		resolved: (out[i * 2] ?? "").replace("resolve ", ""),
		inside: (out[i * 2 + 1] ?? "").replace("inside ", ""),
	}));
};

describe("the resolver definitions", () => {
	it("are on one line, with no raw line break in them", () => {
		const [first] = getPathResolverLines("true");
		expect(first).toContain("__dokploy_nl=");
		expect(first).toContain("__dokploy_cr=");
		expect(first).not.toMatch(/[\r\n]/);
	});

	it.each(MODES)("define one character each %s", (_name, prefix) => {
		if (!shellWorks) return;
		const result = run(
			prefix,
			`${lines}\necho "\${#__dokploy_nl}\${#__dokploy_cr}"`,
		);
		expect(result.stdout.trim()).toBe("11");
	});
});

describe.each(MODES)("the path resolver %s", (_name, prefix) => {
	it("refuses a path with a line feed or a carriage return in it", () => {
		if (!shellWorks) return;
		const answers = probe(prefix, [
			`${sh}/compose/app\n`,
			`${sh}/compose/app\n/x`,
			`${sh}/compose/app\r`,
			`${sh}/compose/app/code\rx`,
			"/a\n/b",
		]);
		for (const answer of answers) {
			expect(answer).toEqual({ resolved: "unresolved", inside: "out" });
		}
	});

	it("refuses when the own directory has one in it", () => {
		if (!shellWorks) return;
		const [answer] = probe(
			prefix,
			[`${sh}/compose/app/code/file`],
			`${sh}/compose/app\n`,
		);
		expect(answer).toEqual({
			resolved: `${sh}/compose/app/code/file`,
			inside: "out",
		});
	});

	it("still resolves ordinary paths, inside and outside", () => {
		if (!shellWorks) return;
		const answers = probe(prefix, [
			`${sh}/compose/app/code/file`,
			`${sh}/compose/app/code/not/there/yet`,
			`${sh}/compose/other/code/file`,
		]);
		expect(answers).toEqual([
			{ resolved: `${sh}/compose/app/code/file`, inside: "in" },
			{ resolved: `${sh}/compose/app/code/not/there/yet`, inside: "in" },
			{ resolved: `${sh}/compose/other/code/file`, inside: "out" },
		]);
	});

	it("is never inside through a link to a name that differs only by a trailing line break", () => {
		if (!shellWorks || !posix || !linksWork) return;
		const answers = probe(prefix, [
			`${sh}/compose/app/code/lnk_a`,
			`${sh}/compose/app/code/lnk_a_x`,
			`${sh}/compose/app/code/lnk_b`,
			`${sh}/compose/app/code/lnk_ok`,
			`${sh}/compose/app/code/lnk_far`,
		]);
		expect(answers).toEqual([
			{ resolved: "unresolved", inside: "out" },
			{ resolved: "unresolved", inside: "out" },
			{ resolved: "unresolved", inside: "out" },
			{ resolved: `${sh}/compose/app/code/ok_miss`, inside: "in" },
			{ resolved: `${sh}/compose/other/code/gone`, inside: "out" },
		]);
	});
});

describe.each(MODES)("the own-directory check %s", (_name, prefix) => {
	it("marks readings with a line break unresolved, and the rest as before", () => {
		if (!shellWorks || !posix) return; // a script cannot carry them on every host
		const readings = [
			{
				raw: `${sh}/compose/app/code/file`,
				normal: `${sh}/compose/app/code/file`,
			},
			{ raw: `${sh}/compose/app\n`, normal: `${sh}/compose/app\n` },
			{ raw: `${sh}/compose/app/code/x\r`, normal: `${sh}/compose/app/code/x` },
			{ raw: `${sh}/compose/app/code/x`, normal: `${sh}/compose/app/code/x\n` },
			{
				raw: `${sh}/compose/other/code/file`,
				normal: `${sh}/compose/other/code/file`,
			},
		];
		const result = run(
			prefix,
			getOwnDirectoryCheckCommand(`${sh}/compose/app`, readings),
		);
		expect(result.stdout.split("\n")[0]).toBe("own:ok");
		expect(parseOwnDirectoryVerdicts(result.stdout, readings.length)).toEqual([
			"in",
			"unresolved",
			"unresolved",
			"unresolved",
			"out",
		]);
	});

	it("marks everything unresolved when the own directory has one", () => {
		if (!shellWorks || !posix) return;
		const readings = [
			{
				raw: `${sh}/compose/app/code/file`,
				normal: `${sh}/compose/app/code/file`,
			},
		];
		const result = run(
			prefix,
			getOwnDirectoryCheckCommand(`${sh}/compose/app\n`, readings),
		);
		expect(result.stdout.split("\n")[0]).toBe("own:unresolved");
		expect(parseOwnDirectoryVerdicts(result.stdout, 1)).toEqual(["unresolved"]);
	});
});

describe("the own-directory check on this host", () => {
	it("marks readings with a line break unresolved", () => {
		const own = `${tmp}/compose/app`;
		expect(
			checkReadingsInOwnDirectoryLocal(own, [
				{ raw: `${own}/code/file`, normal: `${own}/code/file` },
				{ raw: `${own}\n`, normal: `${own}\n` },
				{ raw: `${own}/code/x`, normal: `${own}/code/x\r` },
			]),
		).toEqual(["in", "unresolved", "unresolved"]);
		expect(
			checkReadingsInOwnDirectoryLocal(`${own}\n`, [
				{ raw: `${own}/code/file`, normal: `${own}/code/file` },
			]),
		).toEqual(["unresolved"]);
	});
});

// The same on real hosts: a GNU one (debian) and a BusyBox one (alpine). Runs
// only where docker and the images are already there.
const hasImage = (image: string) => {
	try {
		return (
			spawnSync("docker", ["image", "inspect", image], { timeout: 20_000 })
				.status === 0
		);
	} catch {
		return false;
	}
};

const containerScript = `${lines}
NL=$(printf '\\nx'); NL=\${NL%x}; CR=$(printf '\\rx'); CR=\${CR%x}
mkdir -p /w/compose/app/code /w/compose/other/code
mkdir "/w/compose/app$NL" "/w/compose/app$CR"
ln -s "../../app$NL" /w/compose/app/code/lnk_a
ln -s "../../app$NL/x" /w/compose/app/code/lnk_a_x
ln -s "../../app$CR" /w/compose/app/code/lnk_b
ln -s ../../app/code/ok_miss /w/compose/app/code/lnk_ok
ln -s ../../other/code/gone /w/compose/app/code/lnk_far
cd /
for p in /w/compose/app/code/lnk_a /w/compose/app/code/lnk_a_x /w/compose/app/code/lnk_b /w/compose/app/code/lnk_ok /w/compose/app/code/lnk_far "/w/compose/app$NL" "/w/compose/app$CR/x"; do
  n=$(printf '%s' "$p" | tr '\\n\\r' '~^')
  if r=$(__dokploy_resolve "$p"); then v=$r; else v=unresolved; fi
  if __dokploy_inside /w/compose/app "$p"; then s=in; else s=out; fi
  echo "$n => $v => $s"
done`;

describe.each([
	["debian:stable-slim", "a real GNU host"],
	["alpine:3", "a real BusyBox host"],
])("on %s (%s)", (image) => {
	it.skipIf(!hasImage(image))(
		"is never inside through a name that differs only by a trailing line break",
		() => {
			const result = spawnSync(
				"docker",
				["run", "--rm", "-i", image, "sh", "-s"],
				{ input: containerScript, encoding: "utf8", timeout: 150_000 },
			);
			expect(result.stdout.trim().split("\n")).toEqual([
				"/w/compose/app/code/lnk_a => unresolved => out",
				"/w/compose/app/code/lnk_a_x => unresolved => out",
				"/w/compose/app/code/lnk_b => unresolved => out",
				"/w/compose/app/code/lnk_ok => /w/compose/app/code/ok_miss => in",
				"/w/compose/app/code/lnk_far => /w/compose/other/code/gone => out",
				"/w/compose/app~ => unresolved => out",
				"/w/compose/app^/x => unresolved => out",
			]);
		},
	);
	it.skipIf(!hasImage(image))(
		"gives the own-directory check an unresolved verdict for a line break",
		() => {
			const readings = [
				{ raw: "/w/compose/app/code/f", normal: "/w/compose/app/code/f" },
				{ raw: "/w/compose/app\n", normal: "/w/compose/app\n" },
				{ raw: "/w/compose/app\r/x", normal: "/w/compose/app/x" },
				{ raw: "/w/compose/other/f", normal: "/w/compose/other/f" },
			];
			const result = spawnSync(
				"docker",
				["run", "--rm", "-i", image, "sh", "-s"],
				{
					input: `mkdir -p /w/compose/app/code /w/compose/other\n${getOwnDirectoryCheckCommand("/w/compose/app", readings)}`,
					encoding: "utf8",
					timeout: 150_000,
				},
			);
			expect(result.stdout.split("\n")[0]).toBe("own:ok");
			expect(parseOwnDirectoryVerdicts(result.stdout, readings.length)).toEqual(
				["in", "unresolved", "unresolved", "out"],
			);
		},
	);
});
