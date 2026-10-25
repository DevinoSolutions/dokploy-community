import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { paths } from "@dokploy/server/constants";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import {
	DIRECTORY_INSIDE_FUNCTION,
	getAtomicPutFunction,
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
 * The same rule covers the other files Dokploy reads itself (T-8413): the
 * `-f` override files of a custom command (the volume check and the
 * restricted-compose audit) and the `.env` of the project directory (the
 * volume check). For these, the files directory of the compose
 * (`<compose path>/<appName>/files`, where Dokploy writes the file mounts, and
 * which a command reaches as `../files/...`) is a second allowed place next to
 * the code directory; a link that leaves both is still refused. They are also
 * read only when they are regular files, so a FIFO or a device put in the
 * checkout can neither block the deploy nor stream. The volume check, which
 * runs on every deploy and cannot be turned off, refuses `include:` and
 * `extends: file:`, so the deploy stops before Docker Compose reads such a
 * file. What is not covered: the files Docker Compose opens on its own and
 * Dokploy never parses (`env_file:`, `label_file:`, the `file:` of `secrets:`
 * and `configs:`, bind mount sources). Judging them takes Compose's own path
 * resolution (variables, `--project-directory`, `include` merging) on every
 * host a deploy can run on, and the same links reach them through a bind
 * mount; a clone-wide check of links is a feature of its own, so they stay as
 * they are. Two more gaps remain, as no check of a path can close them: a hard
 * link to a file outside the directory is an ordinary file there (making one
 * takes the same filesystem and write access to the target), and a link
 * swapped in between the check and the read (only a writer inside the
 * checkout, such as a container that has it mounted, can do that) is not
 * seen.
 *
 * Every shell command quotes the paths it is given.
 */
export const COMPOSE_FILE_LINK_MESSAGE =
	"The compose file is, or goes through, a symbolic link that leaves the repository; Dokploy only deploys a regular file inside the repository.";

/** The file is not reached through a link, but it is in no directory that may be read. */
export const COMPOSE_FILE_OUTSIDE_MESSAGE =
	"The file is outside the allowed directories (the repository and the files directory of the compose); Dokploy only reads a regular file inside them.";

/** The file is a FIFO, a device, a directory, ... */
export const COMPOSE_FILE_NOT_REGULAR_MESSAGE =
	"The file is not a regular file; Dokploy only reads regular files.";

/** Shown when the host's `mv` cannot replace a file by renaming over it. */
export const MV_REFUSAL_MESSAGE =
	"Could not replace the compose file atomically (mv -T is required on this host).";

/**
 * Defines `__dokploy_put SOURCE DESTINATION CODE_DIRECTORY`, which every
 * write of the compose file and its `.env` goes through (see
 * `getAtomicPutFunction`).
 */
export const ATOMIC_PUT_FUNCTION = getAtomicPutFunction(
	`❌ Compose refused: ${COMPOSE_FILE_LINK_MESSAGE}`,
	`❌ ${MV_REFUSAL_MESSAGE}`,
);

/** The checkout the compose file is read from and written to. */
export const getComposeCodeDirectory = (compose: {
	appName: string;
	serverId?: string | null;
}) => join(paths(!!compose.serverId).COMPOSE_PATH, compose.appName, "code");

/**
 * The directory of the compose's file mounts, next to the checkout. Override
 * files and the project `.env` may also be read from it (T-8413).
 */
export const getComposeFilesDirectory = (compose: {
	appName: string;
	serverId?: string | null;
}) => join(paths(!!compose.serverId).COMPOSE_PATH, compose.appName, "files");

/** Printed instead of the file by a guarded read that found a link out. */
export const COMPOSE_FILE_LINK_MARKER = "__DOKPLOY_COMPOSE_FILE_LINK__";

/** Printed instead of the file by a guarded read of a file outside the allowed directories. */
export const COMPOSE_FILE_OUTSIDE_MARKER = "__DOKPLOY_COMPOSE_FILE_OUTSIDE__";

/** Printed by a guarded read of something that is not a regular file. */
export const COMPOSE_FILE_NOT_REGULAR_MARKER =
	"__DOKPLOY_COMPOSE_FILE_NOT_REGULAR__";

export class ComposeFileLinkError extends TRPCError {
	constructor(reason: string = COMPOSE_FILE_LINK_MESSAGE) {
		super({
			code: "BAD_REQUEST",
			message: `Compose refused: ${reason}`,
		});
		this.name = "ComposeFileLinkError";
	}
}

export const isComposeFileLinkError = (
	error: unknown,
): error is ComposeFileLinkError => error instanceof ComposeFileLinkError;

/**
 * For a file on this machine: the reason it may not be read, or `null`. A
 * file that is not there is fine (the read reports that itself). The file has
 * to resolve inside `codeDirectory` or, when given, `extraDirectory`; a
 * directory that is not there contains nothing, so an existing file is
 * refused when neither exists (the shell guard does the same).
 */
export const getComposeFileLinkError = (
	codeDirectory: string,
	file: string,
	extraDirectory?: string,
): string | null => {
	// A path of the local filesystem, in one form to compare.
	const normal = (value: string) =>
		process.platform === "win32" ? value.replaceAll("\\", "/") : value;
	// Without a drive letter, which only a Windows dev machine has.
	const bare = (value: string) => normal(value).replace(/^[A-Za-z]:/, "");
	let resolved: string;
	try {
		resolved = normal(realpathSync(file));
	} catch (error) {
		const code = (error as { code?: string } | null)?.code;
		return code === "ENOENT" || code === "ENOTDIR"
			? null
			: COMPOSE_FILE_LINK_MESSAGE;
	}
	for (const directory of [codeDirectory, extraDirectory]) {
		if (!directory) continue;
		try {
			const root = normal(realpathSync(directory)).replace(/\/+$/, "");
			if (resolved === root || resolved.startsWith(`${root}/`)) return null;
		} catch {
			// Not there, or not readable: the file cannot be inside it.
		}
	}
	// Inside neither. A link on the way is what led out when the resolved path
	// differs from the one given.
	return bare(resolved) === bare(resolve(file))
		? COMPOSE_FILE_OUTSIDE_MESSAGE
		: COMPOSE_FILE_LINK_MESSAGE;
};

/** Throws when `file` on this machine resolves outside the allowed directories. */
export const assertComposeFileInsideCodeDirectory = (
	codeDirectory: string,
	file: string,
	extraDirectory?: string,
) => {
	const reason = getComposeFileLinkError(codeDirectory, file, extraDirectory);
	if (reason) throw new ComposeFileLinkError(reason);
};

/**
 * Shell command that runs `read` (a command that prints the file) only when
 * `file` resolves inside `codeDirectory` or `extraDirectory` (each has to
 * exist); otherwise it prints `COMPOSE_FILE_LINK_MARKER` (a link leads out) or
 * `COMPOSE_FILE_OUTSIDE_MARKER` and exits 0. A file that is not there is let
 * through, so the read fails the way it always did. A host that cannot resolve
 * links counts as a link.
 */
export const getGuardedReadCommand = ({
	codeDirectory,
	extraDirectory,
	file,
	read,
}: {
	codeDirectory: string;
	extraDirectory?: string;
	file: string;
	read: string;
}) => {
	const qFile = quote([file]);
	const inside = [codeDirectory, extraDirectory]
		.filter((directory): directory is string => !!directory)
		.map((directory) => `__dokploy_inside ${quote([directory])} ${qFile}`)
		.join(" || ");
	return [
		...getPathResolverLines("__dokploy_resolve() { return 1; }"),
		// The files given are absolute and clean, so a path that resolves to
		// itself has no link on the way: it is just somewhere else.
		`if ${inside} || [ ! -e ${qFile} ]; then ${read}; else __dokploy_r=$(__dokploy_resolve ${qFile}); if [ -n "$__dokploy_r" ] && [ "$__dokploy_r" = ${qFile} ]; then printf '%s' ${COMPOSE_FILE_OUTSIDE_MARKER}; else printf '%s' ${COMPOSE_FILE_LINK_MARKER}; fi; fi`,
	].join("\n");
};

/** Whether the output of a guarded read is one of the refusal markers. */
export const isComposeFileLinkMarker = (output: string) => {
	const text = output.trim();
	return (
		text === COMPOSE_FILE_LINK_MARKER ||
		text === COMPOSE_FILE_OUTSIDE_MARKER ||
		text === COMPOSE_FILE_NOT_REGULAR_MARKER
	);
};

/** The refusal for an output that `isComposeFileLinkMarker` accepted. */
export const getComposeFileRefusal = (output: string) => {
	const text = output.trim();
	return new ComposeFileLinkError(
		text === COMPOSE_FILE_OUTSIDE_MARKER
			? COMPOSE_FILE_OUTSIDE_MESSAGE
			: text === COMPOSE_FILE_NOT_REGULAR_MARKER
				? COMPOSE_FILE_NOT_REGULAR_MESSAGE
				: COMPOSE_FILE_LINK_MESSAGE,
	);
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
