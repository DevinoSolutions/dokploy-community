import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import {
	DIRECTORY_INSIDE_FUNCTION,
	getPathResolverLines,
} from "./path-containment";

/**
 * The compose file, and the `.env` Dokploy writes next to it, live in the
 * repository's checkout, and the checkout is the repository's: it can make
 * either of them, or a directory on their path, a symbolic link (T-7857).
 * Reading or writing through such a link would reach a file that is not part
 * of the compose. So:
 *
 * - a read follows a link only when the file it leads to is inside the code
 *   directory (`getComposeFileLinkError`, `getGuardedReadCommand`);
 * - a write is refused when the directory of the file resolves outside the
 *   code directory (`getComposeFileWriteGuardCommand`), and a link in the
 *   place of the file itself is replaced by a regular file before it is
 *   written (`getReplaceLinkCommand`), the way the `.env` has been since
 *   T-7135. A repository that keeps its compose file as a link to another file
 *   of the repository therefore keeps deploying.
 *
 * Every shell command quotes the paths it is given.
 */
export const COMPOSE_FILE_LINK_MESSAGE =
	"The compose file is, or goes through, a symbolic link that leaves the repository; Dokploy only deploys a regular file inside the repository.";

/** The checkout the compose file is read from and written to. */
export const getComposeCodeDirectory = (compose: {
	appName: string;
	serverId?: string | null;
}) => join(paths(!!compose.serverId).COMPOSE_PATH, compose.appName, "code");

/** Printed instead of the file by a guarded read that found a link out. */
export const COMPOSE_FILE_LINK_MARKER = "__DOKPLOY_COMPOSE_FILE_LINK__";

export class ComposeFileLinkError extends TRPCError {
	constructor() {
		super({
			code: "BAD_REQUEST",
			message: `Compose refused: ${COMPOSE_FILE_LINK_MESSAGE}`,
		});
		this.name = "ComposeFileLinkError";
	}
}

export const isComposeFileLinkError = (
	error: unknown,
): error is ComposeFileLinkError => error instanceof ComposeFileLinkError;

/**
 * For a file on this machine: the reason it may not be read, or `null`. A
 * file that is not there is fine (the read reports that itself).
 */
export const getComposeFileLinkError = (
	codeDirectory: string,
	file: string,
): string | null => {
	// A path of the local filesystem, in one form to compare.
	const normal = (value: string) =>
		process.platform === "win32" ? value.replaceAll("\\", "/") : value;
	try {
		const root = normal(realpathSync(codeDirectory)).replace(/\/+$/, "");
		const resolved = normal(realpathSync(file));
		return resolved === root || resolved.startsWith(`${root}/`)
			? null
			: COMPOSE_FILE_LINK_MESSAGE;
	} catch (error) {
		const code = (error as { code?: string } | null)?.code;
		return code === "ENOENT" || code === "ENOTDIR"
			? null
			: COMPOSE_FILE_LINK_MESSAGE;
	}
};

/** Throws when `file` on this machine resolves outside `codeDirectory`. */
export const assertComposeFileInsideCodeDirectory = (
	codeDirectory: string,
	file: string,
) => {
	if (getComposeFileLinkError(codeDirectory, file)) {
		throw new ComposeFileLinkError();
	}
};

/**
 * Shell command that runs `read` (a command that prints the file) only when
 * `file` resolves inside `codeDirectory`; otherwise it prints
 * `COMPOSE_FILE_LINK_MARKER` and exits 0. A file that is not there is let
 * through, so the read fails the way it always did. A host that cannot resolve
 * links counts as a link.
 */
export const getGuardedReadCommand = ({
	codeDirectory,
	file,
	read,
}: {
	codeDirectory: string;
	file: string;
	read: string;
}) => {
	const qFile = quote([file]);
	return [
		...getPathResolverLines("__dokploy_resolve() { return 1; }"),
		`if __dokploy_inside ${quote([codeDirectory])} ${qFile} || [ ! -e ${qFile} ]; then ${read}; else printf '%s' ${COMPOSE_FILE_LINK_MARKER}; fi`,
	].join("\n");
};

/** Whether the output of a guarded read is the marker (a link out). */
export const isComposeFileLinkMarker = (output: string) =>
	output.trim() === COMPOSE_FILE_LINK_MARKER;

/**
 * Shell lines for a script that is about to write `file` (the compose file or
 * its `.env`): the directory it is in has to resolve inside `codeDirectory`.
 * A code directory or a directory that is not there is let through: the write
 * fails as it always did. `cleanup` runs before the refusal stops the script
 * (the staged files).
 */
export const getComposeFileWriteGuardCommand = ({
	codeDirectory,
	file,
	cleanup = "",
}: {
	codeDirectory: string;
	file: string;
	cleanup?: string;
}) => {
	const qCode = quote([codeDirectory]);
	const qDirectory = quote([dirname(file)]);
	return `
${DIRECTORY_INSIDE_FUNCTION}
[ ! -d ${qCode} ] || [ ! -d ${qDirectory} ] || __dokploy_dir_inside ${qCode} ${qDirectory} || { ${cleanup ? `${cleanup} ` : ""}echo ${quote([`❌ Compose refused: ${COMPOSE_FILE_LINK_MESSAGE}`])} >&2; exit 1; }
`;
};

/**
 * Shell command that removes `file` when it is a symbolic link, so the write
 * that follows makes a regular file instead of going through the link.
 */
export const getReplaceLinkCommand = (file: string) => {
	const qFile = quote([file]);
	return `if [ -L ${qFile} ]; then rm -f ${qFile}; fi`;
};

/**
 * For the restore: shell that tells whether `file` may be written (its
 * directory resolves inside `codeDirectory`). Sets `__dokploy_write_ok` to 1
 * or 0 instead of stopping, as a restore carries on without the files it could
 * not put back.
 */
export const getRestoreWriteCheckCommand = ({
	codeDirectory,
	file,
}: {
	codeDirectory: string;
	file: string;
}) => {
	const qCode = quote([codeDirectory]);
	const qDirectory = quote([dirname(file)]);
	return `${DIRECTORY_INSIDE_FUNCTION}
if [ ! -d ${qCode} ] || [ ! -d ${qDirectory} ] || __dokploy_dir_inside ${qCode} ${qDirectory}; then __dokploy_write_ok=1; else __dokploy_write_ok=0; fi`;
};
