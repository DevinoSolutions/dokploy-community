import fs from "node:fs";
import path from "node:path";
import { paths } from "@dokploy/server/constants";
import { shSingleQuote } from "@dokploy/server/utils/builders/remote-build-cancel";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";

/**
 * Confinement of Traefik configuration files to the Traefik directory.
 *
 * The files Dokploy reads and writes for Traefik (`<dynamic>/<appName>.yml`,
 * `<dynamic>/middlewares.yml`, `traefik.yml`, and the files of the Traefik
 * files editor) are opened as the Dokploy process, which is root on the host,
 * and as the SSH user on a remote server. Anything able to plant a symlink in
 * that directory (a bind mount of it, an older release, a compose bind) would
 * otherwise turn the read and write routes into an arbitrary file read and
 * write.
 *
 * A file is a `{ root, target }` pair: `root` is the Traefik base directory
 * (`MAIN_TRAEFIK_PATH`), `target` the file. The real path of `target`, after
 * symlinks, must stay inside the real path of `root` (which may itself be a
 * link), `target` must not be a symlink, and the file is then opened without
 * following a link at its last component, with the opened descriptor checked
 * against the resolved path, so a swap after the check is refused rather than
 * followed. A `dynamic` directory that is a link leaving the Traefik tree is
 * refused, like in the Traefik files editor. Missing files and directories
 * (a fresh install) are allowed.
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

const linkReason = (target: string) =>
	`${path.basename(target)} is a symbolic link or leads outside the Traefik configuration directory, and Dokploy does not follow links there. Replace it with a regular file`;

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
		throw invalidTraefikPath(linkReason(target));
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

export type TraefikFile = { root: string; target: string };

/** `<dynamic>/<name>`, confined to the Traefik base directory. */
export const dynamicTraefikFile = (
	name: string,
	isServer = false,
): TraefikFile => {
	assertTraefikFileName(name);
	const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths(isServer);
	const api = isServer ? path.posix : path;
	return {
		root: MAIN_TRAEFIK_PATH,
		target: api.join(DYNAMIC_TRAEFIK_PATH, name),
	};
};

/** `<traefik base>/<name>`, for `traefik.yml`. */
export const mainTraefikFile = (name: string, isServer = false): TraefikFile => {
	assertTraefikFileName(name);
	const { MAIN_TRAEFIK_PATH } = paths(isServer);
	const api = isServer ? path.posix : path;
	return { root: MAIN_TRAEFIK_PATH, target: api.join(MAIN_TRAEFIK_PATH, name) };
};

/** A file the Traefik files editor names by path (already an absolute path). */
export const editorTraefikFile = (
	target: string,
	isServer = false,
): TraefikFile => ({ root: paths(isServer).MAIN_TRAEFIK_PATH, target });

/**
 * The real root and the real path of the file, after symlinks, for a read or a
 * write. The file may be missing, and so may its directory.
 */
export const resolveConfinedFile = ({ root, target }: TraefikFile) => {
	const realRoot = realpathAllowingMissingSync(path.resolve(root));
	const realTarget = realpathAllowingMissingSync(path.resolve(target));
	if (
		!isInsideDirectory(path, realRoot, realTarget) ||
		fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()
	) {
		throw invalidTraefikPath(linkReason(target));
	}
	return { realRoot, realTarget };
};

// O_NOFOLLOW makes the open fail on a symlink at the last component, so a link
// planted between the check and the open is not followed. It does not exist on
// Windows, where Dokploy only runs for development.
const noFollow = () => fs.constants.O_NOFOLLOW ?? 0;

// On Linux the kernel says what an open descriptor really is. A directory of
// the path swapped for a link after the check (which O_NOFOLLOW does not cover)
// shows up here, before anything is read or written.
const assertDescriptorInside = (
	fd: number,
	realRoot: string,
	realTarget: string,
	target: string,
) => {
	if (process.platform !== "linux" || !fs.existsSync("/proc/self/fd")) {
		return;
	}
	let actual: string;
	try {
		actual = fs.realpathSync(`/proc/self/fd/${fd}`);
	} catch {
		throw invalidTraefikPath("the file path could not be resolved");
	}
	if (actual !== realTarget || !isInsideDirectory(path, realRoot, actual)) {
		throw invalidTraefikPath(linkReason(target));
	}
};

const withOpenFile = <T>(
	file: TraefikFile,
	flags: number,
	use: (fd: number) => T,
): T => {
	const { realRoot, realTarget } = resolveConfinedFile(file);
	let fd: number;
	try {
		fd = fs.openSync(realTarget, flags | noFollow(), 0o666);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") {
			throw invalidTraefikPath(linkReason(file.target));
		}
		throw error;
	}
	try {
		assertDescriptorInside(fd, realRoot, realTarget, file.target);
		return use(fd);
	} finally {
		fs.closeSync(fd);
	}
};

