import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { quote } from "shell-quote";
import { getPathResolverLines } from "./path-containment";
import { execAsyncRemote } from "./process/execAsync";

/**
 * Where the paths of a compose's custom command really lead (T-7845).
 *
 * The own-directory rule of the custom command guard (T-7135) compares paths
 * lexically, so a link inside `<COMPOSE_PATH>/<appName>` that points at another
 * compose's directory (`code/link -> ../../other/code`), or a `composePath`
 * that goes through a linked directory, was not followed. These helpers
 * resolve every path on the host the compose deploys on (the links followed,
 * a part that does not exist left as it is) and compare the result with the
 * resolved own directory.
 *
 * A path is given as two readings of the same word:
 * - `raw`: joined to its base without being cleaned up, so `link/../x` is
 *   resolved the way the kernel does (the link first, then `..` in the
 *   directory it leads to);
 * - `normal`: the lexical form the rest of the check (and the files Dokploy
 *   reads itself) works with.
 * They must lead to the same place; `link/..` makes them differ, and the file
 * Dokploy would check is then not the one Docker reads.
 *
 * One shell command carries all the paths of a deploy. It prints one verdict
 * per path and never a resolved path, so nothing a path contains can break the
 * output. A host that cannot resolve (no `realpath -m` or `readlink -f`), a
 * failed command and a missing line all count as `unresolved`: the caller
 * refuses. Every path is quoted.
 */
export type PathReading = { raw: string; normal: string };

export type OwnDirectoryVerdict =
	/** Resolves to the own directory or a place inside it. */
	| "in"
	/** Resolves somewhere else. */
	| "out"
	/** Inside, but not where its cleaned-up form leads (a link followed by `..`). */
	| "moved"
	/** Could not be resolved. */
	| "unresolved";

const VERDICTS: readonly OwnDirectoryVerdict[] = [
	"in",
	"out",
	"moved",
	"unresolved",
];

/**
 * The shell that prints the verdicts: first the own directory (`own:ok` or
 * `own:unresolved`), then one line per reading, in order.
 */
export const getOwnDirectoryCheckCommand = (
	ownDirectory: string,
	readings: PathReading[],
) =>
	[
		...getPathResolverLines("__dokploy_resolve() { return 1; }"),
		`__dokploy_own=$(__dokploy_resolve ${quote([ownDirectory])}) || __dokploy_own=`,
		'if [ -n "$__dokploy_own" ]; then echo own:ok; else echo own:unresolved; fi',
		// $1: the raw path, $2: its cleaned-up form.
		`__dokploy_verdict() { if [ -z "$__dokploy_own" ]; then echo unresolved; return; fi; __dokploy_a=$(__dokploy_resolve "$1") && __dokploy_b=$(__dokploy_resolve "$2") || { echo unresolved; return; }; case "$__dokploy_a" in "$__dokploy_own"|"$__dokploy_own"/*) ;; *) echo out; return;; esac; if [ "$__dokploy_a" = "$__dokploy_b" ]; then echo in; else echo moved; fi; }`,
		...readings.map(
			(reading) =>
				`__dokploy_verdict ${quote([reading.raw])} ${quote([reading.normal])}`,
		),
	].join("\n");

/** One verdict per reading; whatever the output does not say is `unresolved`. */
export const parseOwnDirectoryVerdicts = (
	stdout: string,
	count: number,
): OwnDirectoryVerdict[] => {
	const lines = stdout.split("\n").map((line) => line.trim());
	const verdicts: OwnDirectoryVerdict[] = [];
	for (let i = 0; i < count; i++) {
		const line = lines[i + 1] as OwnDirectoryVerdict | undefined;
		verdicts.push(line && VERDICTS.includes(line) ? line : "unresolved");
	}
	return verdicts;
};

// A path of this machine in one form to compare, without a drive letter (only
// a Windows dev machine has one).
const bare = (value: string) =>
	value.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");

/**
 * The path with its links resolved, a part that does not exist kept as it is
 * (like `realpath -m`). `null` when it cannot be told: a link whose target is
 * missing, or an error other than "not there".
 */
const resolveLocal = (path: string) => {
	let head = path;
	const tail: string[] = [];
	for (;;) {
		try {
			const real = bare(realpathSync.native(head));
			return [real, ...tail.reverse()].join("/").replace(/\/+/g, "/");
		} catch (error) {
			const code = (error as { code?: string } | null)?.code;
			if (code !== "ENOENT" && code !== "ENOTDIR") return null;
		}
		try {
			// There, but unresolvable: a link with no target.
			lstatSync(head);
			return null;
		} catch {
			// Not there.
		}
		const parent = dirname(head);
		if (parent === head) return null;
		tail.push(basename(head));
		head = parent;
	}
};

const collapse = (path: string) => {
	const out: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return `/${out.join("/")}`;
};

/** The same verdicts for a host that is this machine, without a shell. */
export const checkReadingsInOwnDirectoryLocal = (
	ownDirectory: string,
	readings: PathReading[],
): OwnDirectoryVerdict[] => {
	const own = resolveLocal(ownDirectory);
	return readings.map((reading) => {
		if (own === null) return "unresolved";
		const a = resolveLocal(reading.raw);
		const b = resolveLocal(reading.normal);
		if (a === null || b === null) return "unresolved";
		const resolved = collapse(a);
		const root = collapse(own);
		if (resolved !== root && !resolved.startsWith(`${root}/`)) return "out";
		return resolved === collapse(b) ? "in" : "moved";
	});
};

/**
 * One verdict per reading, resolved on the host the compose deploys on
 * (`serverId`, over SSH) or on this machine. Fails closed: when the host cannot
 * be asked, every reading is `unresolved`.
 */
export const checkReadingsInOwnDirectory = async ({
	serverId,
	ownDirectory,
	readings,
}: {
	serverId: string | null | undefined;
	ownDirectory: string;
	readings: PathReading[];
}): Promise<OwnDirectoryVerdict[]> => {
	if (readings.length === 0) return [];
	try {
		if (serverId) {
			const { stdout } = await execAsyncRemote(
				serverId,
				getOwnDirectoryCheckCommand(ownDirectory, readings),
			);
			return parseOwnDirectoryVerdicts(stdout, readings.length);
		}
		return checkReadingsInOwnDirectoryLocal(ownDirectory, readings);
	} catch {
		return readings.map(() => "unresolved");
	}
};
