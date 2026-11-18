import fs from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { shSingleQuote } from "@dokploy/server/utils/builders/remote-build-cancel";
import { quote } from "shell-quote";

/**
 * Confinement of Traefik configuration files to the Traefik directory.
 *
 * The files Dokploy reads and writes for Traefik (`<dynamic>/<appName>.yml`,
 * `<dynamic>/middlewares.yml`, `traefik.yml`) are opened as the Dokploy
 * process, which is root on the host, and as the SSH user on a remote server.
 * Anything able to plant a symlink in that directory (a bind mount of it, an
 * older release, a compose bind) would otherwise turn the read and write
 * routes into an arbitrary file read and write. Every helper here resolves
 * symlinks, requires the real path to stay inside the real Traefik directory
 * and refuses a target that is itself a symlink.
 *
 * This is the one place the rule lives: the settings router's path-based
 * Traefik file endpoints use `realpathAllowingMissingSync` and
 * `isInsideDirectory` from here too, and the by-name helpers below
 * (`readConfinedFile`, `writeConfinedFile` and the remote command builders)
 * serve every other route and internal caller.
 */

/** A path that would leave the Traefik directory, or is a symlink. */
export class TraefikPathError extends TRPCError {
	constructor(reason?: string) {
		super({
			code: "BAD_REQUEST",
			message: reason
				? `Invalid path: ${reason}`
				: "Invalid path: file must be inside the Traefik configuration directory",
		});
		this.name = "TraefikPathError";
	}
}

export const invalidTraefikPath = (reason?: string) =>
	new TraefikPathError(reason);

export const isInsideDirectory = (
	pathApi: typeof path.posix,
	directory: string,
	target: string,
) => {
	const prefix = directory.endsWith(pathApi.sep)
		? directory
		: `${directory}${pathApi.sep}`;
	return target.startsWith(prefix);
};

/**
 * `fs.realpath` for a path that may not exist yet (a write that creates the
 * file): the nearest existing parent is resolved and the missing tail is
 * joined back. A dangling symlink is rejected, because writing to it would
 * create its target wherever it points.
 */
export const realpathAllowingMissingSync = (target: string): string => {
	try {
		return fs.realpathSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw invalidTraefikPath("the file path could not be resolved");
		}
	}
	if (fs.lstatSync(target, { throwIfNoEntry: false })) {
		throw invalidTraefikPath();
	}
	const parent = path.dirname(target);
	if (parent === target) {
		throw invalidTraefikPath("the file path could not be resolved");
	}
	return path.join(realpathAllowingMissingSync(parent), path.basename(target));
};

/**
 * A file name that is exactly one path component. The names used here are
 * `<appName>.yml` (an app name is limited to letters, digits, `.`, `_` and `-`
 * by the schema and comes from the database row, never from the request),
 * `middlewares.yml` and `traefik.yml`; this is the second line of defence.
 */
export const assertTraefikFileName = (name: string) => {
	if (!name || name === "." || name === ".." || /[/\\\0\r\n]/.test(name)) {
		throw invalidTraefikPath("the file name is not a plain file name");
	}
};

/**
 * The real path of `<dir>/<name>`, after symlinks, for a read or a write.
 * The directory may be missing (a fresh install) and so may the file; both
 * are allowed. The result is inside the real directory, which may itself be
 * a symlink, and the file is not a symlink.
 */
export const resolveConfinedFile = (dir: string, name: string): string => {
	assertTraefikFileName(name);
	const base = path.resolve(dir);
	const target = path.join(base, name);
	const realBase = realpathAllowingMissingSync(base);
	const realTarget = realpathAllowingMissingSync(target);
	if (!isInsideDirectory(path, realBase, realTarget)) {
		throw invalidTraefikPath();
	}
	if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw invalidTraefikPath("the file is a symbolic link");
	}
	return realTarget;
};

// O_NOFOLLOW makes the open fail on a symlink at the last component, so a link
// planted between the check and the open is not followed. It does not exist on
// Windows, where Dokploy only runs for development.
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

// Opens the already resolved path without following a link at the last
// component (a numeric flag, so not through readFileSync/writeFileSync's string
// flags), and maps ELOOP to the same refusal as the check.
const withOpenFile = <T>(
	realPath: string,
	flags: number,
	use: (fd: number) => T,
): T => {
	let fd: number;
	try {
		fd = fs.openSync(realPath, flags | NOFOLLOW, 0o666);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") {
			throw invalidTraefikPath("the file is a symbolic link");
		}
		throw error;
	}
	try {
		return use(fd);
	} finally {
		fs.closeSync(fd);
	}
};