/** The file's text, or null when it does not exist. */
export const readConfinedFile = (file: TraefikFile): string | null => {
	try {
		return withOpenFile(file, fs.constants.O_RDONLY, (fd) =>
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
 * on the old inode. The file is opened without O_TRUNC and truncated only
 * after the descriptor has been checked, so a refused open destroys nothing.
 */
export const writeConfinedFile = (file: TraefikFile, content: string): void => {
	withOpenFile(file, fs.constants.O_WRONLY | fs.constants.O_CREAT, (fd) => {
		fs.ftruncateSync(fd, 0);
		fs.writeFileSync(fd, content, "utf8");
	});
};

/** Exit codes of the remote commands below. */
export const REMOTE_ABSENT = 96;
export const REMOTE_REFUSED = 97;
export const REMOTE_WRITE_FAILED = 95;

const remoteVars = ({ root, target }: TraefikFile) =>
	[`d=${quote([root])}`, `t=${quote([target])}`].join("\n");

// Resolves `$t` on the remote host and refuses (exit 97) when the resolved path
// leaves the resolved root or the file is a symlink. GNU `realpath -m`
// resolves every existing component and tolerates missing ones; BusyBox and BSD
// realpath have no `-m` but tolerate a missing last component, which is the
// "file does not exist yet" write.
const remoteChecks = [
	'if realpath -m / >/dev/null 2>&1; then rp() { realpath -m "$1"; }; else rp() { realpath "$1"; }; fi',
	`rd=$(rp "$d") || exit ${REMOTE_REFUSED}`,
	`rt=$(rp "$t") || exit ${REMOTE_REFUSED}`,
	`case "$rt" in "$rd"/*) ;; *) exit ${REMOTE_REFUSED} ;; esac`,
	`if [ -L "$t" ]; then exit ${REMOTE_REFUSED}; fi`,
].join("\n");

const inSh = (script: string) => `sh -c ${shSingleQuote(script)}`;

/**
 * Prints the file from a remote host after the same checks as the local
 * helpers, all inside one command. The file is opened once, on descriptor 3,
 * and the kernel is asked what that descriptor is (`/proc/$$/fd/3`): a link
 * swapped in after the checks makes the two differ and the command refuses,
 * instead of printing what the link points to. Exit 96: the file does not
 * exist. Exit 97: refused.
 */
export const remoteConfinedReadCommand = (file: TraefikFile) =>
	inSh(
		[
			remoteVars(file),
			`if [ ! -e "$t" ] && [ ! -L "$t" ]; then exit ${REMOTE_ABSENT}; fi`,
			remoteChecks,
			`exec 3< "$rt" || exit ${REMOTE_REFUSED}`,
			`[ "$(readlink -f /proc/$$/fd/3)" = "$rt" ] || exit ${REMOTE_REFUSED}`,
			"cat <&3",
		].join("\n"),
	);

/**
 * Writes the text on stdin to the file on a remote host after the same checks,
 * in one command, in place (same inode, mode and owner, which `traefik.yml`
 * needs: it is bind-mounted as a single file into the Traefik container). A
 * missing file is created with an exclusive create (`set -C`), which never
 * follows a link. The existing file is then opened read-only on descriptor 3,
 * the kernel is asked what that descriptor is (`/proc/$$/fd/3`), and only if
 * it is the checked path is the file truncated and written, through the
 * descriptor's own `/proc` entry. A link (to a file or to a directory)
 * swapped in after the checks changes what the descriptor is, so nothing is
 * written and nothing is created through it. Exit 95: the open or write failed.
 */
export const remoteConfinedWriteCommand = (file: TraefikFile) =>
	inSh(
		[
			remoteVars(file),
			remoteChecks,
			`if [ -d "$rt" ]; then exit ${REMOTE_REFUSED}; fi`,
			'if [ ! -e "$rt" ]; then ( set -C; : > "$rt" ) 2>/dev/null; fi',
			`[ -r "$rt" ] || exit ${REMOTE_WRITE_FAILED}`,
			`exec 3< "$rt" || exit ${REMOTE_WRITE_FAILED}`,
			`[ "$(readlink -f /proc/$$/fd/3)" = "$rt" ] || exit ${REMOTE_REFUSED}`,
			`cat > /proc/$$/fd/3 || exit ${REMOTE_WRITE_FAILED}`,
		].join("\n"),
	);

/** A failed remote command as a refusal, or null when it failed otherwise. */
export const asRemoteRefusal = (
	error: unknown,
	target: string,
): TraefikPathError | null => {
	const { name, exitCode } = (error ?? {}) as {
		name?: string;
		exitCode?: unknown;
	};
	if (name === "ExecError" && exitCode === REMOTE_REFUSED) {
		return invalidTraefikPath(linkReason(target));
	}
	return null;
};

/** True for the error a confinement check throws; callers that swallow I/O errors rethrow it. */
export const isTraefikPathError = (error: unknown): error is TraefikPathError =>
	error instanceof TraefikPathError;
