import { posix } from "node:path";

/**
 * Reading `template.toml` from the fresh clone `compose.loadTemplateFromGit`
 * makes (T-8413). The repository is not trusted: a file in it can be a
 * symbolic link, and a plain `cat` follows it to a file of the host that
 * clones. The read goes through a small script run on the host that holds the
 * clone (this server, or the compose's remote server) which refuses the file
 * when it, or a directory between the clone root and it, is a symbolic link,
 * when its real location is outside the clone root, or when it is too large.
 *
 * A link that stays inside the repository is refused too: only regular files
 * are read, which keeps the rule one line long.
 */

export const TEMPLATE_FILE_MAX_BYTES = 1024 * 1024;

export const TEMPLATE_LINK_REFUSED_MESSAGE =
	"The template repository contains a symbolic link where a file was expected; only regular files inside the repository are read.";

export const TEMPLATE_TOO_LARGE_MESSAGE =
	"The template file in the repository is larger than the 1 MB limit.";

export const TEMPLATE_URL_REFUSED_MESSAGE =
	"The template repository URL must be an http(s) URL, an ssh:// URL or an SSH address such as git@host:owner/repo.git.";

// Exit statuses of the script below; any other failure means "no template here".
export const TEMPLATE_EXIT_REFUSED = 40;
export const TEMPLATE_EXIT_TOO_LARGE = 41;

const SCRIPT = [
	'root="$1"; rel="$2"; max="$3";',
	'if [ -L "$root" ] || [ ! -d "$root" ]; then exit 42; fi;',
	'realroot=$(cd -P -- "$root" 2>/dev/null && pwd -P) || exit 42;',
	'cur="$root"; oldifs=$IFS; set -f; IFS=/; set -- $rel; IFS=$oldifs; set +f;',
	'for part in "$@"; do',
	'case "$part" in "" | .) continue;; ..) exit 40;; esac;',
	'cur="$cur/$part";',
	'if [ -L "$cur" ]; then exit 40; fi;',
	"done;",
	'if [ ! -e "$cur" ] || [ ! -f "$cur" ]; then exit 42; fi;',
	'dir=$(cd -P -- "$(dirname -- "$cur")" 2>/dev/null && pwd -P) || exit 42;',
	'case "$dir" in "$realroot" | "$realroot"/*) ;; *) exit 40;; esac;',
	'size=$(wc -c < "$cur" | tr -d " ") || exit 42;',
	'if [ "$size" -gt "$max" ]; then exit 41; fi;',
	'cat -- "$cur"',
].join("\n");

const shQuote = (value: string) => `'${value.split("'").join(`'\\''`)}'`;

/**
 * The command that prints `relativePath` (inside the clone at `root`) when it
 * is a regular file, reached without a symbolic link.
 */
export const buildGuardedTemplateReadCommand = (
	root: string,
	relativePath: string,
	maxBytes = TEMPLATE_FILE_MAX_BYTES,
) =>
	`sh -c ${shQuote(SCRIPT)} sh ${shQuote(root)} ${shQuote(
		posix.normalize(relativePath.split("\\").join("/")),
	)} ${shQuote(String(maxBytes))}`;

export class TemplateFileRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TemplateFileRefusedError";
	}
}

/** The refusal a failed guarded read stands for, or `null` for "no template". */
export const getTemplateReadRefusal = (
	error: unknown,
): TemplateFileRefusedError | null => {
	const exitCode = (error as { exitCode?: unknown } | null)?.exitCode;
	if (exitCode === TEMPLATE_EXIT_REFUSED) {
		return new TemplateFileRefusedError(TEMPLATE_LINK_REFUSED_MESSAGE);
	}
	if (exitCode === TEMPLATE_EXIT_TOO_LARGE) {
		return new TemplateFileRefusedError(TEMPLATE_TOO_LARGE_MESSAGE);
	}
	return null;
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: refused on purpose
const UNSAFE_URL_CHARACTER = /[\u0000-\u0020\u007f\\]/;
const HTTP_URL = /^https?:\/\/[A-Za-z0-9[]/i;
const SSH_URL = /^ssh:\/\/[A-Za-z0-9[]/i;
const SCP_ADDRESS = /^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:/;

/**
 * Only a remote repository is cloned: http(s), `ssh://` or an SSH address
 * (`git@host:owner/repo.git`). A `file://` URL, a local path, a transport
 * helper (`ext::`, `fd::`) or a value git would read as an option is refused.
 */
export const assertSafeTemplateGitUrl = (url: string | null | undefined) => {
	const value = url ?? "";
	if (
		!value ||
		UNSAFE_URL_CHARACTER.test(value) ||
		value.includes("::") ||
		!(HTTP_URL.test(value) || SSH_URL.test(value) || SCP_ADDRESS.test(value))
	) {
		throw new TemplateFileRefusedError(TEMPLATE_URL_REFUSED_MESSAGE);
	}
};

/**
 * Put before the clone: files of the clone are created owner-only, and git is
 * limited to remote protocols, submodules included.
 */
export const TEMPLATE_CLONE_ENV =
	"umask 077; export GIT_ALLOW_PROTOCOL=https:http:ssh;";