/** The file's text, or null when it does not exist. */
export const readConfinedFile = (dir: string, name: string): string | null => {
	const realPath = resolveConfinedFile(dir, name);
	try {
		return withOpenFile(realPath, fs.constants.O_RDONLY, (fd) =>
			fs.readFileSync(fd, "utf8"),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
};

/**
 * Writes in place, creating the file when it is missing. In place, not a
 * temp file and a rename, because `traefik.yml` is bind-mounted as a single
 * file into the Traefik container: a rename would leave the running container
 * on the old inode. The open uses O_NOFOLLOW on the already resolved real
 * path, so a symlink planted after the check is refused, not followed.
 */
export const writeConfinedFile = (
	dir: string,
	name: string,
	content: string,
): void => {
	const realPath = resolveConfinedFile(dir, name);
	withOpenFile(
		realPath,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
		(fd) => fs.writeFileSync(fd, content, "utf8"),
	);
};

/** Exit codes of the remote commands below. */
export const REMOTE_ABSENT = 96;
export const REMOTE_REFUSED = 97;
export const REMOTE_WRITE_FAILED = 95;

const remoteVars = (dir: string, name: string) =>
	[`d=${quote([dir])}`, `n=${quote([name])}`, 't="$d/$n"'].join("\n");

// Resolves `$t` (`<dir>/<name>`) on the remote host and refuses (exit 97) when
// the resolved path leaves the resolved directory or the file is a symlink.
// GNU `realpath -m` resolves every existing component and tolerates missing
// ones; BusyBox and BSD realpath have no `-m` but tolerate a missing last
// component, which is the "file does not exist yet" write.
const remoteChecks = [
	'if realpath -m / >/dev/null 2>&1; then rp() { realpath -m "$1"; }; else rp() { realpath "$1"; }; fi',
	`rd=$(rp "$d") || exit ${REMOTE_REFUSED}`,
	`rt=$(rp "$t") || exit ${REMOTE_REFUSED}`,
	`case "$rt" in "$rd"/*) ;; *) exit ${REMOTE_REFUSED} ;; esac`,
	`if [ -L "$t" ]; then exit ${REMOTE_REFUSED}; fi`,
].join("\n");

const inSh = (script: string) => `sh -c ${shSingleQuote(script)}`;

/**
 * Prints `<dir>/<name>` from a remote host after the same checks as the local
 * helpers, all inside one command so nothing can change between the check and
 * the read. Exit 96: the file does not exist. Exit 97: refused.
 */
export const remoteConfinedReadCommand = (dir: string, name: string) => {
	assertTraefikFileName(name);
	return inSh(
		[
			remoteVars(dir, name),
			`if [ ! -e "$t" ] && [ ! -L "$t" ]; then exit ${REMOTE_ABSENT}; fi`,
			remoteChecks,
			'cat -- "$rt"',
		].join("\n"),
	);
};

/**
 * Writes the text on stdin to `<dir>/<name>` on a remote host after the same
 * checks, in one command. It is written to a temp file in the same directory
 * and renamed over the target: rename replaces a symlink planted after the
 * check instead of following it. (Only for files in the dynamic directory;
 * `traefik.yml` is bind-mounted as a single file and must keep its inode.)
 * The temp name has no `.yml` suffix, so Traefik's file provider ignores it.
 */
export const remoteConfinedWriteCommand = (dir: string, name: string) => {
	assertTraefikFileName(name);
	return inSh(
		[
			remoteVars(dir, name),
			remoteChecks,
			`if [ -d "$rt" ]; then exit ${REMOTE_REFUSED}; fi`,
			`tmp=$(mktemp "$(dirname "$rt")/.traefik-write.XXXXXX") || exit ${REMOTE_WRITE_FAILED}`,
			"trap 'rm -f \"$tmp\"' EXIT",
			`cat > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$rt" || exit ${REMOTE_WRITE_FAILED}`,
		].join("\n"),
	);
};

/** A failed remote command as a refusal, or null when it failed otherwise. */
export const asRemoteRefusal = (error: unknown): TraefikPathError | null => {
	const { name, exitCode } = (error ?? {}) as {
		name?: string;
		exitCode?: unknown;
	};
	if (name === "ExecError" && exitCode === REMOTE_REFUSED) {
		return invalidTraefikPath(
			"the file is a symbolic link or resolves outside the Traefik configuration directory",
		);
	}
	return null;
};

/** True for the error a confinement check throws; callers that swallow I/O errors rethrow it. */
export const isTraefikPathError = (error: unknown): error is TraefikPathError =>
	error instanceof TraefikPathError;
